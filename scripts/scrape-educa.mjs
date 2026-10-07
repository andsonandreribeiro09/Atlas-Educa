import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const BASE_URL = 'https://educa.fcc.org.br';
const CATALOG_URL = `${BASE_URL}/scielo.php?script=sci_alphabetic&lng=pt&nrm=iso`;
const outputPath = resolve('app/journals.json');
const fullCount = process.argv.includes('--count-articles');

function decodeHtml(value = '') {
  return value
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    );
}

function textContent(html = '') {
  return decodeHtml(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function clean(value) {
  const result = textContent(value ?? '').trim();
  return result || null;
}

function between(text, start, end) {
  const pattern = new RegExp(`${start}\\s*(.*?)\\s*${end}`, 'i');
  return text.match(pattern)?.[1]?.trim() || null;
}

async function fetchText(url, attempts = 3) {
  let error;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': 'Mozilla/5.0 metadata-dashboard/1.0' },
      });
      if (!response.ok) {
        if (response.status === 429 && attempt < attempts) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 3500));
          continue;
        }
        throw new Error(`${response.status} ${response.statusText}`);
      }
      return await response.text();
    } catch (currentError) {
      error = currentError;
      if (attempt < attempts) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 500));
      }
    }
  }
  throw error;
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function parseCatalog(html) {
  const journals = [];
  const pattern = /<li class="journal-item" data-journal-status="active" data-issues-url="([^"]+)">([\s\S]*?)<\/li>/gi;
  for (const match of html.matchAll(pattern)) {
    const issuesPath = decodeHtml(match[1]);
    const block = match[2];
    const pid = issuesPath.match(/[?&]pid=([^&]+)/i)?.[1];
    const title = clean(block.match(/class="journal-title"[^>]*>([\s\S]*?)<\/a>/i)?.[1]);
    const listedIssueCount = Number(
      block.match(/class="journal-meta">\s*(\d+)/i)?.[1] ?? 0,
    );
    if (!pid || !title) continue;
    journals.push({ pid, title, listedIssueCount });
  }
  return journals;
}

function detectPeriodicity(text) {
  const options = [
    ['fluxo contínuo', 'Fluxo contínuo'],
    ['publicação contínua', 'Fluxo contínuo'],
    ['periodicidade anual', 'Anual'],
    ['publicação anual', 'Anual'],
    ['semestral', 'Semestral'],
    ['quadrimestral', 'Quadrimestral'],
    ['trimestral', 'Trimestral'],
    ['bimestral', 'Bimestral'],
    ['mensal', 'Mensal'],
  ];
  const lower = text.toLocaleLowerCase('pt-BR');
  return options.find(([needle]) => lower.includes(needle))?.[1] ?? null;
}

function parseHome(html) {
  const text = textContent(html);
  const mission = between(text, 'Nossa Missão', 'Número mais recente');
  const creationMatch = (mission ?? text).match(
    /(?:criad[oa]|fundad[oa])(?:\s+no\s+ano\s+de|\s+em)?\s+(\d{4})/i,
  );
  return {
    publisher: between(text, 'Publicação de:', 'Área:'),
    area: between(text, 'Área:', 'Versão impressa ISSN:'),
    printIssn:
      text.match(/Versão impressa ISSN:\s*([0-9Xx-]{8,9})/i)?.[1] ?? null,
    onlineIssn:
      text.match(/Versão on-line ISSN:\s*([0-9Xx-]{8,9})/i)?.[1] ?? null,
    mission,
    creationYear: creationMatch ? Number(creationMatch[1]) : null,
    periodicity: detectPeriodicity(mission ?? ''),
    latestLabel: between(text, 'Número mais recente', 'Artigos mais recentes'),
  };
}

