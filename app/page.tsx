'use client';

import { useEffect, useMemo, useState } from 'react';
import data from './journals.json';

type BaseJournal = (typeof data.journals)[number];
type YearCount = { year: number; articleCount: number; issueCount: number };
type ComparisonSummary = { status: 'complete' | 'partial'; comparedAt: string; dataUrl: string; officialArticleCount: number; officialInCoverageCount: number; matchedCount: number; missingCount: number; outsideCoverageCount: number; educaCoverageStart?: number; educaCoverageEnd?: number | null; educaCollectionStatus?: 'complete' | 'partial'; officialCollectionStatus?: 'complete' | 'partial'; officialCoverageStart?: number; officialCoverageEnd?: number };
type Journal = BaseJournal & { detailsUrl?: string; yearlyCounts?: YearCount[]; searchArticleCount?: number | null; articleCountDifference?: number | null; articleCountPartial?: boolean; officialSiteUrl?: string; officialOaiUrl?: string | null; comparison?: ComparisonSummary };
type ProcessingJournal = { id: string; title: string; status: 'processing' | 'complete' | 'partial' | 'queued' | 'no_oai' | 'failed'; phase: string | null; source: string | null; page: number | null; issueTotal?: number | null; records: number | null; missingCount: number | null; error: string | null };
type ProcessingStatus = { updatedAt: string; running: boolean; totalJournals: number; totalEligible: number; completed: number; remaining: number; current: { journalId: string; title: string; phase: string; source: string | null; page: number; issueTotal?: number; records: number; position?: number; queueTotal?: number; retryAttempt?: number; httpStatus?: number | null } | null; journals: ProcessingJournal[] };
type Article = { id: string; title: string; authors: string[]; date: string | null; year: number; volume: string | null; number: string | null; issueKey: string; type: string; languages: string[]; doi: string | null; url: string; source: string | null };
type Issue = { key: string; volume: string | null; number: string | null; articleCount: number; articles: Article[] };
type DetailYear = { year: number; articleCount: number; issueCount: number; issues: Issue[] };
type JournalDetail = { articleCount: number; firstYear: number | null; latestYear: number | null; years: DetailYear[] };
type MissingArticle = { id: string; title: string; authors: string[]; date: string | null; year: number; volume: string | null; number: string | null; doi: string | null; url: string | null; source: string | null };
type ComparisonDetail = { status: 'complete' | 'partial'; comparedAt: string; officialSource: { name: string; url: string; oaiUrl: string }; educaCollectionStatus?: 'complete' | 'partial'; officialCollectionStatus?: 'complete' | 'partial'; educaCoverageStart: number; educaCoverageEnd: number | null; officialCoverageStart?: number; officialCoverageEnd?: number; officialArticleCount: number; officialInCoverageCount: number; educaArticleCount: number; matchedCount: number; missingCount: number; outsideCoverageCount: number; matchingMethod: string; missing: MissingArticle[] };
type SortKey = 'title' | 'issueCount' | 'articleCount' | 'firstIndexedYear' | 'latestIndexedYear';
const formatNumber = new Intl.NumberFormat('pt-BR');

function show(input: unknown, fallback = 'Não informado') {
  return input === null || input === undefined || input === '' ? fallback : String(input);
}

function csvCell(input: unknown) {
  return `"${String(input ?? '').replaceAll('"', '""')}"`;
}

