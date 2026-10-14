# SR2D4 / LST Explorer

Aplicação GIS web independente para visualizar produtos multiespectrais SR2D4 e estimar LST espacialmente a partir de uma cena Landsat 8/9 Collection 2 Level-2 encontrada automaticamente. O GeoTIFF SR2D4 permanece local no navegador; a aplicação consulta somente o catálogo e os COGs públicos Landsat necessários para a área do arquivo.

## Fluxo automático

O nome esperado do produto é, por exemplo, `S2L3Ax10_T23KLQ-5ee4de6e7-20260904_MS.tif`. A aplicação:

1. lê a data `AAAAMMDD` no nome do SR2D4;
2. lê a extensão espacial e as bandas ópticas do GeoTIFF SR2D4;
3. consulta o STAC público do Microsoft Planetary Computer na área e em uma janela de ±16 dias;
4. seleciona a cena Landsat 8/9 mais próxima, priorizando menor distância temporal e filtrando cenas com nuvens excessivas;
5. acessa os COGs `ST_B10` e `QA_PIXEL`, assinados pelo Planetary Computer, somente na janela espacial necessária;
6. aplica a escala oficial `ST[K] = DN × 0.00341802 + 149.0`, converte para °C e elimina pixels fill, nuvem, cirrus, sombra e neve;
7. agrega NDVI, NDBI e NDWI (Green/NIR) do SR2D4 para a escala Landsat, ajusta o modelo coarse e transfere-o para a grade fina;
8. adiciona o residual Landsat de cada célula coarse ao resultado fino, preservando a observação térmica agregada.

Não há input de banda térmica Landsat no app. O usuário seleciona apenas Red, NIR e SWIR do próprio SR2D4. A busca térmica é automática.

> Atenção: em Landsat 8/9 as bandas TIRS são B10 e B11. A banda `ST_B10` é o produto de temperatura de superfície do Collection 2 Level-2. B11/B12 são nomenclaturas comuns do Sentinel-2 para SWIR, não uma entrada térmica Landsat equivalente.

## Referência Sentinel-2 e apontamento no SR2D4/MS x10

A referência espectral do Sentinel-2 deve ser lida pelo **nome da banda**, não pela posição numérica do layer. A tabela abaixo é a convenção do produto `S2L3Ax10..._MS.tif` usado neste projeto, quando ele contém as dez bandas ópticas nesta ordem:

| Camada no SR2D4 | Banda Sentinel-2 | Nome/função | Centro aproximado | Apontar no app |
|---|---|---|---:|---|
| 01 | B02 | Blue | 490 nm | Não usar para Red/NIR/SWIR |
| 02 | B03 | Green | 560 nm | Não usar para Red/NIR/SWIR |
| **03** | **B04** | **Red** | **665 nm** | **Red / Vermelho** |
| 04 | B05 | Red Edge 1 | 705 nm | Não usar como Red |
| 05 | B06 | Red Edge 2 | 740 nm | Não usar como NIR |
| 06 | B07 | Red Edge 3 | 783 nm | Não usar como NIR |
| **07** | **B08** | **NIR** | **842 nm** | **NIR / Infravermelho próximo** |
| 08 | B8A | Red Edge 4 | 865 nm | Não substituir automaticamente B08 |
| **09** | **B11** | **SWIR 1** | **1610 nm** | **SWIR / recomendado para NDBI** |
| **10** | **B12** | **SWIR 2** | **2190 nm** | **SWIR alternativo para NDBI** |

Portanto, no arquivo SR2D4/MS x10 padrão, indique: **Red = Camada 03/B04; NIR = Camada 07/B08; SWIR = Camada 09/B11**. A Camada 10/B12 também é válida como SWIR alternativo. **Nunca selecione a Camada 10 por ela ser “10”: ela é B12 somente quando a ordem do SR2D4 é a tabela acima.**

A B10 do Sentinel-2 é uma banda de **cirrus**, centrada perto de 1375 nm; ela não é Red, NIR nem SWIR e não aparece como banda de reflectância no produto Sentinel-2 Level-2A SR. B11 e B12 são as bandas SWIR. [1] [2] [3]

Se o GeoTIFF não trouxer nomes no metadata e não seguir claramente a convenção `S2L3Ax10`, o usuário deve conferir a ordem definida no Colab antes de calcular. O app mostra um alerta e não deve interpretar uma posição genérica como banda espectral.

## Limitações científicas

O resultado fino é uma **estimativa downscaled**, não uma medição térmica independente em cada pixel de 1 m. A resolução espacial da informação térmica original continua sendo Landsat; o SR2D4 fornece os predictores espaciais. A aplicação deve registrar a data Landsat escolhida, a diferença temporal, a cobertura de nuvens, a cena e as métricas do ajuste.

