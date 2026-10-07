"""Atlas Educ@: artigos dos periódicos ativos e auditoria da coleção."""

import csv
import io
import json
from collections import Counter
from datetime import datetime
from html import escape
from pathlib import Path
from zoneinfo import ZoneInfo

import streamlit as st


ROOT = Path(__file__).resolve().parent
DATA = ROOT / "public" / "data"

st.set_page_config(page_title="Atlas Educ@ | Artigos dos periódicos ativos", page_icon="📚", layout="wide")

st.markdown("""
<style>
  .stApp { background: #f4f6f2; color: #17332c; }
  .block-container { max-width: 1500px; padding-top: 1.5rem; }
  h1, h2, h3 { color: #102c25; letter-spacing: -.035em; }
  .atlas-brand { display:flex; align-items:center; gap:14px; padding: 8px 0 24px; border-bottom:1px solid #dde5de; }
  .atlas-logo { display:grid; place-items:center; width:52px; height:52px; border-radius:15px; background:#17332c; color:white; font-weight:800; }
  .atlas-brand strong { font-size:19px; }
  .atlas-brand small { display:block; color:#66756f; font-size:14px; }
  .atlas-eyebrow { color:#bd5b36; letter-spacing:.19em; text-transform:uppercase; font-size:13px; font-weight:800; margin:18px 0 12px; }
  .atlas-title { font-size:clamp(2.6rem,5vw,5rem); font-weight:800; letter-spacing:-.055em; line-height:1.06; margin:0 0 20px; }
  .atlas-lead { font-size:1.2rem; line-height:1.6; color:#596c65; max-width:920px; }
  .atlas-scope { background:white; border:1px solid #e0e7e0; border-radius:20px; padding:24px; box-shadow:0 2px 4px #17332c12; color:#52655e; line-height:1.65; }
  .atlas-scope strong { color:#17332c; }
  .atlas-card { min-height:180px; border-radius:22px; padding:25px 27px; display:flex; flex-direction:column; justify-content:space-between; }
  .atlas-card small { text-transform:uppercase; letter-spacing:.06em; font-weight:800; opacity:.78; }
  .atlas-card b { font-size:clamp(1.7rem,2.4vw,3rem); line-height:1.05; letter-spacing:-.04em; }
  .atlas-card span { font-size:14px; opacity:.78; }
  .atlas-green { background:#17382f; color:white; }
  .atlas-cream { background:#fffdf8; color:#17332c; border:1px solid #e1e8df; }
  .atlas-orange { background:#c7633d; color:white; }
  .atlas-metrics { background:linear-gradient(110deg,#103229,#245d4c); border-radius:28px; padding:26px 32px; color:white; margin-top:28px; }
  .atlas-metrics small { text-transform:uppercase; letter-spacing:.13em; font-weight:800; color:#a9d6c6; }
  .atlas-metrics h2 { color:white; font-size:2.7rem; margin:12px 0; }
  .atlas-metrics p { color:#e1eee7; }
  .atlas-kpi { background:white; border:1px solid #e2e8e1; border-radius:18px; padding:18px; min-height:125px; }
  .atlas-kpi small { display:block; color:#64766e; font-size:13px; }
  .atlas-kpi b { display:block; color:#17332c; font-size:2rem; line-height:1.3; }
  .atlas-kpi span { color:#6b7b75; font-size:12px; }
  div[data-testid="stTabs"] button[role="tab"] { font-weight:700; }
  @media(max-width:700px) { .atlas-card { min-height:130px; } .atlas-metrics { padding:20px; } }
</style>
""", unsafe_allow_html=True)


@st.cache_data
def read_json(path: Path):
    with path.open(encoding="utf-8") as file:
        return json.load(file)


def csv_bytes(rows):
    if not rows:
        return b""
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=rows[0].keys(), extrasaction="ignore")
    writer.writeheader()
    writer.writerows(rows)
    return output.getvalue().encode("utf-8-sig")


def article_rows(articles):
    return [
        {
            "Ano": article.get("year"),
            "Título": article.get("title") or "",
            "Autores": "; ".join(article.get("authors") or []),
            "DOI": article.get("doi") or "",
            "Link": article.get("url") or "",
        }
        for article in articles
    ]