function downloadCsv(filename: string, rows: unknown[][]) {
  const csv = rows.map((row) => row.map(csvCell).join(';')).join('\n');
  const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function Home() {
  const journals = data.journals as Journal[];
  const [query, setQuery] = useState('');
  const [area, setArea] = useState('Todas');
  const [sort, setSort] = useState<SortKey>('title');
  const [selected, setSelected] = useState<Journal | null>(null);
  const [processing, setProcessing] = useState<ProcessingStatus | null>(null);

  useEffect(() => {
    let active = true;
    const loadStatus = () => fetch(`/data/processing-status.json?t=${Date.now()}`, { cache: 'no-store' })
      .then((response) => response.ok ? response.json() as Promise<ProcessingStatus> : null)
      .then((status) => { if (active && status) setProcessing(status); })
      .catch(() => undefined);
    loadStatus();
    const timer = window.setInterval(loadStatus, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  const areas = useMemo(() => ['Todas', ...Array.from(new Set(journals.map((journal) => journal.area).filter(Boolean))).sort()] as string[], [journals]);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('pt-BR');
    return journals.filter((journal) => {
      const haystack = [journal.title, journal.publisher, journal.printIssn, journal.onlineIssn].filter(Boolean).join(' ').toLocaleLowerCase('pt-BR');
      return (area === 'Todas' || journal.area === area) && (!normalized || haystack.includes(normalized));
    }).sort((a, b) => {
      if (sort === 'title') return a.title.localeCompare(b.title, 'pt-BR');
      return ((b[sort] as number | null) ?? -1) - ((a[sort] as number | null) ?? -1);
    });
  }, [area, journals, query, sort]);

  const totalIssues = journals.reduce((sum, journal) => sum + (journal.issueCount ?? 0), 0);
  const counted = journals.filter((journal) => journal.articleCountComplete);
  const totalArticles = counted.reduce((sum, journal) => sum + (journal.articleCount ?? 0), 0);
  const completeMetadata = journals.filter((journal) => !journal.error).length;
  const compared = journals.filter((journal) => journal.comparison?.status === 'complete');
  const processingById = useMemo(() => new Map((processing?.journals ?? []).map((journal) => [journal.id, journal])), [processing]);
  const years = journals.map((journal) => journal.firstIndexedYear).filter((year): year is number => Boolean(year));
  const earliestYear = years.length ? Math.min(...years) : null;
  const decades = useMemo(() => {
    const counts = new Map<number, number>();
    journals.forEach((journal) => {
      if (!journal.firstIndexedYear) return;
      const decade = Math.floor(journal.firstIndexedYear / 10) * 10;
      counts.set(decade, (counts.get(decade) ?? 0) + 1);
    });
    const entries = [...counts.entries()].sort(([a], [b]) => a - b);
    const max = Math.max(1, ...entries.map(([, count]) => count));
    return entries.map(([decade, count]) => ({ decade, count, width: `${(count / max) * 100}%` }));
  }, [journals]);

  function exportCsv() {
    const header = ['Periódico', 'ISSN impresso', 'ISSN online', 'Instituição/Editora', 'Área', 'Ano de criação', 'Início no Educ@', 'Último ano', 'Fascículos', 'Artigos', 'Periodicidade', 'Fonte'];
    const rows = journals.map((journal) => [journal.title, journal.printIssn, journal.onlineIssn, journal.publisher, journal.area, journal.creationYear, journal.firstIndexedYear, journal.latestIndexedYear, journal.issueCount, journal.articleCount, journal.periodicity, journal.sourceUrl]);
    downloadCsv('periodicos-ativos-artigos-educa.csv', [header, ...rows]);
  }

  return <main className="min-h-screen bg-[#f4f6f2] text-[#17332c]">
    <header className="border-b border-[#17332c]/10 bg-[#f9faf7]"><div className="mx-auto flex max-w-[1480px] items-center justify-between gap-6 px-5 py-5 lg:px-10">
      <div className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl bg-[#17332c] text-sm font-bold text-white">E@</span><div><p className="text-sm font-bold">Atlas Educ@</p><p className="text-xs text-[#65736e]">Artigos dos periódicos ativos</p></div></div>
      <a className="source-link" href={data.source.url} target="_blank" rel="noreferrer">Consultar fonte <span>↗</span></a>
    </div></header>

    <section className="mx-auto max-w-[1480px] px-5 pb-8 pt-10 lg:px-10 lg:pt-14"><div className="grid gap-8 xl:grid-cols-[1.45fr_.55fr] xl:items-end">
      <div><p className="mb-3 text-xs font-bold uppercase tracking-[0.2em] text-[#c05d36]">Base para auditoria</p><h1 className="max-w-4xl text-4xl font-semibold leading-[1.05] tracking-[-0.045em] text-[#102c25] sm:text-5xl lg:text-6xl">Artigos dos periódicos ativos no Educ@</h1><p className="mt-5 max-w-3xl text-base leading-7 text-[#5b6b65] sm:text-lg">Consulte quando cada revista começou na coleção, quantos artigos foram indexados por ano e quais artigos estão em cada volume e número.</p></div>
      <div className="rounded-2xl border border-[#17332c]/10 bg-white p-5 text-sm leading-6 text-[#5b6b65] shadow-sm"><p className="font-semibold text-[#17332c]">Escopo exato</p><p className="mt-1"><strong>Somente artigos científicos</strong> de títulos ativos. Editoriais, apresentações, resenhas, entrevistas, erratas e outros tipos documentais foram excluídos.</p><p className="mt-3 text-xs text-[#7b8984]">Coleta: {new Date(data.source.capturedAt).toLocaleString('pt-BR')}</p></div>
    </div></section>

    <section className="mx-auto grid max-w-[1480px] grid-cols-2 gap-3 px-5 lg:grid-cols-5 lg:px-10">
      <Metric label="Periódicos ativos" value={formatNumber.format(journals.length)} tone="green" />
      <Metric label="Fascículos indexados" value={formatNumber.format(totalIssues)} tone="cream" />
      <Metric label="Artigos" value={counted.length === journals.length ? formatNumber.format(totalArticles) : 'Em apuração'} note={`${counted.length} de ${journals.length} títulos contados`} tone="orange" />
      <Metric label="Primeiro ano no Educ@" value={earliestYear ? String(earliestYear) : '—'} tone="cream" />
      <Metric
        label="Cruzamentos OAI"
        value={processing ? `${processing.completed}/${processing.totalEligible}` : `${compared.length}/${journals.length}`}
        note={processing ? `${processing.remaining} pendentes` : 'Revista x Educ@'}
        tone="green"
      />
    </section>

    <section className="mx-auto grid max-w-[1480px] gap-5 px-5 py-8 lg:grid-cols-[.72fr_1.28fr] lg:px-10">
      <article className="panel"><div className="panel-heading"><div><p className="eyebrow">Distribuição temporal</p><h2>Início da indexação por década</h2></div><span className="tag">{years.length} identificados</span></div><div className="mt-6 space-y-4">{decades.map(({ decade, count, width }) => <div key={decade} className="grid grid-cols-[54px_1fr_26px] items-center gap-3 text-sm"><span className="font-medium text-[#40534d]">{decade}</span><span className="h-2.5 overflow-hidden rounded-full bg-[#e8ece6]"><span className="block h-full rounded-full bg-[#2d705d]" style={{ width }} /></span><span className="text-right font-semibold tabular-nums">{count}</span></div>)}{!decades.length && <p className="empty-copy">Os anos de início ainda estão em apuração.</p>}</div></article>
      <article className="panel"><div className="panel-heading"><div><p className="eyebrow">Cobertura dos dados</p><h2>O que este painel confirma</h2></div></div><div className="mt-6 grid gap-3 sm:grid-cols-3"><Coverage label="Status" value="100%" detail={`${journals.length} títulos ativos`} /><Coverage label="Fascículos" value="100%" detail={`${formatNumber.format(totalIssues)} registros`} /><Coverage label="Artigos" value={`${Math.round((counted.length / journals.length) * 100)}%`} detail="Registros do tipo artigo" muted={counted.length < journals.length} /></div>{completeMetadata < journals.length && <div className="mt-4 rounded-xl bg-[#fff4e8] px-4 py-3 text-sm text-[#8a4a2d]">Alguns detalhes estão temporariamente indisponíveis na fonte; esses campos aparecem como “não informado”.</div>}</article>
    </section>

    <section className="mx-auto max-w-[1480px] px-5 pb-5 lg:px-10">
      <ProcessingPanel status={processing} />
    </section>

    <section className="mx-auto max-w-[1480px] px-5 pb-16 lg:px-10"><div className="overflow-hidden rounded-[22px] border border-[#17332c]/10 bg-white shadow-sm">
      <div className="border-b border-[#17332c]/10 p-5 lg:p-6"><div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end"><div><p className="eyebrow">Base detalhada</p><h2 className="mt-1 text-2xl font-semibold tracking-[-0.025em]">Periódicos e artigos</h2><p className="mt-1 text-sm text-[#6e7d78]">{filtered.length} de {journals.length} títulos exibidos</p></div><button className="download-button" onClick={exportCsv} type="button">Baixar resumo CSV <span>↓</span></button></div>
        <div className="mt-5 grid gap-3 md:grid-cols-[1fr_240px_220px]"><label className="field"><span>Buscar</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Título, ISSN ou instituição" /></label><label className="field"><span>Área</span><select value={area} onChange={(event) => setArea(event.target.value)}>{areas.map((item) => <option key={item}>{item}</option>)}</select></label><label className="field"><span>Ordenar por</span><select value={sort} onChange={(event) => setSort(event.target.value as SortKey)}><option value="title">Título (A–Z)</option><option value="issueCount">Mais fascículos</option><option value="articleCount">Mais artigos</option><option value="firstIndexedYear">Início mais recente</option><option value="latestIndexedYear">Atualização mais recente</option></select></label></div>
      </div>
      <div className="overflow-x-auto"><table className="metadata-table"><thead><tr><th>Periódico</th><th>ISSN</th><th>Início no Educ@</th><th>Último ano</th><th>Fascículos</th><th>Artigos</th><th>Auditoria</th><th><span className="sr-only">Detalhes</span></th></tr></thead><tbody>{filtered.map((journal) => <tr key={journal.id}>
        <td><p className="max-w-[420px] font-semibold leading-5 text-[#17332c]">{journal.title}</p><p className="mt-1 max-w-[420px] truncate text-xs text-[#7b8984]">{show(journal.publisher)}</p></td>
        <td className="whitespace-nowrap text-sm"><p>{show(journal.onlineIssn, '—')}</p>{journal.printIssn && <p className="text-xs text-[#84918d]">Imp. {journal.printIssn}</p>}</td>
        <td className="start-year tabular-nums">{show(journal.firstIndexedYear, '—')}</td><td className="tabular-nums">{show(journal.latestIndexedYear, '—')}</td><td className="font-semibold tabular-nums">{formatNumber.format(journal.issueCount ?? 0)}</td><td className="font-semibold tabular-nums">{journal.articleCountComplete ? formatNumber.format(journal.articleCount ?? 0) : journal.articleCountPartial ? <span className="partial-count"><span className="pending">{formatNumber.format(journal.articleCount ?? 0)} coletados</span><small>parcial: {journal.comparison?.educaCoverageStart}{journal.comparison?.educaCoverageEnd && journal.comparison.educaCoverageEnd !== journal.comparison.educaCoverageStart ? `–${journal.comparison.educaCoverageEnd}` : ''}</small></span> : <span className="pending">Apurando</span>}</td><td><AuditStatusBadge journal={journal} processing={processingById.get(journal.id)} /></td>
        <td><button className="details-button" onClick={() => setSelected(journal)} type="button">Ver anos e artigos</button></td>
      </tr>)}</tbody></table>{!filtered.length && <div className="p-10 text-center text-sm text-[#6e7d78]">Nenhum periódico encontrado com esses filtros.</div>}</div>
    </div></section>

    {selected && <JournalDrawer journal={selected} onClose={() => setSelected(null)} />}
    <footer className="border-t border-[#17332c]/10 bg-[#e9eee8] px-5 py-7 text-sm text-[#66756f] lg:px-10"><div className="mx-auto flex max-w-[1480px] flex-col justify-between gap-2 sm:flex-row"><p>Artigos coletados do repositório OAI do Educ@ — Fundação Carlos Chagas.</p><p>Base para auditoria · {new Date(data.source.capturedAt).toLocaleDateString('pt-BR')}</p></div></footer>
  </main>;
}

function phaseLabel(phase: string | null | undefined) {
  if (phase === 'collecting_educa') return 'Lendo artigos no Educ@';
  if (phase === 'collecting_educa_issues') return 'Lendo fascículos em “Todos os números”';
  if (phase === 'repairing_issue_metadata') return 'Conferindo volume e número dos fascículos';
  if (phase === 'loading_saved_educa') return 'Carregando artigos já coletados do Educ@';
  if (phase === 'loading_saved_official') return 'Carregando a base oficial já coletada';
  if (phase === 'collecting_official') return 'Lendo artigos no site oficial';
  if (phase === 'retrying_source') return 'Fonte temporariamente indisponível; tentando novamente';
  if (phase === 'comparing') return 'Cruzando as duas listas';
  if (phase === 'starting') return 'Preparando a coleta';
  return 'Processando';
}

function ProcessingPanel({ status }: { status: ProcessingStatus | null }) {
  if (!status) return <article className="processing-panel processing-panel-loading"><div><p className="eyebrow">Andamento da auditoria</p><h2>Carregando o estado do processamento…</h2></div></article>;
  const percentage = status.totalEligible ? Math.round((status.completed / status.totalEligible) * 100) : 0;
  return <article className={`processing-panel ${status.running ? 'processing-panel-running' : ''}`}>
    <div className="processing-heading">
      <div><p className="eyebrow">Andamento da auditoria</p><h2>{status.current ? `Processando agora: ${status.current.title}` : status.running ? 'Preparando o próximo periódico' : 'Processamento pausado ou concluído'}</h2>
        <p>{status.current ? `${phaseLabel(status.current.phase)}${status.current.page ? status.current.source === 'educa_issues' ? ` · fascículo ${status.current.page}/${status.current.issueTotal ?? '?'}` : ` · página ${status.current.page}` : ''}${status.current.records !== null ? ` · ${formatNumber.format(status.current.records)} artigos acumulados` : ''}${status.current.retryAttempt ? ` · tentativa ${status.current.retryAttempt}/${status.current.source === 'educa_issues' ? 12 : 3}` : ''}${status.current.httpStatus ? ` · HTTP ${status.current.httpStatus}` : ''}` : `${status.completed} de ${status.totalEligible} periódicos com OAI concluídos.`}</p>
      </div>
      <span className={`live-indicator ${status.running ? 'is-running' : ''}`}><i />{status.running ? 'Em execução' : 'Parado'}</span>
    </div>
    <div className="processing-summary"><strong>{status.completed}/{status.totalEligible}</strong><span className="processing-track"><span style={{ width: `${percentage}%` }} /></span><b>{percentage}%</b><small>{status.remaining} pendentes</small></div>
    <p className="processing-updated">Atualização automática a cada 5 segundos · última leitura {new Date(status.updatedAt).toLocaleTimeString('pt-BR')}</p>
  </article>;
}

function AuditStatusBadge({ journal, processing }: { journal: Journal; processing?: ProcessingJournal }) {
  if (processing?.status === 'processing') return <span className="audit-processing"><i />Processando agora<span>{phaseLabel(processing.phase)}{processing.page ? processing.source === 'educa_issues' ? ` · fasc. ${processing.page}/${processing.issueTotal ?? '?'}` : ` · pág. ${processing.page}` : ''}</span></span>;
  if (processing?.status === 'complete') return <span className="audit-complete">Cruzada · {processing.missingCount ?? journal.comparison?.missingCount ?? 0} ausentes</span>;
  if (processing?.status === 'partial') return <span className="audit-partial" title="Resultado limitado ao trecho efetivamente coletado">Parcial · {processing.missingCount ?? journal.comparison?.missingCount ?? 0} ausentes confirmados</span>;
  if (processing?.status === 'queued') return <span className="audit-queued">Na fila</span>;
  if (processing?.status === 'failed') return <span className="audit-failed" title={processing.error ?? undefined}>Falha temporária</span>;
  if (processing?.status === 'no_oai') return <span className="audit-no-oai">Sem OAI automático</span>;
  if (journal.comparison?.status === 'complete') return <span className="audit-complete">Cruzada · {journal.comparison.missingCount} ausentes</span>;
  if (journal.comparison?.status === 'partial') return <span className="audit-partial" title="Resultado limitado ao trecho efetivamente coletado">Parcial · {journal.comparison.missingCount} ausentes confirmados</span>;
  return <span className="audit-waiting">Aguardando processamento</span>;
}

function JournalDrawer({ journal, onClose }: { journal: Journal; onClose: () => void }) {
  const [detail, setDetail] = useState<JournalDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [articleQuery, setArticleQuery] = useState('');
  const [comparison, setComparison] = useState<ComparisonDetail | null>(null);
  const [comparisonLoading, setComparisonLoading] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setDetail(null);
    fetch(journal.detailsUrl ?? `/data/journals/${journal.id}.json`, { signal: controller.signal })
      .then((response) => { if (!response.ok) throw new Error('Não foi possível abrir os artigos desta revista.'); return response.json() as Promise<JournalDetail>; })
      .then(setDetail)
      .catch((reason: Error) => { if (reason.name !== 'AbortError') setError(reason.message); })
      .finally(() => setLoading(false));
    setComparison(null);
    if (journal.comparison?.dataUrl) {
      setComparisonLoading(true);
      fetch(journal.comparison.dataUrl, { signal: controller.signal })
        .then((response) => { if (!response.ok) throw new Error('Cruzamento indisponível.'); return response.json() as Promise<ComparisonDetail>; })
        .then(setComparison)
        .catch(() => setComparison(null))
        .finally(() => setComparisonLoading(false));
    } else setComparisonLoading(false);
    return () => controller.abort();
  }, [journal]);

  const filteredYears = useMemo(() => {
    if (!detail) return [];
    const needle = articleQuery.trim().toLocaleLowerCase('pt-BR');
    if (!needle) return detail.years;
    return detail.years.map((year) => ({ ...year, issues: year.issues.map((issue) => ({ ...issue, articles: issue.articles.filter((article) => [article.title, ...article.authors, article.doi, article.date].filter(Boolean).join(' ').toLocaleLowerCase('pt-BR').includes(needle)) })).filter((issue) => issue.articles.length) })).filter((year) => year.issues.length);
  }, [articleQuery, detail]);
  const visibleArticles = filteredYears.reduce((sum, year) => sum + year.issues.reduce((subtotal, issue) => subtotal + issue.articles.length, 0), 0);
  const maxYearArticles = Math.max(1, ...(journal.yearlyCounts ?? []).map((item) => item.articleCount));
  const internalDifference = journal.articleCountDifference ?? 0;

  function exportArticles() {
    if (!detail) return;
    const header = ['Periódico', 'Ano', 'Volume', 'Número', 'Título', 'Autores', 'Data', 'Tipo', 'DOI', 'Link no Educ@'];
    const rows = detail.years.flatMap((year) => year.issues.flatMap((issue) => issue.articles.map((article) => [journal.title, year.year, issue.volume, issue.number, article.title, article.authors.join(' | '), article.date, 'Artigo', article.doi, article.url])));
    downloadCsv(`${journal.id}-artigos-educa.csv`, [header, ...rows]);
  }

  function exportMissing() {
    if (!comparison) return;
    const header = ['Periódico', 'Situação', 'Ano', 'Volume', 'Número', 'Título', 'Autores', 'Data', 'DOI', 'Link na revista'];
    const rows = comparison.missing.map((article) => [journal.title, 'Ausente no Educ@', article.year, article.volume, article.number, article.title, article.authors.join(' | '), article.date, article.doi, article.url]);
    downloadCsv(`${journal.id}-ausentes-no-educa.csv`, [header, ...rows]);
  }

  return <div className="drawer-backdrop" role="presentation" onMouseDown={onClose}><aside className="drawer" role="dialog" aria-modal="true" aria-label={`Artigos de ${journal.title}`} onMouseDown={(event) => event.stopPropagation()}>
    <div className="sticky top-0 z-10 flex items-start justify-between gap-5 border-b border-[#17332c]/10 bg-[#fbfcf9]/95 p-6 backdrop-blur"><div><span className="tag tag-active">Ativo · somente artigos</span><h2 className="mt-3 text-2xl font-semibold leading-8 tracking-[-0.025em]">{journal.title}</h2></div><button className="close-button" onClick={onClose} aria-label="Fechar ficha" type="button">×</button></div>
    <div className="space-y-7 p-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4"><Fact label="Início no Educ@" value={show(journal.firstIndexedYear)} highlight /><Fact label={journal.articleCountPartial ? 'Artigos já coletados' : 'Total de artigos'} value={journal.articleCountComplete || journal.articleCountPartial ? formatNumber.format(journal.articleCount ?? 0) : 'Em apuração'} highlight /><Fact label="Último ano" value={show(journal.latestIndexedYear)} /><Fact label="Fascículos" value={formatNumber.format(journal.issueCount ?? 0)} /></div>
      {journal.articleCountPartial && <div className="audit-warning"><strong>Coleta parcial do Educ@:</strong> o portal registra esta revista de {show(journal.firstIndexedYear)} a {show(journal.latestIndexedYear)}, mas esta tentativa recuperou somente {formatNumber.format(journal.articleCount ?? 0)} artigos de {journal.comparison?.educaCoverageStart ?? 'um trecho da coleção'}{journal.comparison?.educaCoverageEnd && journal.comparison.educaCoverageEnd !== journal.comparison.educaCoverageStart ? ` a ${journal.comparison.educaCoverageEnd}` : ''}. As contagens abaixo ainda não representam todo o período.</div>}
      <div><div className="flex flex-wrap items-end justify-between gap-3"><div><p className="fact-label">Quantidade de artigos publicados por ano</p><p className="mt-1 text-sm text-[#66756f]">{journal.articleCountPartial ? 'Cada barra mostra apenas os artigos recuperados nesta coleta parcial.' : 'Cada barra mostra o total indexado no Educ@.'}</p></div>{detail && <button className="download-button" onClick={exportArticles} type="button">Baixar todos os artigos em CSV ↓</button>}</div><div className="year-counts mt-4">{(journal.yearlyCounts ?? []).map((item) => <div className="year-count-row" key={item.year}><strong>{item.year}</strong><span className="year-bar-track"><span className="year-bar-fill" style={{ width: `${Math.max(2, (item.articleCount / maxYearArticles) * 100)}%` }} /></span><b>{formatNumber.format(item.articleCount)} artigos</b><small>{item.issueCount} fasc.</small></div>)}{!journal.yearlyCounts?.length && <p className="empty-copy">A contagem anual está sendo carregada.</p>}</div></div>
      {comparisonLoading && <div className="loading-box">Carregando o cruzamento com a base oficial da revista…</div>}
      {comparison ? <section className="comparison-panel">
        <div className="comparison-heading"><div><p className="eyebrow">Cruzamento com a base oficial</p><h3>Quais artigos não estão no Educ@?</h3><p>{comparison.officialCollectionStatus === 'partial' ? `Cruzamento parcial com os ${formatNumber.format(comparison.officialArticleCount)} artigos oficiais já coletados, cobrindo ${comparison.officialCoverageStart} a ${comparison.officialCoverageEnd}.` : comparison.status === 'partial' ? `Cruzamento parcial usando os registros já coletados do Educ@ entre ${comparison.educaCoverageStart} e ${comparison.educaCoverageEnd}.` : `O painel comparou os artigos do site da revista com os registros do Educ@ entre ${comparison.educaCoverageStart} e ${comparison.educaCoverageEnd}.`}</p></div><span className={`comparison-badge ${comparison.status === 'partial' ? 'comparison-badge-partial' : ''}`}>{comparison.status === 'partial' ? 'Auditoria parcial' : 'Auditoria concluída'}</span></div>
        <div className="comparison-metrics"><Fact label="Localizados no Educ@" value={formatNumber.format(comparison.matchedCount)} /><Fact label={comparison.status === 'partial' ? 'Ausentes confirmados no trecho' : 'Ausentes no Educ@'} value={formatNumber.format(comparison.missingCount)} highlight /><Fact label={`Fora de ${comparison.educaCoverageStart}–${comparison.educaCoverageEnd}`} value={formatNumber.format(comparison.outsideCoverageCount)} /></div>
        <div className="comparison-explain"><strong>Como ler:</strong> {comparison.officialCollectionStatus === 'partial' && comparison.officialCoverageEnd && comparison.officialCoverageEnd < comparison.educaCoverageStart ? `A coleta oficial disponível termina em ${comparison.officialCoverageEnd}, enquanto a cobertura encontrada no Educ@ começa em ${comparison.educaCoverageStart}. Ainda não há período sobreposto; por isso nenhum artigo pode ser confirmado como ausente nesta etapa.` : <>“Ausentes no Educ@” são artigos existentes na base oficial da revista, dentro do período efetivamente coletado, sem correspondência por DOI ou título. Os registros fora de {comparison.educaCoverageStart}–{comparison.educaCoverageEnd} ficam separados e não entram como ausência.</>}</div>
        <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm font-semibold text-[#17332c]">Relação dos {formatNumber.format(comparison.missingCount)} {comparison.status === 'partial' ? 'ausentes confirmados no trecho coletado' : 'artigos ausentes'}</p><button className="download-button" onClick={exportMissing} type="button">Baixar ausentes em CSV ↓</button></div>
        <div className="missing-list">{comparison.missing.map((article) => <article className="missing-row" key={article.id}><div><span className="missing-status">Ausente no Educ@</span><b>{article.year}</b></div><a href={article.url ?? comparison.officialSource.url} target="_blank" rel="noreferrer">{article.title} ↗</a><p>{article.authors.length ? article.authors.join('; ') : 'Autoria não informada'}</p><small>{[article.volume && `v. ${article.volume}`, article.number && `n. ${article.number}`, article.doi && `DOI ${article.doi}`].filter(Boolean).join(' · ') || 'Metadados de volume e número não informados'}</small></article>)}</div>
        <p className="comparison-source">Fonte de conferência: <a href={comparison.officialSource.url} target="_blank" rel="noreferrer">{comparison.officialSource.name} ↗</a> · Cruzamento em {new Date(comparison.comparedAt).toLocaleString('pt-BR')}</p>
      </section> : <div className="audit-note"><strong>Comparação externa ainda não realizada:</strong> os artigos desta revista já foram listados no Educ@, mas ainda falta importar a base oficial da revista. Até esse cruzamento ser concluído, não é possível afirmar qual artigo está ausente.</div>}
      {internalDifference !== 0 && <details className="internal-check"><summary>Ver diferença entre duas contagens internas do Educ@</summary><p>O OAI registra {formatNumber.format(journal.articleCount ?? 0)} artigos; a busca geral retorna {formatNumber.format(journal.searchArticleCount ?? 0)} documentos. Essa diferença <strong>não identifica artigos ausentes</strong> e é apresentada somente como controle de consistência da própria plataforma.</p></details>}
      <div className="grid gap-4 sm:grid-cols-2"><TextFact label="ISSN on-line" value={show(journal.onlineIssn)} /><TextFact label="ISSN impresso" value={show(journal.printIssn)} /><TextFact label="Instituição/Editora" value={show(journal.publisher)} /><TextFact label="Área" value={show(journal.area)} /></div>
      <div className="border-t border-[#17332c]/10 pt-7"><div className="detail-toolbar"><div><p className="eyebrow">Relação completa</p><h3>Ano → volume → número → artigos</h3></div><label className="field article-search"><span>Localizar artigo</span><input value={articleQuery} onChange={(event) => setArticleQuery(event.target.value)} placeholder="Título, autor, DOI ou data" /></label></div>
        {articleQuery && <p className="mt-3 text-sm text-[#66756f]">{formatNumber.format(visibleArticles)} artigo(s) encontrado(s).</p>}
        {loading && <div className="loading-box">Carregando a relação de artigos…</div>}{error && <div className="error-box">{error}</div>}
        {!loading && !error && <div className="mt-5 space-y-3">{filteredYears.map((year, index) => <details className="year-section" key={year.year} open={index === 0 || Boolean(articleQuery)}><summary><span className="year-chevron">›</span><strong>{year.year}</strong><span>{formatNumber.format(articleQuery ? year.issues.reduce((sum, issue) => sum + issue.articles.length, 0) : year.articleCount)} artigos</span><small>{year.issueCount} fascículos</small></summary><div className="year-content">{year.issues.map((issue) => <section className="issue-group" key={issue.key}><header><div><span>Volume {show(issue.volume, 'não informado')}</span><strong>Número {show(issue.number, 'não informado')}</strong></div><b>{formatNumber.format(issue.articles.length)} artigos</b></header><ol className="article-list">{issue.articles.map((article, articleIndex) => <li className="article-row" key={`${article.id}-${articleIndex}`}><a href={article.url} target="_blank" rel="noreferrer">{article.title} <span aria-hidden="true">↗</span></a><p>{article.authors.length ? article.authors.join('; ') : 'Autoria não informada'}</p><div><span>{show(article.date, String(year.year))}</span>{article.doi && <a href={`https://doi.org/${article.doi}`} target="_blank" rel="noreferrer">DOI {article.doi}</a>}<em>Artigo</em></div></li>)}</ol></section>)}</div></details>)}{!filteredYears.length && <div className="loading-box">Nenhum artigo corresponde a essa busca.</div>}</div>}
      </div>
      <div className="grid gap-2 sm:grid-cols-2"><a className="drawer-link" href={journal.sourceUrl} target="_blank" rel="noreferrer">Página do periódico no Educ@ <span>↗</span></a><a className="drawer-link" href={journal.issuesUrl} target="_blank" rel="noreferrer">Todos os fascículos <span>↗</span></a></div>
    </div>
  </aside></div>;
}

function Metric({ label, value, note, tone }: { label: string; value: string; note?: string; tone: 'green' | 'cream' | 'orange' }) { return <article className={`metric metric-${tone}`}><p>{label}</p><strong>{value}</strong><span>{note ?? 'Coleção atual'}</span></article>; }
function Coverage({ label, value, detail, muted = false }: { label: string; value: string; detail: string; muted?: boolean }) { return <div className={`coverage ${muted ? 'coverage-muted' : ''}`}><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>; }
function Fact({ label, value, highlight = false }: { label: string; value: string; highlight?: boolean }) { return <div className={`fact ${highlight ? 'fact-highlight' : ''}`}><p className="fact-label">{label}</p><p className="mt-1 font-semibold">{value}</p></div>; }
function TextFact({ label, value }: { label: string; value: string }) { return <div><p className="fact-label">{label}</p><p className="mt-1 text-sm leading-6 text-[#40534d]">{value}</p></div>; }
