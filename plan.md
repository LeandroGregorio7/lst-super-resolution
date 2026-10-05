# SR2D4 LST Explorer — plano de aplicação independente

## Objetivo

Transformar o antigo plugin em uma aplicação GIS web independente, hospedável no GitHub Pages, sem dependência de GeoLibre, sem painel injetado em outra interface e com uma experiência profissional para visualizar e analisar produtos SR2D4/LST.

## Decisões de produto

- **Processamento pesado:** continua no notebook Google Colab; a aplicação fornece o botão direto para gerar/baixar o GeoTIFF multiespectral.
- **Visualização:** MapLibre GL JS com mapa-base OSM via tiles raster públicos, camada de imagem LST como `ImageSource`, camada óptica antes/depois e controles de visibilidade.
- **Raster:** leitura local de GeoTIFF no navegador com `geotiff`; nenhum arquivo é enviado a servidor.
- **CRS:** usar `proj4` para transformar a extensão do raster para WGS84 quando o GeoTIFF informar EPSG; manter fallback visual seguro quando a metadata geográfica estiver incompleta.
- **Análises:** SR2D4/LST, NDVI, NDBI, classificação de ilha de calor urbana, estatísticas, histograma, inspeção por clique, AOI desenhada, recorte lógico e exportação.
- **Idioma e tema:** português/inglês, claro/escuro, com estado salvo no navegador.
- **Publicação:** GitHub Actions gera `dist` e publica em GitHub Pages usando `actions/deploy-pages`.

## Direção visual

- **Movimento:** editorial científico + control room cartográfico; denso em informação, mas com hierarquia e espaços respirados.
- **Princípios:** mapa é o foco; controles são modulares; dados têm prioridade sobre decoração; estados de processamento são explícitos.
- **Cores:** azul petróleo e grafite para confiança técnica, âmbar térmico como assinatura e ciano para dados ativos.
- **Layout:** cabeçalho de produto, mapa ocupando a área principal e rail lateral redimensionável com cartões de análise; evita painel central que cubra o mapa.
- **Elementos de assinatura:** faixa térmica âmbar, badge de status do raster e cartões com borda fina e textura de grade cartográfica.
- **Interação:** cada ação confirma seu estado; camadas podem ser ocultadas independentemente; o painel pode ser expandido, recolhido e redimensionado.
- **Animação:** transições curtas de 160–220 ms; nada que atrapalhe a leitura do mapa; progresso de processamento em etapas.
- **Tipografia:** Inter para interface, IBM Plex Mono para valores, EPSG e metadados.
- **Posicionamento:** “um explorador térmico de código aberto para transformar produtos SR2D4 em decisões espaciais”. Personalidade: preciso, acessível, investigativo.
- **Marca:** wordmark `SR2D4 / LST EXPLORER` com marcador de mapa e gradiente térmico discreto.

## Estrutura

- `src/App.tsx`: shell da aplicação e estado global.
- `src/components/MapView.tsx`: MapLibre, fontes, camadas, clique, AOI e recorte.
- `src/components/ControlRail.tsx`: upload, bandas, processamento, controles e exportação.
- `src/components/StatsPanel.tsx`: estatísticas, histograma e classificação UHI.
- `src/components/InfoDialog.tsx`: metodologia e ajuda bilíngues.
- `src/raster/*`: leitura, CRS, renderização de canvas e metadados.
- `src/analysis/*`: LST, NDVI, NDBI, UHI e histogramas.
- `src/styles/*`: tokens e layout responsivo.
- `public/manus-routes.json`: manifesto de rota da aplicação.
- `.github/workflows/deploy-pages.yml`: build e publicação no GitHub Pages.

## Limites honestos

A visualização é local e não envia o GeoTIFF. A aplicação não substitui validação radiométrica ou de campo. A super-resolução aumenta o detalhe espacial estimado, não cria observações térmicas independentes em cada novo pixel. O mapa-base OSM depende da disponibilidade e dos termos do provedor de tiles.