A literatura recente mostra que integrar reflectância, índices de vegetação e LST melhora a reconstrução em relação a RGB isolado, mas os métodos precisam de co-registro, máscara de qualidade e validação térmica independente. O produto não deve ser apresentado como temperatura observada a 1 m sem validação de campo, UAV térmico ou referência equivalente.

## TsHARP/downscaling

A implementação coarse-to-fine ajusta a regressão com médias dos predictores SR2D4 dentro de cada célula Landsat e aplica os coeficientes aos pixels finos. A associação espacial usa os centros dos pixels e as transformações nativas de origem/resolução/EPSG, em vez de estimar a grade somente por uma caixa envolvente latitude/longitude. O residual é calculado a partir da média das previsões finas realmente produzidas em cada célula; assim, a média final por célula coincide com a ST_B10 válida dentro da precisão numérica. NDVI isolado não é usado como temperatura; NDBI e NDWI independente ajudam a distinguir superfícies construídas/solo e água. Neste app, NDWI é (Green − NIR)/(Green + NIR), enquanto NDMI é (NIR − SWIR)/(NIR + SWIR). NDBI e NDMI são opostos matemáticos se usam o mesmo NIR/SWIR e não devem entrar juntos como preditores independentes.

A compatibilidade da cena deve ser examinada quando a diferença temporal for grande, houver nuvens na área, mudança de iluminação ou diferença de horário de passagem. Se não houver cena adequada, o app deve interromper o processamento em vez de fabricar temperatura.

## UHI / SUHI

A classe por média e desvio-padrão da própria imagem é uma **anomalia térmica exploratória**. Ela não é intensidade de ilha de calor de superfície (SUHII). Uma SUHII exige uma referência não urbana/rural definida a priori e deve ser calculada, por exemplo, como `média(LST_urbana) − média(LST_referência)`, com máscaras de uso/cobertura, distância, data e janela temporal documentadas.

## Referências metodológicas

- [LST super-resolution with Landsat, PlanetScope and UAV thermal reference](https://www.mdpi.com/2072-4292/17/8/1410)
- [Two-stage LST fusion with Landsat and coarse temperature fields](https://www.preprints.org/manuscript/202512.1256)
- [USGS Landsat Collection 2 Surface Temperature](https://www.usgs.gov/landsat-missions/landsat-collection-2-surface-temperature)
- [Microsoft Planetary Computer Landsat C2 L2](https://planetarycomputer.microsoft.com/dataset/landsat-c2-l2)

## Desenvolvimento

```bash
npm install
npm run dev
npm run build
npm run lint
npm run preview
```

O workflow `.github/workflows/deploy-pages.yml` gera `dist` e publica no GitHub Pages a cada push em `main`.

## Licença

MIT.

## Referências

[1]: https://www.researchgate.net/figure/Sentinel-2-band-characteristics_tbl1_314119510 "Sentinel-2 band characteristics"
[2]: https://custom-scripts.sentinel-hub.com/custom-scripts/sentinel-2/bands/ "Sentinel-2 Bands — Sentinel Hub"
[3]: https://developers.google.com/earth-engine/datasets/catalog/COPERNICUS_S2_SR_HARMONIZED "Harmonized Sentinel-2 MSI Level-2A Surface Reflectance"

## Seleção robusta da cena térmica

A busca Landsat não usa mais somente a cena temporalmente mais próxima. Ela consulta até 12 cenas em uma janela de ±32 dias, lê `ST_B10` e `QA_PIXEL` de cada uma, conta os pixels térmicos válidos dentro da área e escolhe a cena com maior cobertura térmica válida. A máscara usa os bits 0–5 do `QA_PIXEL` para excluir preenchimento, nuvem dilatada, cirrus, nuvem, sombra e neve; o bit 6 (`clear`) não é tratado como nuvem.

Se a área ainda tiver menos de oito células Landsat válidas para ajustar quatro parâmetros, o app não interrompe nem cria uma regressão instável. Ele usa uma transferência conservadora da LST coarse por célula e marca internamente o resultado como não-sharpened. Isso mantém a temperatura observada sem fabricar detalhe de 1 m. A regressão multivariada só é usada quando há amostra suficiente.


## Validação matemática e logs de diagnóstico

O CI executa testes automatizados de índices espectrais, seleção temporal de cena Landsat, geração de variação fina e conservação da média térmica por célula. O log informa o modelo ajustado, o R² de treinamento, a amplitude do sinal fino e o erro médio de conservação. O R² é uma métrica do ajuste coarse usado na execução; não substitui validação contra dados térmicos independentes. O mapeamento para grade de 1 m declara a resolução do raster de saída, não uma resolução térmica medida a 1 m.
