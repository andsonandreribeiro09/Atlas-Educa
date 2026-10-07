# Atlas-Educa

Explorador dos periódicos ativos da coleção Educ@. O painel em Streamlit usa os arquivos JSON já processados neste repositório, sem refazer a coleta durante a navegação.

## Executar localmente

```bash
python -m pip install -r requirements.txt
streamlit run streamlit_app.py
```

## Publicar no Streamlit Community Cloud

Conecte este repositório GitHub ao [Streamlit Community Cloud](https://share.streamlit.io/) e selecione `streamlit_app.py` como arquivo principal. As dependências estão em `requirements.txt`. O app usa `app/journals.json` e `public/data/` incluídos no repositório.

Os números de ausências derivam das comparações salvas em `public/data/comparisons/`. Quando a comparação é parcial, o painel informa essa condição e o período de cobertura. O total no panorama soma somente comparações completas.