def fmt(value):
    return f"{value:,}".replace(",", ".")


def local_date(value):
    if not value:
        return "não informada"
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(
        ZoneInfo("America/Sao_Paulo")
    ).strftime("%d/%m/%Y, %H:%M")


def card(label, value, note, tone="cream"):
    st.markdown(
        f'<div class="atlas-card atlas-{tone}"><small>{escape(label)}</small>'
        f'<b>{escape(str(value))}</b><span>{escape(note)}</span></div>',
        unsafe_allow_html=True,
    )


def kpi(label, value, note):
    st.markdown(
        f'<div class="atlas-kpi"><small>{escape(label)}</small>'
        f'<b>{escape(str(value))}</b><span>{escape(note)}</span></div>',
        unsafe_allow_html=True,
    )


def show_articles(rows, key):
    if not rows:
        st.info("Nenhum artigo para os filtros selecionados.")
        return
    st.dataframe(
        rows,
        width="stretch",
        hide_index=True,
        column_config={"Link": st.column_config.LinkColumn("Artigo")},
    )
    st.download_button(
        "Baixar resultado em CSV",
        csv_bytes(rows),
        file_name=f"atlas-educa-{key}.csv",
        mime="text/csv",
        key=f"download-{key}",
    )


catalog = read_json(ROOT / "app" / "journals.json")
metrics = read_json(ROOT / "app" / "metrics.json")
processing = read_json(DATA / "processing-status.json")
journals = catalog["journals"]
compared = [j for j in journals if j.get("comparison")]
complete = [j for j in compared if j["comparison"]["status"] == "complete"]
counted = [j for j in journals if j.get("articleCountComplete")]
first_years = [j["firstIndexedYear"] for j in journals if j.get("firstIndexedYear")]

brand, source_button = st.columns([5, 1])
with brand:
    st.markdown('<div class="atlas-brand"><span class="atlas-logo">E@</span><div><strong>Atlas Educ@</strong><small>Artigos dos periódicos ativos</small></div></div>', unsafe_allow_html=True)
with source_button:
    st.link_button("Consultar fonte ↗", catalog["source"]["url"], width="stretch")

hero, scope = st.columns([2.4, 1], gap="large", vertical_alignment="bottom")
with hero:
    st.markdown('<p class="atlas-eyebrow">Base para auditoria</p><h1 class="atlas-title">Artigos dos periódicos ativos no Educ@</h1><p class="atlas-lead">Consulte quando cada revista começou na coleção, quantos artigos foram indexados por ano e quais artigos estão em cada volume e número.</p>', unsafe_allow_html=True)
with scope:
    st.markdown(
        '<div class="atlas-scope"><strong>Escopo exato</strong><br>'
        '<b>Somente artigos científicos</b> de títulos ativos. Editoriais, apresentações, resenhas, entrevistas, erratas e outros tipos documentais foram excluídos.'
        f'<br><small>Coleta: {escape(local_date(catalog["source"].get("capturedAt")))}</small></div>',
        unsafe_allow_html=True,
    )

st.write("")
cards = st.columns(5)
with cards[0]:
    card("Periódicos ativos", fmt(len(journals)), "Coleção atual", "green")
with cards[1]:
    card("Fascículos indexados", fmt(sum(j.get("issueCount") or 0 for j in journals)), "Coleção atual")
with cards[2]:
    card("Artigos", fmt(sum(j.get("articleCount") or 0 for j in counted)) if len(counted) == len(journals) else "Em apuração", f"{len(counted)} de {len(journals)} títulos contados", "orange")
with cards[3]:
    card("Primeiro ano no Educ@", min(first_years) if first_years else "—", "Coleção atual")
with cards[4]:
    card("Cruzamentos OAI", f'{processing["completed"]}/{processing["totalEligible"]}', f'{processing["remaining"]} pendentes', "green")

st.markdown('<div class="atlas-metrics"><small>Recorte dos três anos anteriores a 2026</small><h2>Métricas 2023–2025</h2><p>Compare produção indexada, cobertura da coleta e possíveis lacunas entre os sites oficiais das revistas e o Educ@.</p></div>', unsafe_allow_html=True)
year = st.radio("Ano", metrics["years"], index=0, horizontal=True)
summary = next(item for item in metrics["summary"] if item["year"] == year)
year_key = str(year)
metric_cols = st.columns(4)
with metric_cols[0]:
    kpi(f"Artigos no Educ@ em {year}", fmt(summary["educaArticles"]), f'Somados em {summary["journalsWithData"]} revistas com dados')
