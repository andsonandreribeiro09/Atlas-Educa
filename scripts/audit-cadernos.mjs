import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const execFileAsync = promisify(execFile);
const JOURNAL_ID = '1982-7806';
const OFFICIAL_OAI = 'https://seer.ufu.br/index.php/che/oai';
const educaDetailPath = resolve(`public/data/journals/${JOURNAL_ID}.json`);
const comparisonDir = resolve('public/data/comparisons');
const comparisonPath = resolve(comparisonDir, `${JOURNAL_ID}.json`);
const summaryPath = resolve('app/journals.json');
mkdirSync(comparisonDir, { recursive: true });

function decode(value = '') {
  let cleaned = value.replace(/^<!\[CDATA\[|\]\]>$/g, '')
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
  return [...xml.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi'))].map((match) => decode(match[1])).filter(Boolean);
}

function entries(xml, tag) {
  return [...xml.matchAll(new RegExp(`<${tag}([^>]*)>([\\s\\S]*?)<\\/${tag}>`, 'gi'))]
    .map((match) => ({ attributes: match[1], value: decode(match[2]) })).filter((entry) => entry.value);
}

function first(xml, tag) { return values(xml, tag)[0] ?? null; }

function normalizeTitle(value = '') {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR')
    .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function titleTokens(value = '') {
  return new Set(normalizeTitle(value).split(' ').filter((token) => token.length > 2));
}

function similarity(a, b) {
  const left = titleTokens(a); const right = titleTokens(b);
  if (!left.size || !right.size) return 0;
  const intersection = [...left].filter((token) => right.has(token)).length;
  return intersection / new Set([...left, ...right]).size;
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

function extractDoi(inputs) {
  for (const input of inputs) {
    const match = input.match(/(?:doi(?:\.org)?[/:\s]*)?(10\.\d{4,9}\/[^\s<>"]+)/i);
    if (match) return match[1].replace(/[).,;]+$/, '').toLocaleLowerCase('en');
  }
  return null;
}

async function fetchXml(url) {
  const { stdout } = await execFileAsync('curl.exe', ['-fLsS', '--connect-timeout', '20', '--max-time', '90', url], { maxBuffer: 50 * 1024 * 1024 });
  if (!stdout.includes('<OAI-PMH')) throw new Error('Resposta OAI inválida da revista.');
  return stdout;
}

const listSetsXml = await fetchXml(`${OFFICIAL_OAI}?verb=ListSets`);
const articleSets = new Set();
const dossierHeadingTitles = new Set();
for (const match of listSetsXml.matchAll(/<set>([\s\S]*?)<\/set>/gi)) {
  const setSpec = first(match[1], 'setSpec');
  const setName = first(match[1], 'setName');
  if (setSpec && setName && /(artigo|dossi[eê])/i.test(setName)) articleSets.add(setSpec);
  if (setName && /dossi[eê]/i.test(setName)) {
    dossierHeadingTitles.add(normalizeTitle(setName));
    dossierHeadingTitles.add(normalizeTitle(setName.replace(/^dossi[eê]\s*(?:\d+)?\s*[-:–—]?\s*/i, '')));
  }
}

const officialRecords = [];
let token = null;
let page = 0;
do {
  const url = token
    ? `${OFFICIAL_OAI}?verb=ListRecords&resumptionToken=${encodeURIComponent(token)}`
    : `${OFFICIAL_OAI}?verb=ListRecords&metadataPrefix=oai_dc`;
  const xml = await fetchXml(url);
  for (const match of xml.matchAll(/<record\b[^>]*>([\s\S]*?)<\/record>/gi)) {
    const block = match[1];
    if (/status="deleted"/i.test(block)) continue;
    const sets = values(block, 'setSpec');
    if (!sets.some((setSpec) => articleSets.has(setSpec))) continue;
    const sources = values(block, 'dc:source');
    const identifiers = values(block, 'dc:identifier');
    const relations = values(block, 'dc:relation');
    const date = first(block, 'dc:date');
    const sourceText = sources.find((item) => /Cadernos de Hist[oó]ria/i.test(item)) ?? sources[0] ?? '';
    const sourceYear = sourceText.match(/\((\d{4})\)/)?.[1];
    const year = Number(sourceYear ?? date?.slice(0, 4));
    const titleEntries = entries(block, 'dc:title');
    const titles = titleEntries.map((entry) => entry.value);
    const title = titleEntries.find((entry) => /xml:lang="(?:pt|pt-BR)"/i.test(entry.attributes))?.value ?? titles[0] ?? 'Título não informado';
    const normalizedDisplayTitle = normalizeTitle(title);
    if (/^(apresentacao|editorial|expediente|sumario|capa)\b/.test(normalizedDisplayTitle) || dossierHeadingTitles.has(normalizedDisplayTitle)) continue;
    const urlValue = identifiers.find((item) => /\/article\/view\//.test(item)) ?? relations.find((item) => /\/article\/view\//.test(item)) ?? null;
    officialRecords.push({
      id: first(block, 'identifier'), title, titles, normalizedTitles: titles.map(normalizeTitle), authors: values(block, 'dc:creator'),
      date, year, volume: sourceText.match(/(?:v\.|Vol\.)\s*([^\s(]+)/i)?.[1] ?? null,
      number: sourceText.match(/(?:n\.|No\.)\s*([^\s(]+)/i)?.[1] ?? null,
      doi: extractDoi([...identifiers, ...relations]), url: urlValue, source: sourceText, section: sets.find((setSpec) => articleSets.has(setSpec)) ?? null,
    });
  }
  token = first(xml, 'resumptionToken');
  page += 1;
  console.log(`Base oficial: página ${page}, ${officialRecords.length} artigos científicos acumulados.`);
} while (token);

const educaDetail = JSON.parse(readFileSync(educaDetailPath, 'utf8'));
const educaArticles = educaDetail.years.flatMap((year) => year.issues.flatMap((issue) => issue.articles));
const educaByDoi = new Map();
const educaByTitle = new Map();
for (const article of educaArticles) {
  if (article.doi) educaByDoi.set(article.doi.toLocaleLowerCase('en'), article);
  const key = normalizeTitle(article.title);
  if (!educaByTitle.has(key)) educaByTitle.set(key, []);
  educaByTitle.get(key).push(article);
}

const coverageStart = educaDetail.firstYear;
const officialInCoverage = officialRecords.filter((article) => article.year >= coverageStart);
const outsideCoverage = officialRecords.filter((article) => article.year < coverageStart);
const matched = [];
const missing = [];
for (const official of officialInCoverage) {
  let educa = official.doi ? educaByDoi.get(official.doi) : null;
  let matchedBy = educa ? 'doi' : null;
  if (!educa) {
    const titleMatches = official.normalizedTitles.flatMap((title) => educaByTitle.get(title) ?? []);
    educa = titleMatches.find((item) => item.year === official.year) ?? titleMatches[0] ?? null;
    if (educa) matchedBy = 'title';
  }
  if (!educa) {
    const sameYear = educaArticles.filter((item) => item.year === official.year);
    let best = null; let bestScore = 0; let bestAuthorScore = 0; let bestContained = false;
    for (const candidate of sameYear) {
      const score = Math.max(...official.titles.map((title) => Math.max(similarity(title, candidate.title), diceSimilarity(title, candidate.title))));
      const candidateTitle = normalizeTitle(candidate.title);
      const contained = official.normalizedTitles.some((title) => Math.min(title.length, candidateTitle.length) >= 35 && (title.includes(candidateTitle) || candidateTitle.includes(title)));
      const candidateAuthorScore = authorSimilarity(official.authors, candidate.authors);
      const rank = Math.max(score, contained ? 1 : 0, candidateAuthorScore >= 0.5 && score >= 0.45 ? 0.89 : 0);
      if (rank > bestScore) { bestScore = rank; best = candidate; bestAuthorScore = candidateAuthorScore; bestContained = contained; }
    }
    if (bestScore >= 0.88 || bestContained || (bestAuthorScore >= 0.5 && bestScore >= 0.45)) { educa = best; matchedBy = 'similar-title-or-author'; }
  }
  if (educa) matched.push({ officialId: official.id, educaId: educa.id, matchedBy });
  else missing.push(official);
}

missing.sort((a, b) => b.year - a.year || a.title.localeCompare(b.title, 'pt-BR'));
const comparison = {
  journalId: JOURNAL_ID,
  journalTitle: educaDetail.journal.title,
  comparedAt: new Date().toISOString(),
  status: 'complete',
  scope: 'scientific-articles-only',
  officialSource: { name: 'Portal de Periódicos da Universidade Federal de Uberlândia', url: 'https://seer.ufu.br/index.php/che', oaiUrl: OFFICIAL_OAI },
  educaSource: educaDetail.source,
  educaCoverageStart: coverageStart,
  officialArticleCount: officialRecords.length,
  officialInCoverageCount: officialInCoverage.length,
  educaArticleCount: educaArticles.length,
  matchedCount: matched.length,
  missingCount: missing.length,
  outsideCoverageCount: outsideCoverage.length,
  matchingMethod: 'DOI; título normalizado; similaridade de título no mesmo ano (mínimo 90%)',
  missing,
};
writeFileSync(comparisonPath, `${JSON.stringify(comparison)}\n`, 'utf8');

const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
summary.journals = summary.journals.map((journal) => journal.id === JOURNAL_ID ? {
  ...journal,
  officialSiteUrl: comparison.officialSource.url,
  comparison: {
    status: 'complete', comparedAt: comparison.comparedAt, dataUrl: `/data/comparisons/${JOURNAL_ID}.json`,
    officialArticleCount: comparison.officialArticleCount, officialInCoverageCount: comparison.officialInCoverageCount,
    matchedCount: comparison.matchedCount, missingCount: comparison.missingCount, outsideCoverageCount: comparison.outsideCoverageCount,
  },
} : journal);
writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
console.log(`Cruzamento concluído: ${matched.length} localizados e ${missing.length} ausentes no período coberto pelo Educ@.`);
