
## Sentinel-2 e composição SR2D4/MS x10

- https://www.researchgate.net/figure/Sentinel-2-band-characteristics_tbl1_314119510
  - Tabela fornecida pelo usuário com B04 Red (aprox. 665 nm), B08 NIR (aprox. 842 nm), B10 cirrus (aprox. 1375 nm), B11 SWIR-1 (aprox. 1610 nm) e B12 SWIR-2 (aprox. 2190 nm).

- https://custom-scripts.sentinel-hub.com/custom-scripts/sentinel-2/bands/
  - Confirma nomes, comprimentos de onda e aplicações das bandas Sentinel-2.

- https://sentiwiki.copernicus.eu/web/s2-mission
  - Fonte Copernicus: bandas de 10 m B02/B03/B04/B08; bandas de 20 m B05/B06/B07/B8A/B11/B12; bandas de 60 m B01/B09/B10.

- https://developers.google.com/earth-engine/datasets/catalog/COPERNICUS_S2_SR_HARMONIZED
  - Confirma que o produto Sentinel-2 Level-2A Surface Reflectance não entrega B10; contém B11 e B12 como SWIR.

Para o SR2D4/MS x10 adotado no aplicativo, a ordem é: Camada 01=B02, 02=B03, 03=B04, 04=B05, 05=B06, 06=B07, 07=B08, 08=B8A, 09=B11 e 10=B12. Assim, o usuário deve apontar **Red=03/B04, NIR=07/B08 e SWIR=09/B11**; a **10/B12** é alternativa. Essa associação só é válida quando a exportação do Colab seguir explicitamente essa ordem.