with metric_cols[1]:
    kpi("Revistas com dados no ano", f'{summary["journalsWithData"]}/{metrics["totalJournals"]}', "Dado ausente não equivale a zero")
with metric_cols[2]:
    kpi("Artigos nos sites oficiais", fmt(summary["officialArticles"]), f'{summary["comparedJournals"]} revistas cruzadas')
with metric_cols[3]:
    kpi("Candidatos ausentes no Educ@", fmt(summary["missingCandidates"]), "Exigem conferência artigo por artigo")

ranking, trend = st.columns([1.3, 1], gap="large")
with ranking:
    st.subheader(f"Revistas com mais artigos em {year}")
    ranked = sorted(
        [j for j in metrics["journals"] if j["educa"].get(year_key) is not None],
        key=lambda j: j["educa"][year_key],
        reverse=True,
    )[:10]
    st.bar_chart(
        [{"Revista": j["title"], "Artigos": j["educa"][year_key]} for j in reversed(ranked)],
        x="Revista", y="Artigos", horizontal=True, width="stretch",
    )
with trend:
    cohort = [j for j in metrics["journals"] if all(j["educa"].get(str(y)) is not None for y in metrics["years"])]
    st.subheader(f"Evolução das mesmas {len(cohort)} revistas")
    st.caption("Somente revistas com dados nos três anos entram neste gráfico.")
    st.bar_chart(
        [{"Ano": y, "Artigos": sum(j["educa"][str(y)] for j in cohort)} for y in metrics["years"]],
        x="Ano", y="Artigos", width="stretch",
    )
    st.info("Candidatos ausentes vêm do cruzamento com as fontes oficiais e ainda exigem conferência antes de serem tratados como falha de indexação.")

metric_rows = [
    {"Periódico": j["title"], "Editora": j.get("publisher") or "", **{f"Educ@ {y}": j["educa"].get(str(y)) for y in metrics["years"]},
     **{f"Ausentes {y}": j["missing"].get(str(y)) for y in metrics["years"]},
     "Cruzamento": j.get("comparisonStatus") or "não cruzado"}
    for j in metrics["journals"]
]
st.download_button("Baixar métricas 2023–2025 em CSV", csv_bytes(metric_rows), "metricas-periodicos-2023-2025.csv", "text/csv")
st.caption(f'Métricas geradas a partir dos dados salvos em {local_date(metrics.get("generatedAt"))}.')
with st.expander("Ver tabela das métricas por periódico"):
    st.dataframe(metric_rows, width="stretch", hide_index=True)

