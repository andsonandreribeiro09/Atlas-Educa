import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const years = [2023, 2024, 2025];
const snapshot = JSON.parse(await readFile(path.join(root, 'app', 'journals.json'), 'utf8'));

async function readJsonIfPresent(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

const journals = [];

for (const journal of snapshot.journals) {
  const educa = Object.fromEntries(years.map((year) => [year, null]));
  for (const item of journal.yearlyCounts ?? []) {
    if (years.includes(item.year)) educa[item.year] = item.articleCount;
  }

  const comparisonPath = journal.comparison?.dataUrl
    ? path.join(root, 'public', journal.comparison.dataUrl.replace(/^\/+/, ''))
    : null;
  const comparison = comparisonPath ? await readJsonIfPresent(comparisonPath) : null;
  const officialPath = path.join(root, 'public', 'data', 'official', `${journal.id}.json`);
  const official = await readJsonIfPresent(officialPath);
  const officialCounts = Object.fromEntries(years.map((year) => [year, null]));
  const missing = Object.fromEntries(years.map((year) => [year, null]));

  if (comparison && official) {
    for (const year of years) {
      const inCoverage = year >= comparison.educaCoverageStart
        && (comparison.educaCoverageEnd == null || year <= comparison.educaCoverageEnd);
      officialCounts[year] = inCoverage
        ? (official.articles ?? []).filter((article) => article.year === year).length
        : null;
      missing[year] = inCoverage
        ? (comparison.missing ?? []).filter((article) => article.year === year).length
        : null;
    }
  }

  journals.push({
    id: journal.id,
    title: journal.title,
    publisher: journal.publisher,
    educa,
    official: officialCounts,
    missing,
    comparisonStatus: comparison?.status ?? null,
  });
}

const summary = years.map((year) => {
  const withEduca = journals.filter((journal) => journal.educa[year] !== null);
  const compared = journals.filter((journal) => journal.missing[year] !== null);
  const counts = withEduca.map((journal) => journal.educa[year]).sort((a, b) => a - b);
  const middle = Math.floor(counts.length / 2);
  const median = counts.length
    ? counts.length % 2
      ? counts[middle]
      : (counts[middle - 1] + counts[middle]) / 2
    : 0;

  return {
    year,
    educaArticles: withEduca.reduce((sum, journal) => sum + journal.educa[year], 0),
    journalsWithData: withEduca.length,
    medianArticles: median,
    comparedJournals: compared.length,
    officialArticles: compared.reduce((sum, journal) => sum + journal.official[year], 0),
    missingCandidates: compared.reduce((sum, journal) => sum + journal.missing[year], 0),
  };
});

const metrics = {
  generatedAt: new Date().toISOString(),
  years,
  totalJournals: journals.length,
  summary,
  journals,
};

await writeFile(path.join(root, 'app', 'metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`);
console.log(`Métricas ${years.join('–')} atualizadas para ${journals.length} periódicos.`);
