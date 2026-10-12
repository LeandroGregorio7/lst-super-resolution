# Evidências externas para o fluxo automático SR2D4 → Landsat → LST sharp

## Artigos fornecidos pelo usuário

- https://www.mdpi.com/2072-4292/17/8/1410
  - Estudo de super-resolução LST que combina LST Landsat coarse com imagem óptica high-resolution e referência térmica UAV.
  - O artigo mostra que integrar bandas espectrais, NDVI e LST reduz o erro em comparação com RGB isolado; o modelo KAN teve RMSE reportado de cerca de 4,06 °C e MAE de 3,09 °C no estudo, com validação por UAV.
  - A evidência não autoriza tratar um resultado óptico-only como observação térmica. O método depende de uma LST coarse real e validação térmica independente.

- https://www.preprints.org/manuscript/202512.1256
  - O artigo usa Landsat 8/9 Collection 2 Level-2, ST/LST e QA_PIXEL, elimina nuvens/sombras/neve, alinha dados numa grade comum e valida em anos separados.
  - O modelo proposto combina campo coarse de temperatura com contexto Landsat e usa MAE; enfatiza que a entrada térmica precisa ser uma observação LST clara/qualificada.
  - Também usa janela temporal e co-registro explícitos, não inferência de temperatura a partir apenas de bandas ópticas.

## Método de downscaling

- https://www.nuritagam.com/Papers/2006-Agam-et-al-RSE-TsHARP.pdf
  - TsHARP ajusta a relação LST coarse–predictor na escala coarse, aplica-a ao predictor fine e adiciona o residual coarse para conservar a observação agregada.
  - Água e pixels coarse heterogêneos devem ser excluídos do ajuste; água tem baixo NDVI e não segue necessariamente a relação solo/vegetação.

- https://www.mdpi.com/2072-4292/13/7/1306
  - Revisão: o desempenho dos kernels varia por cobertura, estação e local. Métodos urbanos usam NDVI/EVI, NDBI, NDWI/MNDWI, NDMI, emissividade, albedo, cobertura do solo, DEM e regressões/machine learning.
  - A relação é empírica e precisa de validação e controle de escala.

## Landsat e temperatura

- https://www.usgs.gov/faqs/what-are-band-designations-landsat-satellites
  - Landsat 8/9: B10 e B11 são TIRS; B10 ≈ 10,60–11,19 µm, B11 ≈ 11,50–12,51 µm; resolução nativa 100 m, reamostrada para 30 m em Level-1.

- https://www.usgs.gov/landsat-missions/landsat-collection-2-surface-temperature
  - Collection 2 Level-2 ST é gerado a partir de TIRS, reflectância TOA, brightness temperature, ASTER GED, NDVI ASTER e perfis atmosféricos.
  - Escala oficial: `ST[K] = DN * 0.00341802 + 149.0`.
  - O produto tem limitações documentadas de blockiness e ajuste de emissividade.

- https://www.usgs.gov/landsat-missions/landsat-collection-2-known-issues
  - O USGS documenta blockiness por emissividade ASTER GED de 100 m reamostrada para a grade de 30 m e uma anomalia no ajuste temporal de vegetação.

## Acesso automático candidato

- https://planetarycomputer.microsoft.com/dataset/landsat-c2-l2
  - Catálogo público Planetary Computer para Landsat Collection 2 Level-2, com `ST_B10` e assets COG.
  - Deve ser consultado por STAC usando data e bbox derivados do GeoTIFF SR2D4; a cena deve ser filtrada por qualidade/nuvem e escolhida pela menor distância temporal.

- https://earth-search.aws.element84.com/v1/collections/landsat-c2-l2
  - Earth Search STAC público lista a coleção Landsat C2 L2 e pode ser usado para busca por bbox/datetime.

## SUHI/UHI

- https://www.usgs.gov/publications/characterizing-urban-heat-islands-across-50-major-cities-united-states
  - SUHI é temperatura de superfície urbana maior que a de área não urbana; intensidade exige comparação urbana–não urbana e dados de cobertura, não apenas média ± desvio-padrão global.
