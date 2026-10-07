import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

const execFileAsync = promisify(execFile);
const EDUCA_OAI = 'https://educa.fcc.org.br/oai/scielo-oai.php';
const EDUCA_BASE = 'https://educa.fcc.org.br';
const MAX_SOURCE_FAILURES = 3;
const root = resolve('.');
const summaryPath = resolve(root, 'app/journals.json');
const databaseDir = resolve(root, 'data');
const databasePath = resolve(databaseDir, 'atlas-educa.sqlite');
const cacheDir = resolve(root, '.cache/oai-audit');
const detailDir = resolve(root, 'public/data/journals');
const officialDir = resolve(root, 'public/data/official');
const comparisonDir = resolve(root, 'public/data/comparisons');
const processingStatusPath = resolve(root, 'public/data/processing-status.json');
const schemaPath = resolve(root, 'db/schema.sql');
const requestedLimit = Number(process.argv.find((item) => item.startsWith('--limit='))?.split('=')[1] ?? 0);
const requestedId = process.argv.find((item) => item.startsWith('--journal='))?.split('=')[1] ?? null;
const educaIpOverride = process.argv.find((item) => item.startsWith('--educa-ip='))?.split('=')[1] ?? null;
const usePartialEduca = process.argv.includes('--use-partial-educa');
const usePartialOfficial = process.argv.includes('--use-partial-official');
const recoverEducaIssues = process.argv.includes('--recover-educa-issues');
const recompareExisting = process.argv.includes('--recompare-existing');

mkdirSync(databaseDir, { recursive: true });
mkdirSync(cacheDir, { recursive: true });
mkdirSync(detailDir, { recursive: true });
mkdirSync(officialDir, { recursive: true });
mkdirSync(comparisonDir, { recursive: true });

const db = new DatabaseSync(databasePath);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 30000;');
db.exec(readFileSync(schemaPath, 'utf8'));

let summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
let currentProgress = null;

function isIndependentOfficialOai(journal) {
  if (!journal.officialOaiUrl) return false;
  try { return !/(?:^|\.)educa\.fcc\.org\.br/i.test(new URL(journal.officialOaiUrl).hostname); }
  catch { return false; }
}

function writeProcessingStatus(running = true) {
  const databaseRows = new Map(db.prepare(`
    SELECT j.id, j.comparison_status, j.last_error,
      COALESCE(SUM(CASE WHEN c.status='missing_candidate' THEN 1 ELSE 0 END), 0) AS missing_count
    FROM journals j LEFT JOIN comparisons c ON c.journal_id=j.id GROUP BY j.id
  `).all().map((row) => [row.id, row]));
  const journals = summary.journals.map((journal) => {
    const row = databaseRows.get(journal.id);
    let status = 'no_oai';
    if (currentProgress?.journalId === journal.id) status = 'processing';
    else if (row?.comparison_status === 'complete' || journal.comparison?.status === 'complete') status = 'complete';
    else if (row?.comparison_status === 'partial' || journal.comparison?.status === 'partial') status = 'partial';
    else if (row?.last_error) status = 'failed';
    else if (isIndependentOfficialOai(journal)) status = 'queued';
    return {
      id: journal.id, title: journal.title, status,
      phase: currentProgress?.journalId === journal.id ? currentProgress.phase : null,
      source: currentProgress?.journalId === journal.id ? currentProgress.source : null,
      page: currentProgress?.journalId === journal.id ? currentProgress.page : null,
      issueTotal: currentProgress?.journalId === journal.id ? currentProgress.issueTotal ?? null : null,
      records: currentProgress?.journalId === journal.id ? currentProgress.records : null,
      missingCount: ['complete', 'partial'].includes(row?.comparison_status) ? Number(row.missing_count) : journal.comparison?.missingCount ?? null,
      error: row?.last_error ?? null,
    };
  });
  const eligible = journals.filter((journal) => journal.status !== 'no_oai');
  const completed = eligible.filter((journal) => journal.status === 'complete' || journal.status === 'partial').length;
  const payload = {
    updatedAt: new Date().toISOString(), running, totalJournals: journals.length,
    totalEligible: eligible.length, completed, remaining: eligible.length - completed,
    current: currentProgress, journals,
  };
  writeFileSync(processingStatusPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function sleep(ms) { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }

function decodeHtml(value = '') {
  let cleaned = value.replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, '')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/\s+/g, ' ').trim();
  const noise = (text) => (text.match(/[ÃÂâ�\u0080-\u009f]/g) ?? []).length;
  for (let pass = 0; pass < 2 && noise(cleaned); pass += 1) {
    const repaired = Buffer.from(cleaned, 'latin1').toString('utf8');
    if (noise(repaired) < noise(cleaned)) cleaned = repaired;
    else break;
  }
  return cleaned;
}