timeline, coverage = st.columns([1, 1.4], gap="large")
with timeline:
    st.subheader("Início da indexação por década")
    decades = Counter((y // 10) * 10 for y in first_years)
    st.bar_chart([{"Década": d, "Periódicos": n} for d, n in sorted(decades.items())], x="Década", y="Periódicos", width="stretch")
with coverage:
    st.subheader("Cobertura dos dados")
    a, b, c = st.columns(3)
    a.metric("Títulos ativos", fmt(len(journals)))
    b.metric("Fascículos", fmt(sum(j.get("issueCount") or 0 for j in journals)))
    c.metric("Artigos apurados", f"{round(len(counted) / len(journals) * 100)}%")
    st.caption(f'{len(counted)} de {len(journals)} periódicos com contagem completa de artigos.')

if processing.get("running"):
    st.info(f'Auditoria em andamento: {processing["completed"]}/{processing["totalEligible"]} revistas concluídas.')
else:
    st.caption(f'Última atualização da auditoria: {local_date(processing.get("updatedAt"))} · {processing["completed"]}/{processing["totalEligible"]} concluídas.')

overview_tab, journal_tab, missing_tab = st.tabs(["Periódicos", "Anos e artigos", "Auditoria"])

with overview_tab:
    st.subheader("Periódicos e artigos")
    filter_cols = st.columns([2, 1, 1])
    with filter_cols[0]:
        search = st.text_input("Buscar título, ISSN ou editora", key="overview-search")
    with filter_cols[1]:
        areas = sorted({j["area"] for j in journals if j.get("area")})
        area = st.selectbox("Área", ["Todas"] + areas)
    with filter_cols[2]:
        sort = st.selectbox("Ordenar por", ["Título (A–Z)", "Mais fascículos", "Mais artigos", "Início mais recente", "Atualização mais recente"])
    filtered = [
        journal
        for journal in journals
        if (area == "Todas" or journal.get("area") == area)
        and search.casefold() in " ".join(
            str(journal.get(field) or "")
            for field in ("title", "id", "printIssn", "onlineIssn", "publisher")
        ).casefold()
    ]
    sort_fields = {
        "Mais fascículos": "issueCount", "Mais artigos": "articleCount",
        "Início mais recente": "firstIndexedYear", "Atualização mais recente": "latestIndexedYear",
    }
    if sort == "Título (A–Z)":
        filtered.sort(key=lambda j: j["title"].casefold())
    else:
        filtered.sort(key=lambda j: j.get(sort_fields[sort]) or -1, reverse=True)
    rows = [
        {
            "Periódico": j["title"],
            "ISSN": j["id"],
            "Início": j.get("firstIndexedYear"),
            "Último ano": j.get("latestIndexedYear"),
            "Fascículos": j.get("issueCount"),
            "Artigos Educ@": j.get("articleCount") if j.get("articleCountComplete") else None,
            "Auditoria": ("Completa" if j["comparison"]["status"] == "complete" else "Parcial") if j.get("comparison") else "Sem OAI automático",
            "Sem correspondência": j.get("comparison", {}).get("missingCount"),
        }
        for j in filtered
    ]
    st.caption(f"{len(filtered)} de {len(journals)} títulos exibidos. Contagens incompletas aparecem vazias na tabela.")
    st.dataframe(rows, width="stretch", hide_index=True)
    st.download_button("Baixar resumo em CSV", csv_bytes(rows), "periodicos-ativos-artigos-educa.csv", "text/csv")

with journal_tab:
    selected_id = st.selectbox(
        "Selecione um periódico",
        options=[j["id"] for j in journals],
        format_func=lambda value: next(j["title"] for j in journals if j["id"] == value),
    )
    journal = next(j for j in journals if j["id"] == selected_id)
    st.subheader(journal["title"])
    st.caption(f"ISSN {journal['id']} · {journal.get('publisher') or 'Editora não informada'}")
    facts = st.columns(4)
    facts[0].metric("Início no Educ@", journal.get("firstIndexedYear") or "—")
    facts[1].metric("Artigos", fmt(journal.get("articleCount") or 0) if journal.get("articleCountComplete") else "Em apuração")
    facts[2].metric("Último ano", journal.get("latestIndexedYear") or "—")
    facts[3].metric("Fascículos", fmt(journal.get("issueCount") or 0))
    if journal.get("articleCountPartial"):
        st.warning("A coleta de artigos do Educ@ para esta revista é parcial. As contagens abaixo cobrem apenas os registros recuperados.")
    if journal.get("sourceUrl"):
        st.link_button("Abrir no Educ@", journal["sourceUrl"])
    detail_path = DATA / "journals" / f"{selected_id}.json"
    if not detail_path.exists():
        st.warning("Os registros de artigos deste periódico não estão disponíveis na coleta.")
    else:
        detail = read_json(detail_path)
        years = detail.get("years") or []
        counts = [{"Ano": y["year"], "Artigos": y["articleCount"]} for y in sorted(years, key=lambda y: y["year"])]
        if counts:
            st.bar_chart(counts, x="Ano", y="Artigos", width="stretch")
        year_options = sorted({y["year"] for y in years}, reverse=True)
        year = st.selectbox("Ano", ["Todos"] + year_options)
        query = st.text_input("Buscar título, autor ou DOI", key=f"article-search-{selected_id}").casefold().strip()
        selected_issues = [
            (item["year"], issue)
            for item in years
            if year == "Todos" or item["year"] == year
            for issue in item.get("issues", [])
        ]
        articles = [article for _, issue in selected_issues for article in issue.get("articles", [])
                    if query in " ".join([article.get("title") or "", article.get("doi") or "", article.get("date") or ""]
                                      + (article.get("authors") or [])).casefold()]
        st.write(f"{len(articles):,} artigos encontrados".replace(",", "."))
        article_table = [
            {"Ano": issue_year, "Volume": issue.get("volume") or "", "Número": issue.get("number") or "",
             "Título": article.get("title") or "", "Autores": "; ".join(article.get("authors") or []),
             "Data": article.get("date") or "", "DOI": article.get("doi") or "", "Link": article.get("url") or ""}
            for issue_year, issue in selected_issues for article in issue.get("articles", [])
            if query in " ".join([article.get("title") or "", article.get("doi") or "", article.get("date") or ""]
                              + (article.get("authors") or [])).casefold()
        ]
        show_articles(article_table, f"artigos-{selected_id}")
        with st.expander("Ver por ano, volume e número"):
            if year == "Todos":
                st.caption("Selecione um ano acima para navegar pelos fascículos.")
            else:
                visible_issues = [(issue_year, issue) for issue_year, issue in selected_issues
                                  if any(a in articles for a in issue.get("articles", []))]
                if visible_issues:
                    issue_index = st.selectbox(
                        "Volume e número",
                        range(len(visible_issues)),
                        format_func=lambda i: f'v. {visible_issues[i][1].get("volume") or "?"} · n. {visible_issues[i][1].get("number") or "?"} · {len(visible_issues[i][1].get("articles", []))} artigos',
                    )
                    chosen_issue = visible_issues[issue_index][1]
                    issue_articles = [a for a in chosen_issue.get("articles", []) if a in articles]
                    st.dataframe(article_rows(issue_articles), width="stretch", hide_index=True,
                                 column_config={"Link": st.column_config.LinkColumn("Artigo")})

with missing_tab:
    st.subheader("Quais artigos não estão no Educ@?")
    st.caption("Cruzamento por DOI ou título, restrito ao período coletado nas duas fontes.")
    if not compared:
        st.info("Nenhuma comparação disponível.")
    else:
        compared_id = st.selectbox(
            "Selecione um periódico comparado",
            options=[j["id"] for j in compared],
            format_func=lambda value: next(j["title"] for j in compared if j["id"] == value),
        )
        comparison = read_json(DATA / "comparisons" / f"{compared_id}.json")
        if comparison["status"] == "partial":
            st.warning("Comparação parcial: interprete as ausências somente no trecho efetivamente coletado.")
        a, b, c = st.columns(3)
        a.metric("Na fonte oficial, dentro da cobertura", comparison.get("officialInCoverageCount", 0))
        b.metric("Correspondências", comparison.get("matchedCount", 0))
        c.metric("Sem correspondência", comparison.get("missingCount", 0))
        coverage_start = comparison.get("educaCoverageStart")
        coverage_end = comparison.get("educaCoverageEnd")
        st.caption(
            f"Cobertura Educ@: {coverage_start or 'não informada'}–{coverage_end or 'não informada'} · "
            f"Fora da cobertura: {comparison.get('outsideCoverageCount', 0)} · "
            f"Comparado em: {comparison.get('comparedAt', '')[:10]}"
        )
        st.info("Os registros sem correspondência existem na fonte oficial dentro do período coletado, mas a lista ainda requer conferência individual antes de ser tratada como falha de indexação.")
        source = comparison.get("officialSource") or {}
        if source.get("url"):
            st.link_button("Abrir fonte oficial", source["url"])
        missing = comparison.get("missing") or []
        years = sorted({a.get("year") for a in missing if a.get("year") is not None}, reverse=True)
        chosen_year = st.selectbox("Filtrar por ano", ["Todos"] + years, key="missing-year")
        query = st.text_input("Buscar título, autor ou DOI", key="missing-search").casefold().strip()
        filtered_missing = [
            article
            for article in missing
            if (chosen_year == "Todos" or article.get("year") == chosen_year)
            and query in " ".join(
                [article.get("title") or "", article.get("doi") or ""]
                + (article.get("authors") or [])
            ).casefold()
        ]
        st.write(f"{len(filtered_missing):,} registros encontrados".replace(",", "."))
        show_articles(article_rows(filtered_missing), f"ausentes-{compared_id}")
