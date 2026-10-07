# Atlas-Educa

Aplicação **Atlas Educ@ — Artigos dos periódicos ativos**, agora em Streamlit. Ela usa os arquivos JSON já processados neste repositório, sem refazer a coleta durante a navegação.

O painel reúne o resumo da coleção, métricas de 2023 a 2025, ranking anual, evolução das revistas com dados nos três anos, catálogo filtrável, artigos por ano e fascículo e a auditoria das comparações com as fontes oficiais.

## Executar localmente

```bash
python -m pip install -r requirements.txt
streamlit run streamlit_app.py
```

## Publicar no Streamlit Community Cloud

Conecte este repositório GitHub ao [Streamlit Community Cloud](https://share.streamlit.io/) e selecione `streamlit_app.py` como arquivo principal. As dependências estão em `requirements.txt`. O app usa `app/journals.json`, `app/metrics.json` e `public/data/` incluídos no repositório.

Os números de ausências derivam das comparações salvas em `public/data/comparisons/`. Quando a comparação é parcial, o painel informa essa condição e o período de cobertura. O total no panorama soma somente comparações completas.