function values(xml, tag) {
  return [...xml.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi'))]
    .map((match) => decodeHtml(match[1])).filter(Boolean);
}

function entries(xml, tag) {
  return [...xml.matchAll(new RegExp(`<${tag}([^>]*)>([\\s\\S]*?)<\\/${tag}>`, 'gi'))]
    .map((match) => ({ attributes: match[1], value: decodeHtml(match[2]) })).filter((entry) => entry.value);
}

function first(xml, tag) { return values(xml, tag)[0] ?? null; }

function encodeOaiToken(token) {
  return encodeURIComponent(token).replaceAll('%3A', ':');
}

function normalizeTitle(value = '') {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR')
    .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractDoi(inputs) {
  for (const input of inputs.filter(Boolean)) {
    const match = input.match(/(?:doi(?:\.org)?[/:\s]*)?(10\.\d{4,9}\/[^\s<>"]+)/i);
    if (match) return match[1].replace(/[).,;]+$/, '').toLocaleLowerCase('en');
  }
  return null;
}

function diceSimilarity(a, b) {
  const left = normalizeTitle(a); const right = normalizeTitle(b);
  if (left.length < 2 || right.length < 2) return left === right ? 1 : 0;
  const pairs = new Map();
  for (let index = 0; index < left.length - 1; index += 1) {
    const pair = left.slice(index, index + 2);
    pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
  }
  let overlap = 0;
  for (let index = 0; index < right.length - 1; index += 1) {
    const pair = right.slice(index, index + 2);
    const available = pairs.get(pair) ?? 0;
    if (available) { overlap += 1; pairs.set(pair, available - 1); }
  }
  return (2 * overlap) / (left.length + right.length - 2);
}

function authorSimilarity(leftAuthors, rightAuthors) {
  const tokens = (authors) => new Set(authors.flatMap((author) => normalizeTitle(author).split(' ')).filter((token) => token.length > 3));
  const left = tokens(leftAuthors); const right = tokens(rightAuthors);
  if (!left.size || !right.size) return 0;
  return [...left].filter((token) => right.has(token)).length / Math.min(left.size, right.size);
}

async function fetchXml(url, sourceLabel, attempts = 24) {
  let lastError;
  let failureCount = 0;
  const isEducaRequest = new URL(url).hostname === 'educa.fcc.org.br';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const curlArguments = [
        isEducaRequest ? '-sS' : '-LsS', '--max-redirs', '10', '--connect-timeout', isEducaRequest ? '15' : '30',
        '--max-time', isEducaRequest ? '45' : '120',
        '-A', isEducaRequest
          ? 'Mozilla/5.0 Atlas-Educa-Auditoria/2.0'
          : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141 Safari/537.36',
        '-w', '\n__STATUS__:%{http_code}', url,
      ];
      curlArguments.unshift('--ssl-revoke-best-effort');
      if (educaIpOverride && new URL(url).hostname === 'educa.fcc.org.br') {
        curlArguments.unshift('--resolve', `educa.fcc.org.br:443:${educaIpOverride}`);
      }
      const { stdout } = await execFileAsync('curl.exe', curlArguments, { maxBuffer: 80 * 1024 * 1024 });
      const marker = stdout.lastIndexOf('\n__STATUS__:');
      const body = marker >= 0 ? stdout.slice(0, marker) : stdout;
      const status = marker >= 0 ? Number(stdout.slice(marker + 12).trim()) : 0;
      if (status === 200 && /<OAI-PMH[\s>]/i.test(body)) return body;
      if (/XSL Transformation error|Opening and ending tag mismatch/i.test(body)) {
        const permanentError = new Error('O Educ@ retornou XML malformado neste lote; requer coleta alternativa.');
        permanentError.permanent = true;
        throw permanentError;
      }
      if (status >= 300 && status < 400) {
        const permanentError = new Error(`redirecionamento inválido do OAI (HTTP ${status})`);
        permanentError.permanent = true;
        throw permanentError;
      }
      if (status === 429 || status >= 500) {
        failureCount += 1;
        currentProgress = { ...currentProgress, phase: 'retrying_source', retryAttempt: failureCount, httpStatus: status };
        writeProcessingStatus(true);
        if (failureCount >= MAX_SOURCE_FAILURES) {
          const unavailableError = new Error(`${sourceLabel}: fonte indisponível após ${failureCount} tentativas (HTTP ${status}).`);
          unavailableError.permanent = true;
          throw unavailableError;
        }
        console.warn(`${sourceLabel}: fonte ocupada (HTTP ${status}); aguardando antes de tentar novamente.`);
        await sleep(status === 429 ? 60000 : 15000);
        continue;
      }
      throw new Error(`HTTP ${status || 'desconhecido'}`);
    } catch (error) {
      lastError = error;
      if (error.permanent) break;
      failureCount += 1;
      currentProgress = { ...currentProgress, phase: 'retrying_source', retryAttempt: failureCount, httpStatus: null };
      writeProcessingStatus(true);
      if (failureCount >= MAX_SOURCE_FAILURES) {
        lastError = new Error(`${sourceLabel}: fonte indisponível após ${failureCount} tentativas de conexão.`);
        break;
      }
      if (attempt < attempts) await sleep(Math.min(30000, attempt * 3000));
    }
  }
  throw lastError;
}

async function fetchHtml(url, sourceLabel, attempts = 12) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const curlArguments = [
        '-LsS', '--max-redirs', '10', '--connect-timeout', '15', '--max-time', '45',
        '-A', 'Mozilla/5.0 Atlas-Educa-Auditoria/2.0', '-w', '\n__STATUS__:%{http_code}', url,
      ];
      if (educaIpOverride && new URL(url).hostname === 'educa.fcc.org.br') {
        curlArguments.unshift('--ssl-revoke-best-effort', '--resolve', `educa.fcc.org.br:443:${educaIpOverride}`);
      }
      const { stdout } = await execFileAsync('curl.exe', curlArguments, { maxBuffer: 80 * 1024 * 1024 });
      const marker = stdout.lastIndexOf('\n__STATUS__:');
      const body = marker >= 0 ? stdout.slice(0, marker) : stdout;
      const status = marker >= 0 ? Number(stdout.slice(marker + 12).trim()) : 0;
      if (status === 200 && /<html[\s>]/i.test(body)) return body;
      if (status === 429 || status >= 500) {
        currentProgress = { ...currentProgress, phase: 'retrying_source', retryAttempt: attempt, httpStatus: status };
        writeProcessingStatus(true);
        if (attempt < attempts) {
          await sleep(status === 429 ? 30000 : 10000);
          continue;
        }
      }
      throw new Error(`HTTP ${status || 'desconhecido'}`);
    } catch (error) {
      lastError = error;
      currentProgress = { ...currentProgress, phase: 'retrying_source', retryAttempt: attempt, httpStatus: null };
      writeProcessingStatus(true);
      if (attempt < attempts) await sleep(attempt * 5000);
    }
  }
  throw new Error(`${sourceLabel}: página indisponível após ${attempts} tentativas (${lastError?.message ?? 'erro desconhecido'}).`);
}

