# Auditoria da fusão LST Landsat–SR2D4

## Diagnóstico do resultado observado

O resultado anterior não estava executando uma fusão térmica adequada em toda a área. Quando havia menos de oito células Landsat válidas, o código entrava em um fallback que copiava o valor LST coarse da célula Landsat para todos os pixels finos dentro dela. Esse comportamento preservava a escala de aproximadamente 100 m e produzia os blocos visíveis na imagem.

O problema não era resolvido aumentando o tamanho do canvas ou reamostrando a imagem. Reamostragem apenas muda o número de pixels; não transfere informação espacial do SR2D4 para a temperatura.

## Método correto aplicado

A implementação foi substituída por um TsHARP coarse-to-fine explícito:

1. A LST `ST_B10` do Landsat é mantida na grade térmica nativa.
2. NDVI, NDBI e NDWI são calculados na imagem óptica SR2D4.
3. Esses índices são agregados para cada célula térmica Landsat.
4. A relação coarse LST–NDVI é ajustada com polinômio quadrático quando a amostra é pequena, ou com o modelo multivariado NDVI–NDBI–NDWI quando há células suficientes.
5. A função ajustada é aplicada aos valores finos de NDVI do SR2D4.
6. O residual observado de cada célula Landsat é adicionado ao mapa fino.
7. O resultado é conservado por célula térmica: a agregação do resultado continua compatível com a LST Landsat usada como observação.
8. Água é excluída do ajuste da relação vegetação–temperatura, mas continua recebendo a temperatura estimada pela etapa de residual.

A saída tem a mesma largura, altura, extensão e resolução espacial do GeoTIFF SR2D4. Se o GeoTIFF realmente tiver pixel de 1 m, a saída terá 1 m; se tiver 10 m, o app não pode declarar 1 m. A resolução utilizada agora aparece no log de processamento.

## O que os artigos indicam

O TsHARP original define a relação entre temperatura radiométrica coarse e NDVI agregado, aplica a função ao NDVI fino e adiciona o residual coarse para recuperar a observação térmica após re-agregação. O artigo também recomenda excluir água do ajuste e alerta que a relação depende da cena e do tipo de cobertura.

O artigo de avaliação mostra que TsHARP deve ser comparado com simples reamostragem. O sharpening só é demonstrado quando a aplicação do índice fino produz estrutura adicional e quando há validação com uma referência térmica mais fina. O mesmo estudo registra erros maiores em áreas heterogêneas, florestas e bordas.

O artigo de 2025 enviado pelo usuário usa uma arquitetura de super-resolução com imagem térmica de alta resolução de UAV e imagem óptica de alta resolução. Portanto, ele não autoriza transformar Landsat ST_B10 sozinho em uma observação térmica real de 1 m. A imagem SR2D4 pode fornecer a estrutura espacial dos preditores, mas o detalhe térmico continua estimado e requer validação.

## Limitações que permanecem explicitamente controladas

- Landsat Collection 2 ST_B10 continua sendo uma observação térmica de escala coarse; o SR2D4 não cria radiância térmica nova.
- Diferença de data entre SR2D4 e Landsat pode produzir inconsistência em água, sombra, vegetação e superfícies urbanas.
- A emissividade e os problemas conhecidos do produto Landsat ST permanecem aplicáveis.
- A saída não deve ser interpretada como medição de temperatura de cada pixel de 1 m sem validação de campo ou referência térmica de alta resolução.
- A qualidade deve ser avaliada por RMSE/MAE contra uma referência térmica independente e por classe de cobertura.

## Referências

[1]: http://www.nuritagam.com/Papers/2006-Agam-et-al-RSE-TsHARP.pdf "Agam et al., 2007 — A vegetation index-based technique for spatial sharpening of thermal imagery"

[2]: https://www.mdpi.com/2072-4292/11/19/2304 "Huryna et al., 2019 — Evaluation of TsHARP Utility for Thermal Sharpening of Sentinel-3 Imagery"

[3]: https://www.mdpi.com/2072-4292/17/8/1410 "Fathi et al., 2025 — Super-Resolution of Landsat-8 LST Using KAN, PlanetScope and UAV Thermal Data"

[4]: https://www.preprints.org/manuscript/202512.1256 "Preprint 2025 — Superresolution of Land Surface Temperature Through Multi-Source Data Fusion"

[5]: https://www.usgs.gov/landsat-missions/landsat-collection-2-surface-temperature "USGS — Landsat Collection 2 Surface Temperature"
