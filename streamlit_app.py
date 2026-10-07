"""Explorador dos dados já processados do Atlas Educ@."""

import csv
import io
import json
from pathlib import Path

import streamlit as st


ROOT = Path(__file__).resolve().parent
DATA = ROOT / "public" / "data"

st.set_page_config(page_title="Atlas Educ@ | Exploração", page_icon="📚", layout="wide")


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


def show_articles(rows, key):
    if not rows:
        st.info("Nenhum artigo para os filtros selecionados.")
        return
    st.dataframe(
        rows,
        use_container_width=True,
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
journals = catalog["journals"]
compared = [j for j in journals if j.get("comparison")]
complete = [j for j in compared if j["comparison"]["status"] == "complete"]

st.title("Atlas Educ@")
st.caption("Exploração dos dados já processados • Fonte: Educ@ / Fundação Carlos Chagas e sites oficiais das revistas")
st.info(
    "Os números refletem a coleta registrada em "
    f"{catalog['source'].get('capturedAt', 'data não informada')[:10]}. "
    "Resultados parciais indicam trechos ainda não coletados; confira o período de cobertura antes de interpretar ausências."
)

col1, col2, col3, col4 = st.columns(4)
col1.metric("Periódicos ativos", len(journals))
col2.metric("Com comparação", len(compared))
col3.metric("Comparações completas", len(complete))
col4.metric("Artigos ausentes", sum(j["comparison"]["missingCount"] for j in complete))

overview_tab, journal_tab, missing_tab = st.tabs(["Panorama", "Periódico", "Ausências na Educ@"])

with overview_tab:
    st.subheader("Panorama da coleção")
    search = st.text_input("Buscar periódico, ISSN ou editora", key="overview-search")
    filtered = [
        journal
        for journal in journals
        if search.casefold() in " ".join(
            str(journal.get(field) or "")
            for field in ("title", "id", "printIssn", "onlineIssn", "publisher")
        ).casefold()
    ]
    rows = [
        {
            "Periódico": j["title"],
            "ISSN": j["id"],
            "Início": j.get("firstIndexedYear"),
            "Último ano": j.get("latestIndexedYear"),
            "Fascículos": j.get("issueCount"),
            "Artigos Educ@": j.get("articleCount"),
            "Comparação": j.get("comparison", {}).get("status", "não disponível"),
            "Ausentes": j.get("comparison", {}).get("missingCount"),
        }
        for j in filtered
    ]
    st.dataframe(rows, use_container_width=True, hide_index=True)
    st.download_button("Baixar tabela em CSV", csv_bytes(rows), "atlas-educa-periodicos.csv", "text/csv")

with journal_tab:
    selected_id = st.selectbox(
        "Selecione um periódico",
        options=[j["id"] for j in journals],
        format_func=lambda value: next(j["title"] for j in journals if j["id"] == value),
    )
    journal = next(j for j in journals if j["id"] == selected_id)
    st.subheader(journal["title"])
    st.caption(f"ISSN {journal['id']} · {journal.get('publisher') or 'Editora não informada'}")
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
            st.bar_chart(counts, x="Ano", y="Artigos", use_container_width=True)
        year_options = sorted({y["year"] for y in years}, reverse=True)
        year = st.selectbox("Ano", ["Todos"] + year_options)
        query = st.text_input("Buscar título, autor ou DOI", key=f"article-search-{selected_id}").casefold().strip()
        articles = [
            article
            for item in years
            if year == "Todos" or item["year"] == year
            for issue in item.get("issues", [])
            for article in issue.get("articles", [])
        ]
        if query:
            articles = [
                article
                for article in articles
                if query in " ".join(
                    [article.get("title") or "", article.get("doi") or ""]
                    + (article.get("authors") or [])
                ).casefold()
            ]
        st.write(f"{len(articles):,} artigos encontrados".replace(",", "."))
        show_articles(article_rows(articles), f"artigos-{selected_id}")

with missing_tab:
    st.subheader("Artigos da fonte oficial sem correspondência na Educ@")
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