function textContent(html = '') {
  return decodeHtml(html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '));
}

function parseIssuePids(html) {
  return [...new Set([...html.matchAll(/script=sci_issuetoc(?:&amp;|&)pid=([^&"']+)/gi)]
    .map((match) => decodeHtml(match[1])))];
}

function parseIssueCatalog(html) {
  const catalog = new Map();
  for (const rowMatch of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const row = rowMatch[1];
    const year = Number(textContent(row.match(/<td\b[^>]*>\s*(\d{4})\s*<\/td>/i)?.[1] ?? ''));
    const volume = textContent(row.match(/<th\b[^>]*class="[^"]*table-active[^"]*"[^>]*>([\s\S]*?)<\/th>/i)?.[1] ?? '') || null;
    for (const linkMatch of row.matchAll(/<a\b[^>]*href="[^"]*script=sci_issuetoc(?:&amp;|&)pid=([^&"]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)) {
      const issuePid = decodeHtml(linkMatch[1]);
      const number = textContent(linkMatch[2]) || null;
      catalog.set(issuePid, { year, volume, number });
    }
  }
  return catalog;
}

function isScientificIssueEntry(category, title) {
  const categoryText = normalizeTitle(category);
  const titleText = normalizeTitle(title);
  const excluded = /(?:^|\b)(apresentacao|editorial|expediente|sumario|errata|retratação|retratacao|resenha|review|entrevista|interview|carta ao editor|letter to the editor|obituario|homenagem|agradecimento|indice|normas para publicacao|creditos)(?:\b|$)/;
  return !excluded.test(categoryText) && !excluded.test(titleText);
}

function parseIssueArticles(html, journal, issuePid, issueMetadata = null) {
  const headingHtml = html.match(/<h1\b[^>]*class="[^"]*visually-hidden[^"]*"[^>]*>([\s\S]*?)<\/h1>/i)?.[1]
    ?? html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    ?? '';
  const heading = textContent(headingHtml);
  const year = issueMetadata?.year || Number(issuePid.slice(journal.id.length, journal.id.length + 4));
  const volume = issueMetadata?.volume ?? heading.match(/\bvol\.?\s*([^\s,;]+)/i)?.[1] ?? null;
  const number = issueMetadata?.number ?? heading.match(/\bn[uú]mero\s*(.+?)(?:\s*[-|]|$)/i)?.[1]?.trim() ?? null;
  const source = `${journal.title}${volume ? ` v.${volume}` : ''}${number ? ` n.${number}` : ''} ${year}`;
  const records = [];
  for (const match of html.matchAll(/<article\b[^>]*class="[^"]*issue-article-entry[^"]*"[^>]*>([\s\S]*?)<\/article>/gi)) {
    const block = match[1];
    const category = textContent(block.match(/class="[^"]*issue-article-category[^"]*"[^>]*>([\s\S]*?)<\//i)?.[1] ?? '');
    const titleMatch = block.match(/class="[^"]*issue-article-title[^"]*"[^>]*>[\s\S]*?<a\b[^>]*href="([^"]*script=sci_arttext[^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!titleMatch) continue;
    const title = textContent(titleMatch[2]);
    if (!isScientificIssueEntry(category, title)) continue;
    const href = decodeHtml(titleMatch[1]);
    const articlePid = href.match(/[?&]pid=(S[0-9Xx-]+)/i)?.[1] ?? null;
    const authorsBlock = block.match(/class="[^"]*issue-article-authors[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? '';
    const authors = [...authorsBlock.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)].map((author) => textContent(author[1])).filter(Boolean);
    records.push({
      id: articlePid ?? `${journal.id}-${year}-${normalizeTitle(title)}`,
      title, authors, date: String(year), year, volume, number, doi: null,
      url: new URL(href, EDUCA_BASE).toString(), type: 'article', section: category || null, source,
    });
  }
  return records;
}

async function harvestEducaIssues(journal) {
  const progressPath = resolve(cacheDir, `${journal.id}-educa-issues.json`);
  const saved = existsSync(progressPath) ? JSON.parse(readFileSync(progressPath, 'utf8')) : null;
  const issuesUrl = journal.issuesUrl ?? `${EDUCA_BASE}/scielo.php?script=sci_issues&pid=${encodeURIComponent(journal.id)}&lng=pt&nrm=iso`;
  let issuePids = saved?.issuePids ?? null;
  let issueMetadata = saved?.issueMetadata ?? null;
  const completedIssuePids = new Set(saved?.completedIssuePids ?? []);
  const records = saved?.records ?? [];
  if (!issuePids) {
    currentProgress = { ...currentProgress, phase: 'collecting_educa_issues', source: 'educa_issues', page: 0, records: 0 };
    writeProcessingStatus(true);
    const issuesHtml = await fetchHtml(issuesUrl, `${journal.title} · Todos os números`);
    const issueCatalog = parseIssueCatalog(issuesHtml);
    issuePids = issueCatalog.size ? [...issueCatalog.keys()] : parseIssuePids(issuesHtml);
    issueMetadata = Object.fromEntries(issueCatalog);
    if (!issuePids.length) throw new Error('A página “Todos os números” não apresentou fascículos para coleta.');
    if (journal.issueCount && issuePids.length < journal.issueCount) {
      throw new Error(`A página “Todos os números” retornou apenas ${issuePids.length} de ${journal.issueCount} fascículos esperados.`);
    }
    writeFileSync(progressPath, `${JSON.stringify({ issuePids, issueMetadata, completedIssuePids: [], records })}\n`, 'utf8');
  }
  console.log(`${journal.title}: recuperação por “Todos os números” — ${completedIssuePids.size}/${issuePids.length} fascículos já concluídos.`);
  for (let index = 0; index < issuePids.length; index += 1) {
    const issuePid = issuePids[index];
    if (completedIssuePids.has(issuePid)) continue;
    currentProgress = {
      ...currentProgress, journalId: journal.id, title: journal.title,
      phase: 'collecting_educa_issues', source: 'educa_issues', page: index + 1,
      issueTotal: issuePids.length, records: records.length,
    };
    writeProcessingStatus(true);
    const issueUrl = `${EDUCA_BASE}/scielo.php?script=sci_issuetoc&pid=${encodeURIComponent(issuePid)}&lng=pt&nrm=iso`;
    const html = await fetchHtml(issueUrl, `${journal.title} · fascículo ${index + 1}/${issuePids.length}`);
    records.push(...parseIssueArticles(html, journal, issuePid, issueMetadata?.[issuePid]));
    completedIssuePids.add(issuePid);
    writeFileSync(progressPath, `${JSON.stringify({ issuePids, issueMetadata, completedIssuePids: [...completedIssuePids], records })}\n`, 'utf8');
    if ((index + 1) % 5 === 0 || index + 1 === issuePids.length) {
      console.log(`${journal.title}: ${index + 1}/${issuePids.length} fascículos, ${records.length} artigos científicos.`);
    }
    await sleep(1200);
  }
  if (existsSync(progressPath)) unlinkSync(progressPath);
  return dedupe(records);
}

async function repairEducaIssueMetadata(journal, records) {
  const issuesUrl = journal.issuesUrl ?? `${EDUCA_BASE}/scielo.php?script=sci_issues&pid=${encodeURIComponent(journal.id)}&lng=pt&nrm=iso`;
  const catalog = parseIssueCatalog(await fetchHtml(issuesUrl, `${journal.title} · catálogo de fascículos`));
  if (!catalog.size) throw new Error('Não foi possível reconstruir os metadados dos fascículos pela página “Todos os números”.');
  const issuePids = [...catalog.keys()];
  return records.map((record) => {
    const identifier = String(record.id ?? '');
    const articlePid = identifier.startsWith('S') ? identifier.slice(1) : identifier;
    const issuePid = issuePids.find((candidate) => articlePid.startsWith(candidate)) ?? null;
    const metadata = issuePid ? catalog.get(issuePid) : null;
    if (!metadata) return record;
    return {
      ...record,
      year: metadata.year || record.year,
      volume: metadata.volume ?? record.volume,
      number: metadata.number ?? record.number,
      issueKey: issuePid,
      source: `${journal.title}${metadata.volume ? ` v.${metadata.volume}` : ''}${metadata.number ? ` n.${metadata.number}` : ''} ${metadata.year || record.year}`,
    };
  });
}

function parseEducaRecord(block, journalId) {
  const headerIdentifier = first(block.match(/<header\b[^>]*>([\s\S]*?)<\/header>/i)?.[1] ?? '', 'identifier');
  const articlePid = headerIdentifier?.match(/oai:scielo:(S[0-9Xx-]+)/)?.[1] ?? null;
  const dates = values(block, 'dc:date');
  const publicationDate = dates.find((date) => /^\d{4}(?:-\d{2})?(?:-\d{2})?$/.test(date)) ?? dates[0] ?? null;
  const fallbackYear = articlePid ? Number(articlePid.replaceAll('-', '').slice(9, 13)) : null;
  const year = publicationDate && /^\d{4}/.test(publicationDate) ? Number(publicationDate.slice(0, 4)) : fallbackYear;
  if (!year || year < 1800 || year > 2100) return null;
  const source = first(block, 'dc:source');
  const identifiers = values(block, 'dc:identifier');
  const relations = values(block, 'dc:relation');
  const types = values(block, 'dc:type');
  const type = types.find((item) => item.includes('semantics/'))?.split('/').pop() ?? types[0] ?? 'document';
  if (!type.toLocaleLowerCase('en').includes('article')) return null;
  return {
    id: articlePid ?? headerIdentifier ?? `${journalId}-${year}-${normalizeTitle(first(block, 'dc:title') ?? '')}`,
    title: first(block, 'dc:title') ?? 'Título não informado',
    authors: values(block, 'dc:creator'), date: publicationDate, year,
    volume: source?.match(/\bv\.\s*([^\s]+)/i)?.[1]?.replace(/[;,]$/, '') ?? null,
    number: source?.match(/\bn\.\s*(.+?)(?=\s+\d{4}\b|$)/i)?.[1]?.trim() ?? null,
    doi: extractDoi([...identifiers, ...relations]),
    url: identifiers.find((identifier) => identifier.includes('script=sci_arttext')) ?? null,
    type: 'article', section: null, source,
  };
}

function parseOfficialRecord(block, setNames, journalId) {
  if (/status="deleted"/i.test(block)) return null;
  const header = block.match(/<header\b[^>]*>([\s\S]*?)<\/header>/i)?.[1] ?? '';
  const identifier = first(header, 'identifier');
  const recordSets = values(header, 'setSpec');
  const sections = recordSets.map((setSpec) => setNames.get(setSpec)).filter(Boolean);
  const section = sections.join(' | ') || null;
  const types = values(block, 'dc:type');
  const isArticleType = types.some((type) => /(?:semantics\/article|^article$|^artigo$)/i.test(type));
  const excludedSection = sections.some((name) => /(editorial|resenha|review|entrevista|interview|errata|apresenta|expediente|capa|sum[aá]rio|tradu[cç][aã]o|documento|comunica[cç][aã]o|not[ií]cia|obitu[aá]rio|carta|letter)/i.test(name));
  const titleEntries = entries(block, 'dc:title');
  const titles = titleEntries.map((entry) => entry.value);
  const title = titleEntries.find((entry) => /xml:lang="(?:pt|pt-BR)"/i.test(entry.attributes))?.value ?? titles[0] ?? 'Título não informado';
  const normalized = normalizeTitle(title);
  const excludedTitle = /^(apresentacao|editorial|expediente|sumario|capa|errata)\b/.test(normalized);
  if (!isArticleType || excludedSection || excludedTitle) return null;
  const sources = values(block, 'dc:source');
  const identifiers = values(block, 'dc:identifier');
  const relations = values(block, 'dc:relation');
  const date = values(block, 'dc:date').find((item) => /^\d{4}(?:-\d{2})?(?:-\d{2})?/.test(item)) ?? first(block, 'dc:date');
  const sourceText = sources.find((item) => /\b(?:v\.|vol\.|volume)\s*\d+/i.test(item)) ?? sources[0] ?? '';
  const sourceYear = sourceText.match(/(?:\(|\b)(\d{4})(?:\)|\b)/)?.[1];
  const year = Number(sourceYear ?? date?.slice(0, 4));
  if (!year || year < 1800 || year > 2100) return null;
  const url = identifiers.find((item) => /^https?:\/\//i.test(item) && /article|view|artigo/i.test(item))
    ?? relations.find((item) => /^https?:\/\//i.test(item) && /article|view|artigo/i.test(item))
    ?? identifiers.find((item) => /^https?:\/\//i.test(item)) ?? null;
  return {
    id: identifier ?? url ?? `${journalId}-${year}-${normalized}`,
    title, titles, authors: values(block, 'dc:creator'), date, year,
    volume: sourceText.match(/(?:\bv\.|\bvol\.|\bvolume)\s*([^\s,;(]+)/i)?.[1] ?? null,
    number: sourceText.match(/(?:\bn\.|\bno\.|\bn[uú]mero)\s*([^\s,;(]+)/i)?.[1] ?? null,
    doi: extractDoi([...identifiers, ...relations]), url, type: 'article', section, source: sourceText,
  };
}

function dedupe(records) {
  const unique = new Map();
  for (const record of records) {
    const key = record.id || `${record.year}|${normalizeTitle(record.title)}`;
    if (!unique.has(key)) unique.set(key, record);
  }
  return [...unique.values()];
}

async function harvest(endpoint, journal, source, setNames = new Map()) {
  const progressPath = resolve(cacheDir, `${journal.id}-${source}.json`);
  const saved = existsSync(progressPath) ? JSON.parse(readFileSync(progressPath, 'utf8')) : null;
  const records = saved?.records ?? [];
  let token = saved?.token ?? null;
  let page = saved?.page ?? 0;
  if (saved) console.log(`${journal.title}: retomando ${source} na página ${page + 1}.`);
  do {
    const url = page > 0
      ? `${endpoint}?verb=ListRecords&resumptionToken=${encodeOaiToken(token)}`
      : source === 'educa'
        ? `${endpoint}?verb=ListRecords&metadataPrefix=oai_dc&set=${encodeURIComponent(journal.id)}`
        : `${endpoint}?verb=ListRecords&metadataPrefix=oai_dc`;
    currentProgress = {
      ...currentProgress,
      journalId: journal.id,
      title: journal.title,
      phase: source === 'educa' ? 'collecting_educa' : 'collecting_official',
      source,
      page: page + 1,
      records: records.length,
    };
    writeProcessingStatus(true);
    const xml = await fetchXml(url, `${journal.title} · ${source}`);
    const oaiError = xml.match(/<error[^>]*code="([^"]+)"[^>]*>([\s\S]*?)<\/error>/i);
    if (oaiError) {
      if (oaiError[1] === 'noRecordsMatch') return [];
      throw new Error(`${oaiError[1]}: ${decodeHtml(oaiError[2])}`);
    }
    for (const match of xml.matchAll(/<record\b[^>]*>([\s\S]*?)<\/record>/gi)) {
      const record = source === 'educa'
        ? parseEducaRecord(match[1], journal.id)
        : parseOfficialRecord(match[1], setNames, journal.id);
      if (record) records.push(record);
    }
    token = first(xml, 'resumptionToken');
    page += 1;
    currentProgress = { journalId: journal.id, title: journal.title, phase: source === 'educa' ? 'collecting_educa' : 'collecting_official', source, page, records: records.length };
    writeProcessingStatus(true);
    if (token) writeFileSync(progressPath, `${JSON.stringify({ page, token, records })}\n`, 'utf8');
    if (page % 10 === 0) console.log(`${journal.title}: ${source} — ${page} páginas, ${records.length} artigos.`);
    if (token) await sleep(source === 'educa' ? 1400 : 600);
  } while (token);
  if (existsSync(progressPath)) unlinkSync(progressPath);
  return dedupe(records);
}

async function readSetNames(endpoint, journal) {
  const setNames = new Map();
  try {
    let token = null; let page = 0;
    do {
      const url = page > 0 ? `${endpoint}?verb=ListSets&resumptionToken=${encodeOaiToken(token)}` : `${endpoint}?verb=ListSets`;
      const xml = await fetchXml(url, `${journal.title} · seções`, 6);
      for (const match of xml.matchAll(/<set>([\s\S]*?)<\/set>/gi)) {
        const spec = first(match[1], 'setSpec'); const name = first(match[1], 'setName');
        if (spec && name) setNames.set(spec, name);
      }
      token = first(xml, 'resumptionToken'); page += 1;
    } while (token);
  } catch (error) {
    console.warn(`${journal.title}: não foi possível ler os nomes das seções; usando apenas o tipo documental.`);
  }
  return setNames;
}

function detailHierarchy(records) {
  const years = new Map();
  for (const article of records) {
    if (!years.has(article.year)) years.set(article.year, new Map());
    const issues = years.get(article.year);
    const key = `${article.volume ?? ''}|${article.number ?? ''}`;
    if (!issues.has(key)) issues.set(key, { key, volume: article.volume, number: article.number, articles: [] });
    issues.get(key).articles.push({ ...article, issueKey: key, languages: [] });
  }
  return [...years.entries()].sort(([a], [b]) => b - a).map(([year, issues]) => {
    const issueList = [...issues.values()].map((issue) => ({
      ...issue, articleCount: issue.articles.length,
      articles: issue.articles.sort((a, b) => a.title.localeCompare(b.title, 'pt-BR')),
    })).sort((a, b) => String(b.volume ?? '').localeCompare(String(a.volume ?? ''), 'pt-BR', { numeric: true }) || String(b.number ?? '').localeCompare(String(a.number ?? ''), 'pt-BR', { numeric: true }));
    return { year, articleCount: issueList.reduce((sum, issue) => sum + issue.articleCount, 0), issueCount: issueList.length, issues: issueList };
  });
}

const upsertJournal = db.prepare(`
  INSERT INTO journals (id, title, status, official_site_url, official_oai_url, educa_source_url, educa_first_year, educa_latest_year)
  VALUES (?, ?, 'active', ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET title=excluded.title, official_site_url=excluded.official_site_url,
    official_oai_url=excluded.official_oai_url, educa_source_url=excluded.educa_source_url,
    educa_first_year=excluded.educa_first_year, educa_latest_year=excluded.educa_latest_year
`);
const insertArticle = db.prepare(`
  INSERT INTO articles (journal_id, source, source_identifier, title, normalized_title, authors_json, publication_date,
    publication_year, volume, issue, doi, url, document_type, section, source_citation, harvested_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'article', ?, ?, ?)
  ON CONFLICT(journal_id, source, source_identifier) DO UPDATE SET title=excluded.title,
    normalized_title=excluded.normalized_title, authors_json=excluded.authors_json,
    publication_date=excluded.publication_date, publication_year=excluded.publication_year,
    volume=excluded.volume, issue=excluded.issue, doi=excluded.doi, url=excluded.url,
    section=excluded.section, source_citation=excluded.source_citation, harvested_at=excluded.harvested_at
`);

function saveArticles(journalId, source, records) {
  const now = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM articles WHERE journal_id = ? AND source = ?').run(journalId, source);
    for (const article of records) {
      insertArticle.run(journalId, source, String(article.id), article.title, normalizeTitle(article.title), JSON.stringify(article.authors ?? []),
        article.date ?? null, article.year, article.volume ?? null, article.number ?? null, article.doi ?? null,
        article.url ?? null, article.section ?? null, article.source ?? null, now);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function compareJournal(journal, officialRecords, educaRecords, coverageEnd = null) {
  const educaByDoi = new Map(); const educaByTitle = new Map();
  for (const article of educaRecords) {
    if (article.doi) educaByDoi.set(article.doi.toLocaleLowerCase('en'), article);
    const key = normalizeTitle(article.title);
    if (!educaByTitle.has(key)) educaByTitle.set(key, []);
    educaByTitle.get(key).push(article);
  }
  const firstYear = Math.min(...educaRecords.map((article) => article.year));
  const results = [];
  for (const official of officialRecords) {
    if (official.year < firstYear || (coverageEnd !== null && official.year > coverageEnd)) {
      results.push({ official, educa: null, status: 'outside_educa_coverage', method: null, score: null });
      continue;
    }
    let educa = official.doi ? educaByDoi.get(official.doi) : null;
    let method = educa ? 'doi' : null; let score = educa ? 1 : 0;
    const officialTitles = official.titles?.length ? official.titles : [official.title];
    if (!educa) {
      const exact = officialTitles.flatMap((title) => educaByTitle.get(normalizeTitle(title)) ?? []);
      educa = exact.find((item) => item.year === official.year) ?? exact[0] ?? null;
      if (educa) { method = 'normalized_title'; score = 1; }
    }
    if (!educa) {
      const sameYear = educaRecords.filter((item) => item.year === official.year);
      let best = null; let bestScore = 0; let bestAuthor = 0; let contained = false;
      for (const candidate of sameYear) {
        const titleScore = Math.max(...officialTitles.map((title) => diceSimilarity(title, candidate.title)));
        const candidateNormalized = normalizeTitle(candidate.title);
        const isContained = officialTitles.some((title) => {
          const normalized = normalizeTitle(title);
          return Math.min(normalized.length, candidateNormalized.length) >= 35 && (normalized.includes(candidateNormalized) || candidateNormalized.includes(normalized));
        });
        const authorScore = authorSimilarity(official.authors ?? [], candidate.authors ?? []);
        const rank = Math.max(titleScore, isContained ? 1 : 0, authorScore >= .5 && titleScore >= .45 ? .89 : 0);
        if (rank > bestScore) { best = candidate; bestScore = rank; bestAuthor = authorScore; contained = isContained; }
      }
      if (bestScore >= .88 || contained || (bestAuthor >= .5 && bestScore >= .45)) {
        educa = best; method = 'title_author_similarity'; score = bestScore;
      }
    }
    results.push({ official, educa, status: educa ? 'matched' : 'missing_candidate', method, score });
  }
  return { firstYear, coverageEnd, results };
}

function saveComparison(journal, comparison, officialRecords, educaRecords, options = {}) {
  const auditStatus = options.auditStatus ?? 'complete';
  const educaCollectionStatus = options.educaCollectionStatus ?? 'complete';
  const officialCollectionStatus = options.officialCollectionStatus ?? 'complete';
  const collectedFirstYear = comparison.firstYear;
  const collectedLatestYear = Math.max(...educaRecords.map((article) => article.year));
  const catalogFirstYear = educaCollectionStatus === 'partial'
    ? (journal.firstIndexedYear ?? collectedFirstYear)
    : collectedFirstYear;
  const catalogLatestYear = educaCollectionStatus === 'partial'
    ? (journal.latestIndexedYear ?? collectedLatestYear)
    : collectedLatestYear;
  const comparedAt = new Date().toISOString();
  const officialIds = new Map(db.prepare("SELECT id, source_identifier FROM articles WHERE journal_id=? AND source='official'").all(journal.id).map((row) => [row.source_identifier, row.id]));
  const educaIds = new Map(db.prepare("SELECT id, source_identifier FROM articles WHERE journal_id=? AND source='educa'").all(journal.id).map((row) => [row.source_identifier, row.id]));
  const insert = db.prepare(`INSERT INTO comparisons (journal_id, official_article_id, educa_article_id, status, match_method, match_score, compared_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM comparisons WHERE journal_id=?').run(journal.id);
    for (const result of comparison.results) {
      insert.run(journal.id, officialIds.get(String(result.official.id)), result.educa ? educaIds.get(String(result.educa.id)) ?? null : null,
        result.status, result.method, result.score, comparedAt);
    }
    db.prepare(`UPDATE journals SET educa_harvest_status=?, official_harvest_status=?,
      comparison_status=?, educa_first_year=?, educa_latest_year=?, last_processed_at=?, last_error=NULL WHERE id=?`)
      .run(educaCollectionStatus, officialCollectionStatus, auditStatus, catalogFirstYear, catalogLatestYear, comparedAt, journal.id);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }

  const missing = comparison.results.filter((result) => result.status === 'missing_candidate').map((result) => result.official);
  const matchedCount = comparison.results.filter((result) => result.status === 'matched').length;
  const outsideCoverageCount = comparison.results.filter((result) => result.status === 'outside_educa_coverage').length;
  const payload = {
    journalId: journal.id, journalTitle: journal.title, comparedAt, status: auditStatus, scope: 'scientific-articles-only',
    officialSource: { name: journal.publisher ?? journal.title, url: journal.officialSiteUrl, oaiUrl: journal.officialOaiUrl },
    educaSource: EDUCA_OAI, educaCollectionStatus, officialCollectionStatus,
    educaCoverageStart: comparison.firstYear, educaCoverageEnd: comparison.coverageEnd,
    officialCoverageStart: Math.min(...officialRecords.map((article) => article.year)),
    officialCoverageEnd: Math.max(...officialRecords.map((article) => article.year)),
    officialArticleCount: officialRecords.length,
    officialInCoverageCount: officialRecords.length - outsideCoverageCount,
    educaArticleCount: educaRecords.length, matchedCount, missingCount: missing.length, outsideCoverageCount,
    matchingMethod: 'DOI; título normalizado; título e autoria no mesmo ano', missing,
  };
  writeFileSync(resolve(comparisonDir, `${journal.id}.json`), `${JSON.stringify(payload)}\n`, 'utf8');
  return payload;
}

function updateSummary(journalId, educaRecords, hierarchy, comparison) {
  const isEducaPartial = comparison.educaCollectionStatus === 'partial';
  summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  summary.journals = summary.journals.map((journal) => journal.id === journalId ? {
    ...journal, articleCount: educaRecords.length, articleCountComplete: !isEducaPartial, articleCountPartial: isEducaPartial,
    firstIndexedYear: isEducaPartial ? (journal.firstIndexedYear ?? hierarchy.at(-1)?.year) : (hierarchy.at(-1)?.year ?? journal.firstIndexedYear),
    latestIndexedYear: isEducaPartial ? (journal.latestIndexedYear ?? hierarchy[0]?.year) : (hierarchy[0]?.year ?? journal.latestIndexedYear),
    yearlyCounts: hierarchy.map(({ year, articleCount, issueCount }) => ({ year, articleCount, issueCount })),
    detailsUrl: `/data/journals/${journal.id}.json`,
    comparison: {
      status: comparison.status, comparedAt: comparison.comparedAt, dataUrl: `/data/comparisons/${journal.id}.json`,
      officialArticleCount: comparison.officialArticleCount, officialInCoverageCount: comparison.officialInCoverageCount,
      matchedCount: comparison.matchedCount, missingCount: comparison.missingCount, outsideCoverageCount: comparison.outsideCoverageCount,
      educaCoverageStart: comparison.educaCoverageStart, educaCoverageEnd: comparison.educaCoverageEnd,
      educaCollectionStatus: comparison.educaCollectionStatus, officialCollectionStatus: comparison.officialCollectionStatus,
      officialCoverageStart: comparison.officialCoverageStart, officialCoverageEnd: comparison.officialCoverageEnd,
    },
  } : journal);
  summary.source.capturedAt = new Date().toISOString();
  summary.source.database = 'SQLite';
  summary.source.databaseUpdatedAt = new Date().toISOString();
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
}

function importExistingEduca(journal) {
  const detailPath = resolve(detailDir, `${journal.id}.json`);
  if (!existsSync(detailPath)) return null;
  const detail = JSON.parse(readFileSync(detailPath, 'utf8'));
  return dedupe(detail.years.flatMap((year) => year.issues.flatMap((issue) => issue.articles)));
}

function importPartialEduca(journal) {
  const progressPath = resolve(cacheDir, `${journal.id}-educa.json`);
  if (!existsSync(progressPath)) return null;
  const saved = JSON.parse(readFileSync(progressPath, 'utf8'));
  return dedupe(saved.records ?? []);
}

function importPartialOfficial(journal) {
  const progressPath = resolve(cacheDir, `${journal.id}-official.json`);
  if (!existsSync(progressPath)) return null;
  const saved = JSON.parse(readFileSync(progressPath, 'utf8'));
  return dedupe(saved.records ?? []);
}

function importExistingOfficial(journal) {
  const officialPath = resolve(officialDir, `${journal.id}.json`);
  if (!existsSync(officialPath)) return null;
  const saved = JSON.parse(readFileSync(officialPath, 'utf8'));
  if (saved.collectionStatus !== 'complete' || !Array.isArray(saved.articles) || !saved.articles.length) return null;
  return dedupe(saved.articles);
}

async function processJournal(journal, position, total) {
  const partialEducaAudit = usePartialEduca && journal.id === requestedId;
  const partialOfficialAudit = usePartialOfficial && journal.id === requestedId;
  const issueFallbackAudit = recoverEducaIssues && (!requestedId || journal.id === requestedId);
  const existingDetailPath = resolve(detailDir, `${journal.id}.json`);
  const existingDetail = existsSync(existingDetailPath)
    ? JSON.parse(readFileSync(existingDetailPath, 'utf8'))
    : null;
  const partialAudit = partialEducaAudit || partialOfficialAudit;
  const startedAt = new Date().toISOString();
  upsertJournal.run(journal.id, journal.title, journal.officialSiteUrl ?? null, journal.officialOaiUrl, journal.sourceUrl,
    journal.firstIndexedYear ?? null, journal.latestIndexedYear ?? null);
  const run = db.prepare("INSERT INTO processing_runs (journal_id, phase, status, started_at) VALUES (?, ?, 'running', ?)")
    .run(journal.id, recompareExisting ? 'recompare_existing' : issueFallbackAudit ? 'educa_issues_recovery' : partialAudit ? 'partial_audit' : 'full_audit', startedAt);
  try {
    currentProgress = { journalId: journal.id, title: journal.title, phase: 'starting', source: null, page: 0, records: 0, position, queueTotal: total };
    writeProcessingStatus(true);
    console.log(`[${position}/${total}] ${journal.title}: iniciando coleta e cruzamento.`);
    let educaCollectionMethod = existingDetail?.collectionMethod ?? 'oai';
    let educaRecords = issueFallbackAudit ? null : partialEducaAudit ? importPartialEduca(journal) : importExistingEduca(journal);
    if (recompareExisting && !educaRecords?.length) throw new Error('Não há uma coleta completa do Educ@ salva para refazer o cruzamento.');
    if (partialEducaAudit && !educaRecords?.length) throw new Error('Não há registros parciais do Educ@ disponíveis para este periódico.');
    if (issueFallbackAudit) {
      educaCollectionMethod = 'issues_html_fallback';
      educaRecords = await harvestEducaIssues(journal);
    } else if (!educaRecords) {
      try {
        educaRecords = await harvest(EDUCA_OAI, journal, 'educa');
      } catch (error) {
        console.warn(`${journal.title}: OAI do Educ@ falhou; iniciando recuperação por “Todos os números”.`);
        educaCollectionMethod = 'issues_html_fallback';
        educaRecords = await harvestEducaIssues(journal);
      }
    }
    else { currentProgress = { ...currentProgress, phase: 'loading_saved_educa', source: 'educa', records: educaRecords.length }; writeProcessingStatus(true); }
    if (recompareExisting && existingDetail?.collectionMethod === 'issues_html_fallback') {
      currentProgress = { ...currentProgress, phase: 'repairing_issue_metadata', source: 'educa_issues', page: 0, records: educaRecords.length };
      writeProcessingStatus(true);
      educaRecords = await repairEducaIssueMetadata(journal, educaRecords);
    }
    saveArticles(journal.id, 'educa', educaRecords);
    const hierarchy = detailHierarchy(educaRecords);
    const detail = {
      journal: { id: journal.id, title: journal.title, printIssn: journal.printIssn, onlineIssn: journal.onlineIssn, sourceUrl: journal.sourceUrl },
      capturedAt: new Date().toISOString(),
      source: existingDetail?.source ?? (educaCollectionMethod === 'issues_html_fallback' ? journal.issuesUrl : EDUCA_OAI),
      collectionMethod: educaCollectionMethod,
      documentTypeScope: 'article', collectionStatus: partialEducaAudit ? 'partial' : 'complete', articleCount: educaRecords.length,
      firstYear: hierarchy.at(-1)?.year ?? null, latestYear: hierarchy[0]?.year ?? null, years: hierarchy,
    };
    writeFileSync(resolve(detailDir, `${journal.id}.json`), `${JSON.stringify(detail)}\n`, 'utf8');

    let officialRecords = partialOfficialAudit ? importPartialOfficial(journal) : (recompareExisting || educaCollectionMethod === 'issues_html_fallback') ? importExistingOfficial(journal) : null;
    if (partialOfficialAudit && !officialRecords?.length) throw new Error('Não há registros parciais da base oficial disponíveis para este periódico.');
    if (!officialRecords) {
      const setNames = await readSetNames(journal.officialOaiUrl, journal);
      officialRecords = await harvest(journal.officialOaiUrl, journal, 'official', setNames);
    } else {
      currentProgress = { ...currentProgress, phase: 'loading_saved_official', source: 'official', records: officialRecords.length };
      writeProcessingStatus(true);
    }
    saveArticles(journal.id, 'official', officialRecords);
    writeFileSync(resolve(officialDir, `${journal.id}.json`), `${JSON.stringify({ journalId: journal.id, capturedAt: new Date().toISOString(), source: journal.officialOaiUrl, collectionStatus: partialOfficialAudit ? 'partial' : 'complete', articleCount: officialRecords.length, articles: officialRecords })}\n`, 'utf8');

    currentProgress = { ...currentProgress, phase: 'comparing', source: null, records: officialRecords.length };
    writeProcessingStatus(true);
    const coverageEnd = Math.max(...educaRecords.map((article) => article.year));
    const comparison = compareJournal(journal, officialRecords, educaRecords, coverageEnd);
    const payload = saveComparison(journal, comparison, officialRecords, educaRecords, {
      auditStatus: partialAudit ? 'partial' : 'complete',
      educaCollectionStatus: partialEducaAudit ? 'partial' : 'complete',
      officialCollectionStatus: partialOfficialAudit ? 'partial' : 'complete',
    });
    updateSummary(journal.id, educaRecords, hierarchy, payload);
    db.prepare("UPDATE processing_runs SET status='complete', records_processed=?, finished_at=? WHERE id=?")
      .run(educaRecords.length + officialRecords.length, new Date().toISOString(), run.lastInsertRowid);
    console.log(`[${position}/${total}] ${journal.title}: ${partialAudit ? 'cruzamento parcial concluído' : 'concluído'} — ${educaRecords.length} no Educ@, ${officialRecords.length} na revista, ${payload.missingCount} candidatos ausentes.`);
    currentProgress = null;
    writeProcessingStatus(true);
  } catch (error) {
    db.prepare("UPDATE processing_runs SET status='failed', finished_at=?, error_message=? WHERE id=?")
      .run(new Date().toISOString(), String(error.message ?? error), run.lastInsertRowid);
    db.prepare("UPDATE journals SET last_error=?, last_processed_at=? WHERE id=?")
      .run(String(error.message ?? error), new Date().toISOString(), journal.id);
    console.error(`[${position}/${total}] ${journal.title}: falha temporária — ${error.message ?? error}`);
    currentProgress = null;
    writeProcessingStatus(true);
  }
}

const invalidOfficial = (journal) => !isIndependentOfficialOai(journal);
const isCompleteInDatabase = (journalId) => ['complete', 'partial'].includes(db.prepare("SELECT comparison_status FROM journals WHERE id=?").get(journalId)?.comparison_status);
const needsEducaIssueRecovery = (journal) => journal.articleCountPartial || journal.comparison?.educaCollectionStatus === 'partial';
const candidates = summary.journals.filter((journal) => !invalidOfficial(journal)
  && (!requestedId || journal.id === requestedId)
  && (recompareExisting ? Boolean(requestedId) : recoverEducaIssues ? (requestedId || needsEducaIssueRecovery(journal)) : (requestedId || !isCompleteInDatabase(journal.id))));
const queue = requestedLimit > 0 ? candidates.slice(0, requestedLimit) : candidates;

console.log(`Banco: ${databasePath}`);
console.log(`Fila inicial: ${queue.length} periódicos com OAI oficial independente do Educ@.`);
writeProcessingStatus(true);
for (let index = 0; index < queue.length; index += 1) await processJournal(queue[index], index + 1, queue.length);
db.exec('PRAGMA optimize;');
currentProgress = null;
writeProcessingStatus(false);
console.log('Processamento da fila OAI concluído.');
db.close();
