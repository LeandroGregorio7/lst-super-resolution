# SR2D4 / LST Explorer

Aplicação GIS web independente para visualizar e analisar produtos multiespectrais SR2D4 e mapas de Temperatura da Superfície Terrestre (LST). O projeto não depende do GeoLibre nem injeta componentes em outra aplicação: funciona diretamente no navegador e pode ser publicado no GitHub Pages.

## Fluxo de uso

1. Abra o notebook [SR2D4 no Google Colab](https://colab.research.google.com/drive/1uKJohUXOqTmbNDZY7N8qVzyk1_laBKIg?usp=sharing) e gere o produto multiespectral (`MS`).
2. Abra a aplicação publicada e carregue o GeoTIFF local.
3. Confirme as bandas Red, NIR e SWIR e clique em **Calcular mapa térmico**.
4. Explore o mapa, alterne camadas, ajuste transparência, contraste e paleta, clique para consultar temperaturas, desenhe uma AOI e exporte PNG ou GeoTIFF.

O GeoTIFF é processado localmente no navegador. O arquivo não é enviado a servidor.

## Recursos

A interface inclui mapa-base OSM/Esri, camada óptica, camada LST, legenda em °C, estatísticas, histograma, classificação exploratória de ilhas de calor, metadados, suporte a português/inglês, tema claro/escuro e exportação.

A aplicação combina SR2D4, índices NDVI/NDBI e uma regressão TsHARP para estimar a distribuição espacial da LST. A super-resolução representa detalhe espacial estimado; não equivale a uma observação térmica independente em cada novo pixel. Valide os resultados com dados de campo.

## Desenvolvimento

```bash
npm install
npm run dev
npm run build
npm run preview
```

O workflow `.github/workflows/deploy-pages.yml` gera `dist` e publica no GitHub Pages a cada push em `main`. Ative **Settings → Pages → Source: GitHub Actions** no repositório se ainda não estiver ativado.

## Licença

MIT.
