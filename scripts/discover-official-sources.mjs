import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const execFileAsync = promisify(execFile);
const summaryPath = resolve('app/journals.json');
const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));

function decodeHtml(value = '') {
  return value.replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').trim();
}

function sleep(ms) { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }

async function request(url, attempts = 8) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const { stdout } = await execFileAsync('curl.exe', [
        '-LsS', '--max-redirs', '10', '--connect-timeout', '15', '--max-time', '45',
        '-A', 'Mozilla/5.0 Atlas-Educa-Auditoria/1.0', '-w', '\n__STATUS__:%{http_code}', url,
      ], { maxBuffer: 20 * 1024 * 1024 });
      const marker = stdout.lastIndexOf('\n__STATUS__:');
      const body = marker >= 0 ? stdout.slice(0, marker) : stdout;
      const status = marker >= 0 ? Number(stdout.slice(marker + 12).trim()) : 0;
      if (status >= 200 && status < 400) return body;
      if (status === 429) { await sleep(60000); continue; }
      throw new Error(`HTTP ${status}`);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(attempt * 3000);
    }
  }
  throw lastError;
}

function extractOfficialSite(html) {
  const labelIndex = html.search(/Site do peri[oó]dico/i);
  if (labelIndex < 0) return null;
  const before = html.slice(Math.max(0, labelIndex - 1800), labelIndex);
  const anchorStart = before.lastIndexOf('<a ');
  if (anchorStart < 0) return null;
  const anchor = before.slice(anchorStart);
  return decodeHtml(anchor.match(/href=["']([^"']+)["']/i)?.[1] ?? '');
}

function oaiCandidates(siteUrl) {
  const candidates = new Set();
  try {
    const url = new URL(siteUrl);
    const path = url.pathname.replace(/\/+$/, '').replace(/\/index$/i, '');
    const ojsMatch = path.match(/^(.*\/index\.php\/[^/]+)/i);
    if (ojsMatch) candidates.add(`${url.origin}${ojsMatch[1]}/oai`);
    const journalMatch = path.match(/^(.*\/journal\/[^/]+)/i);
    if (journalMatch) candidates.add(`${url.origin}${journalMatch[1]}/oai`);
    candidates.add(`${url.origin}/index.php/oai/oai`);
    candidates.add(`${url.origin}/oai`);
  } catch {}
  return [...candidates];
}

async function findOaiEndpoint(siteUrl) {
  for (const candidate of oaiCandidates(siteUrl)) {
    try {
      const xml = await request(`${candidate}?verb=Identify`, 2);
      if (/<OAI-PMH[\s>]/i.test(xml) && /<repositoryName>/i.test(xml)) return candidate;
    } catch {}
  }
  return null;
}

for (let index = 0; index < summary.journals.length; index += 1) {
  const journal = summary.journals[index];
  if (journal.officialSiteUrl && journal.officialOaiUrl) {
    console.log(`[${index + 1}/${summary.journals.length}] ${journal.title}: fonte já identificada`);
    continue;
  }
  try {
    const html = await request(journal.sourceUrl);
    const officialSiteUrl = journal.officialSiteUrl ?? extractOfficialSite(html);
    const officialOaiUrl = officialSiteUrl ? await findOaiEndpoint(officialSiteUrl) : null;
    Object.assign(journal, {
      officialSiteUrl: officialSiteUrl || null,
      officialOaiUrl,
      officialSourceStatus: officialOaiUrl ? 'oai-ready' : officialSiteUrl ? 'site-found' : 'not-found',
    });
    console.log(`[${index + 1}/${summary.journals.length}] ${journal.title}: ${officialOaiUrl ? 'OAI encontrado' : officialSiteUrl ? 'site encontrado; OAI pendente' : 'site não encontrado'}`);
  } catch (error) {
    journal.officialSourceStatus = 'temporarily-unavailable';
    console.warn(`[${index + 1}/${summary.journals.length}] ${journal.title}: indisponível temporariamente`);
  }
  summary.source.officialSourcesDiscoveryAt = new Date().toISOString();
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await sleep(700);
}

const oaiReady = summary.journals.filter((journal) => journal.officialOaiUrl).length;
const sitesFound = summary.journals.filter((journal) => journal.officialSiteUrl).length;
console.log(`Descoberta concluída: ${sitesFound} sites oficiais e ${oaiReady} endpoints OAI.`);