function parseIssues(html) {
  const issuePids = [
    ...new Set(
      [...html.matchAll(/script=sci_issuetoc(?:&amp;|&)pid=([^&"']+)/gi)].map(
        (match) => decodeHtml(match[1]),
      ),
    ),
  ];
  const years = issuePids
    .map((pid) => Number(pid.slice(8, 12)))
    .filter((year) => year >= 1900 && year <= 2100);
  return {
    issuePids,
    firstIndexedYear: years.length ? Math.min(...years) : null,
    latestIndexedYear: years.length ? Math.max(...years) : null,
  };
}

async function countArticles(journal) {
  const url = `${BASE_URL}/search_mvp.php?lang=pt&field=journal&q=${encodeURIComponent(journal.pid)}`;
  const html = await fetchText(url, 5);
  const match = html.match(/Total:\s*<strong>\s*([\d.]+)\s*<\/strong>/i);
  if (!match) throw new Error('Total de artigos não encontrado na busca');
  return {
    articleCount: Number(match[1].replaceAll('.', '')),
    articleCountComplete: true,
    failedIssuePages: 0,
  };
}

const catalogHtml = await fetchText(CATALOG_URL);
const catalog = parseCatalog(catalogHtml);
console.log(`Encontrados ${catalog.length} periódicos ativos.`);

const previousPayload = existsSync(outputPath)
  ? JSON.parse(readFileSync(outputPath, 'utf8'))
  : { journals: [] };
const previousById = new Map(previousPayload.journals.map((journal) => [journal.id, journal]));

const journals = await mapLimit(catalog, fullCount ? 1 : 2, async (journal, index) => {
  const homeUrl = `${BASE_URL}/scielo.php?script=sci_serial&pid=${encodeURIComponent(journal.pid)}&lng=pt&nrm=iso`;
  const issuesUrl = `${BASE_URL}/scielo.php?script=sci_issues&pid=${encodeURIComponent(journal.pid)}&lng=pt&nrm=iso`;
  try {
    const previous = previousById.get(journal.pid);
    let home;
    let issues;
    if (previous && !previous.error) {
      home = previous;
      issues = {
        issuePids: [],
        firstIndexedYear: previous.firstIndexedYear,
        latestIndexedYear: previous.latestIndexedYear,
      };
    } else {
      const [homeHtml, issuesHtml] = await Promise.all([fetchText(homeUrl, 5), fetchText(issuesUrl, 5)]);
      home = parseHome(homeHtml);
      issues = parseIssues(issuesHtml);
    }
    const articleStats = fullCount
      ? await countArticles(journal)
      : {
          articleCount: previous?.articleCount ?? null,
          articleCountComplete: previous?.articleCountComplete ?? false,
          failedIssuePages: 0,
        };
    if (fullCount) await new Promise((resolveDelay) => setTimeout(resolveDelay, 650));
    console.log(
      `[${index + 1}/${catalog.length}] ${journal.title}: ${previous && !previous.error ? previous.issueCount : issues.issuePids.length} fascículos${fullCount ? `, ${articleStats.articleCount} documentos` : ''}`,
    );
    return {
      id: journal.pid,
      title: journal.title,
      status: 'Ativo',
      ...home,
      issueCount: previous && !previous.error ? previous.issueCount : issues.issuePids.length || journal.listedIssueCount,
      catalogIssueCount: journal.listedIssueCount,
      firstIndexedYear: issues.firstIndexedYear,
      latestIndexedYear: issues.latestIndexedYear,
      ...articleStats,
      languages: null,
      city: null,
      country: null,
      sourceUrl: homeUrl,
      issuesUrl,
      aboutUrl: `${BASE_URL}/journal_link.php?pid=${encodeURIComponent(journal.pid)}&lng=pt&nrm=iso&page=about`,
    };
  } catch (error) {
    console.warn(`[${index + 1}/${catalog.length}] Falha em ${journal.title}: ${error.message}`);
    return {
      id: journal.pid,
      title: journal.title,
      status: 'Ativo',
      publisher: null,
      area: null,
      printIssn: null,
      onlineIssn: journal.pid,
      mission: null,
      creationYear: null,
      periodicity: null,
      latestLabel: null,
      issueCount: journal.listedIssueCount,
      catalogIssueCount: journal.listedIssueCount,
      firstIndexedYear: null,
      latestIndexedYear: null,
      articleCount: null,
      articleCountComplete: false,
      failedIssuePages: 0,
      languages: null,
      city: null,
      country: null,
      sourceUrl: homeUrl,
      issuesUrl,
      aboutUrl: `${BASE_URL}/journal_link.php?pid=${encodeURIComponent(journal.pid)}&lng=pt&nrm=iso&page=about`,
      error: error.message,
    };
  }
});

const payload = {
  source: {
    name: 'Educ@ — Fundação Carlos Chagas',
    url: CATALOG_URL,
    capturedAt: new Date().toISOString(),
    scope: 'Somente periódicos ativos',
    articleCountsIncluded: fullCount,
  },
  journals: journals.sort((a, b) => a.title.localeCompare(b.title, 'pt-BR')),
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
console.log(`Dados salvos em ${outputPath}.`);
