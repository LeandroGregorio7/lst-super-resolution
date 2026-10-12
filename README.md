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
7. agrega NDVI, NDBI e NDWI do SR2D4 para a escala Landsat, ajusta a relação multivariada na escala coarse e transfere-a para a grade fina;
8. adiciona o residual Landsat de cada célula coarse ao resultado fino, preservando a observação térmica agregada.

Não há input de banda térmica Landsat no app. O usuário seleciona apenas Red, NIR e SWIR do próprio SR2D4. A busca térmica é automática.

> Atenção: em Landsat 8/9 as bandas TIRS são B10 e B11. A banda `ST_B10` é o produto de temperatura de superfície do Collection 2 Level-2. B11/B12 são nomenclaturas comuns do Sentinel-2 para SWIR, não uma entrada térmica Landsat equivalente.

## Limitações científicas

O resultado fino é uma **estimativa downscaled**, não uma medição térmica independente em cada pixel de 1 m. A resolução espacial da informação térmica original continua sendo Landsat; o SR2D4 fornece os predictores espaciais. A aplicação deve registrar a data Landsat escolhida, a diferença temporal, a cobertura de nuvens, a cena e as métricas do ajuste.

A literatura recente mostra que integrar reflectância, índices de vegetação e LST melhora a reconstrução em relação a RGB isolado, mas os métodos precisam de co-registro, máscara de qualidade e validação térmica independente. O produto não deve ser apresentado como temperatura observada a 1 m sem validação de campo, UAV térmico ou referência equivalente.

## TsHARP/downscaling

A implementação coarse-to-fine ajusta a regressão com médias dos predictores SR2D4 dentro de cada célula Landsat e aplica os coeficientes aos pixels finos. O residual observado da célula coarse é adicionado ao campo fino, evitando que a regressão invente um viés médio incompatível com a LST Landsat. NDVI isolado não é usado como temperatura; NDBI e NDWI ajudam a distinguir vegetação, superfícies construídas/solo e água.

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
