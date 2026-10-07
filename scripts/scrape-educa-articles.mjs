import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const OAI_URL = 'https://educa.fcc.org.br/oai/scielo-oai.php';
const summaryPath = resolve('app/journals.json');
const detailsDir = resolve('public/data/journals');
const progressDir = resolve('.cache/educa-oai');
const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
mkdirSync(detailsDir, { recursive: true });
mkdirSync(progressDir, { recursive: true });
const execFileAsync = promisify(execFile);

function decodeHtml(value = '') {
  return value
    .replace(/^<!\[CDATA\[|\]\]>$/g, '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .trim();
}

function cleanXml(value = '') {
  return decodeHtml(value.replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

function tagValues(xml, tag) {
  const pattern = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  return [...xml.matchAll(pattern)].map((match) => cleanXml(match[1])).filter(Boolean);
}

function firstTag(xml, tag) {
  return tagValues(xml, tag)[0] ?? null;
}

async function sleep(ms) {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function fetchXml(url, attempts = 30) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const { stdout } = await execFileAsync('curl.exe', [
        '-LsS', '--max-redirs', '10', '--connect-timeout', '20', '--max-time', '90',
        '-A', 'Mozilla/5.0 Atlas-Educa-Auditoria/1.0', '-w', '\n__STATUS__:%{http_code}', url,
      ], { maxBuffer: 50 * 1024 * 1024 });
      const marker = stdout.lastIndexOf('\n__STATUS__:');
      const body = marker >= 0 ? stdout.slice(0, marker) : stdout;
      const status = marker >= 0 ? Number(stdout.slice(marker + 12).trim()) : 0;
      if (status === 200 && body.includes('<OAI-PMH')) return body;
      if (status === 429) {
        console.warn(`Educ@ limitou temporariamente as requisições; aguardando 60 segundos (tentativa ${attempt}/${attempts}).`);
        await sleep(60000);
        continue;
      }
      throw new Error(`Resposta OAI inválida (HTTP ${status || 'desconhecido'})`);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(Math.min(20000, attempt * 2500));
    }
  }
  throw lastError;
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function parseRecord(block, journalId) {
  const oaiIdentifier = firstTag(block, 'identifier');
  const articlePid = oaiIdentifier?.match(/oai:scielo:(S[0-9Xx-]+)/)?.[1] ?? null;
  const dates = tagValues(block, 'dc:date');
  const publicationDate = dates.find((date) => /^\d{4}(?:-\d{2})?(?:-\d{2})?$/.test(date)) ?? dates[0] ?? null;
  const fallbackYear = articlePid ? Number(articlePid.replaceAll('-', '').slice(9, 13)) : null;
  const year = publicationDate && /^\d{4}/.test(publicationDate)
    ? Number(publicationDate.slice(0, 4))
    : fallbackYear;
  if (!year || year < 1800 || year > 2100) return null;

  const source = firstTag(block, 'dc:source');
  const volume = source?.match(/\bv\.\s*([^\s]+)/i)?.[1]?.replace(/[;,]$/, '') ?? null;
  const number = source?.match(/\bn\.\s*(.+?)(?=\s+\d{4}\b|$)/i)?.[1]?.trim() ?? null;
  const identifiers = tagValues(block, 'dc:identifier');
  const articleUrl = identifiers.find((identifier) => identifier.includes('script=sci_arttext')) ?? null;
  const doi = identifiers
    .map((identifier) => identifier.match(/(?:doi\.org\/|doi:)(10\.\d{4,9}\/\S+)/i)?.[1])
    .find(Boolean) ?? null;
  const types = tagValues(block, 'dc:type');
  const type = types.find((item) => item.includes('semantics/'))?.split('/').pop() ?? types[0] ?? 'documento';
  const languages = [...new Set(tagValues(block, 'dc:language'))];
  const normalizedPid = articlePid?.replaceAll('-', '') ?? '';
  const issueKey = normalizedPid.length >= 17 ? normalizedPid.slice(13, 17) : `${volume ?? ''}-${number ?? ''}`;

  return {
    id: articlePid ?? `${journalId}-${year}-${Math.random().toString(36).slice(2)}`,
    title: firstTag(block, 'dc:title') ?? 'Título não informado',
    authors: tagValues(block, 'dc:creator'),
    date: publicationDate,
    year,
    volume,
    number,
    issueKey,
    type,
    languages,
    doi,
    url: articleUrl,
    source,
  };
}

async function harvestJournal(journal) {
  const progressPath = resolve(progressDir, `${journal.id}.json`);
  const savedProgress = existsSync(progressPath) ? JSON.parse(readFileSync(progressPath, 'utf8')) : null;
  const records = savedProgress?.records ?? [];
  let token = savedProgress?.token ?? null;
  let page = savedProgress?.page ?? 0;
  if (savedProgress) console.log(`Retomando ${journal.title} na página ${page + 1}.`);
  do {
    const url = page > 0
      ? `${OAI_URL}?verb=ListRecords&resumptionToken=${encodeURIComponent(token)}`
      : `${OAI_URL}?verb=ListRecords&metadataPrefix=oai_dc&set=${encodeURIComponent(journal.id)}`;
    const xml = await fetchXml(url);
    const error = xml.match(/<error[^>]*code="([^"]+)"[^>]*>([\s\S]*?)<\/error>/i);
    if (error) {
      if (error[1] === 'noRecordsMatch') return [];
      throw new Error(`${error[1]}: ${cleanXml(error[2])}`);
    }
    for (const match of xml.matchAll(/<record\b[^>]*>([\s\S]*?)<\/record>/gi)) {
      const record = parseRecord(match[1], journal.id);
      if (record && record.type.toLocaleLowerCase('en').includes('article')) records.push(record);
    }
    const tokenMatch = xml.match(/<resumptionToken[^>]*>([\s\S]*?)<\/resumptionToken>/i);
    token = tokenMatch ? cleanXml(tokenMatch[1]) : null;
    page += 1;
    if (token) writeFileSync(progressPath, `${JSON.stringify({ page, token, records })}\n`, 'utf8');
    if (page % 10 === 0) console.log(`${journal.title}: ${page} páginas lidas, ${records.length} artigos acumulados.`);
    if (token) await sleep(1200);
  } while (token);
  if (existsSync(progressPath)) unlinkSync(progressPath);
  return records;
}

function dedupeRecords(records) {
  const unique = new Map();
  for (const record of records) {
    const key = record.id || `${record.year}|${record.title.toLocaleLowerCase('pt-BR')}`;
    if (!unique.has(key)) unique.set(key, record);
  }
  return [...unique.values()];
}

function buildHierarchy(records) {
  const years = new Map();
  for (const article of records) {
    if (!years.has(article.year)) years.set(article.year, new Map());
    const issues = years.get(article.year);
    const key = `${article.volume ?? ''}|${article.number ?? ''}|${article.issueKey ?? ''}`;
    if (!issues.has(key)) {
      issues.set(key, {
        key,
        volume: article.volume,
        number: article.number,
        articles: [],
      });
    }
    issues.get(key).articles.push(article);
  }
  return [...years.entries()]
    .sort(([a], [b]) => b - a)
    .map(([year, issues]) => {
      const issueList = [...issues.values()]
        .map((issue) => ({
          ...issue,
          articleCount: issue.articles.length,
          articles: issue.articles.sort((a, b) => a.title.localeCompare(b.title, 'pt-BR')),
        }))
        .sort((a, b) => String(b.volume ?? '').localeCompare(String(a.volume ?? ''), 'pt-BR', { numeric: true }) || String(b.number ?? '').localeCompare(String(a.number ?? ''), 'pt-BR', { numeric: true }));
      return {
        year,
        articleCount: issueList.reduce((total, issue) => total + issue.articleCount, 0),
        issueCount: issueList.length,
        issues: issueList,
      };
    });
}

function saveProgress(result) {
  summary.journals = summary.journals.map((journal) => {
    if (journal.id !== result.id) return journal;
    const searchArticleCount = journal.searchArticleCount ?? journal.articleCount ?? 0;
    return {
      ...journal,
      articleCount: result.count,
      articleCountComplete: true,
      searchArticleCount,
      articleCountDifference: result.count - searchArticleCount,
      firstIndexedYear: result.firstYear,
      latestIndexedYear: result.latestYear,
      yearlyCounts: result.yearlyCounts,
      detailsUrl: `/data/journals/${journal.id}.json`,
    };
  });
  summary.source.capturedAt = new Date().toISOString();
  summary.source.articleCountsIncluded = true;
  summary.source.articleLevelRecordsIncluded = true;
  summary.source.oaiUrl = OAI_URL;
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
}

summary.journals = summary.journals.map((journal) => existsSync(resolve(detailsDir, `${journal.id}.json`))
  ? journal
  : { ...journal, articleCountComplete: false, yearlyCounts: null, detailsUrl: null });
writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

const results = await mapLimit(summary.journals, 1, async (journal, index) => {
  const detailPath = resolve(detailsDir, `${journal.id}.json`);
  if (existsSync(detailPath)) {
    let saved = JSON.parse(readFileSync(detailPath, 'utf8'));
    if (saved.documentTypeScope === 'article' && Array.isArray(saved.years)) {
      const flattened = saved.years.flatMap((year) => year.issues.flatMap((issue) => issue.articles));
      const uniqueRecords = dedupeRecords(flattened);
      if (uniqueRecords.length !== flattened.length) {
        const hierarchy = buildHierarchy(uniqueRecords);
        saved = { ...saved, articleCount: uniqueRecords.length, firstYear: hierarchy.at(-1)?.year ?? saved.firstYear, latestYear: hierarchy[0]?.year ?? saved.latestYear, years: hierarchy };
        writeFileSync(detailPath, `${JSON.stringify(saved)}\n`, 'utf8');
      }
      console.log(`[${index + 1}/${summary.journals.length}] ${journal.title}: ${saved.articleCount} registros (já coletados)`);
      const result = {
        id: journal.id,
        count: saved.articleCount,
        firstYear: saved.firstYear,
        latestYear: saved.latestYear,
        yearlyCounts: saved.years.map(({ year, articleCount, issueCount }) => ({ year, articleCount, issueCount })),
      };
      saveProgress(result);
      return result;
    }
  }

  let records;
  for (let journalAttempt = 1; journalAttempt <= 4; journalAttempt += 1) {
    try {
      records = await harvestJournal(journal);
      break;
    } catch (error) {
      if (journalAttempt === 4) throw error;
      console.warn(`[${index + 1}/${summary.journals.length}] nova tentativa ${journalAttempt + 1} para ${journal.title}`);
      await sleep(journalAttempt * 10000);
    }
  }
  records = dedupeRecords(records);
  const hierarchy = buildHierarchy(records);
  const detail = {
    journal: {
      id: journal.id,
      title: journal.title,
      printIssn: journal.printIssn,
      onlineIssn: journal.onlineIssn,
      sourceUrl: journal.sourceUrl,
    },
    capturedAt: new Date().toISOString(),
    source: OAI_URL,
    documentTypeScope: 'article',
    articleCount: records.length,
    firstYear: hierarchy.length ? hierarchy.at(-1).year : journal.firstIndexedYear,
    latestYear: hierarchy.length ? hierarchy[0].year : journal.latestIndexedYear,
    years: hierarchy,
  };
  writeFileSync(detailPath, `${JSON.stringify(detail)}\n`, 'utf8');
  console.log(`[${index + 1}/${summary.journals.length}] ${journal.title}: ${records.length} registros, ${hierarchy.length} anos`);
  const result = {
    id: journal.id,
    count: records.length,
    firstYear: detail.firstYear,
    latestYear: detail.latestYear,
    yearlyCounts: hierarchy.map(({ year, articleCount, issueCount }) => ({ year, articleCount, issueCount })),
  };
  saveProgress(result);
  return result;
});

const resultById = new Map(results.map((result) => [result.id, result]));
summary.journals = summary.journals.map((journal) => {
  const result = resultById.get(journal.id);
  if (!result) return journal;
  return {
    ...journal,
    articleCount: result.count,
    articleCountComplete: true,
    searchArticleCount: journal.searchArticleCount ?? journal.articleCount,
    articleCountDifference: result.count - (journal.searchArticleCount ?? journal.articleCount ?? 0),
    firstIndexedYear: result.firstYear,
    latestIndexedYear: result.latestYear,
    yearlyCounts: result.yearlyCounts,
    detailsUrl: `/data/journals/${journal.id}.json`,
  };
});
summary.source.capturedAt = new Date().toISOString();
summary.source.articleCountsIncluded = true;
summary.source.articleLevelRecordsIncluded = true;
summary.source.oaiUrl = OAI_URL;
writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
console.log('Séries anuais e registros artigo por artigo concluídos.');
