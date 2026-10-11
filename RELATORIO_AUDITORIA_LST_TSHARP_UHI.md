# Auditoria metodológica do LST, TsHARP e UHI

## Diagnóstico principal

O mapa apresentado não representa uma temperatura de superfície Landsat fisicamente recuperada. Na implementação anterior, `src/thermalProcessing.ts` recebia a banda **Red**, fazia uma normalização min–max da imagem e impunha artificialmente a faixa de 22–45 °C. Em seguida, `src/downscaling.ts` ajustava uma regressão entre esse valor artificial e o NDVI e aplicava a equação pixel a pixel.

Esse encadeamento explica por que o resultado pode colocar vegetação densa e água acima de asfalto, concreto e metal. O erro não é apenas de paleta. A variável dependente já não era radiância, brightness temperature ou LST. Era uma proxy arbitrária derivada da reflectância vermelha. A regressão podia ainda amplificar ou inverter o contraste local, sem residual coarse nem conservação da observação térmica.

**Conclusão:** o raster mostrado deve ser tratado como inválido para inferência de LST ou SUHI. A correção não deve “ajustar as cores”; deve remover a cadeia inválida e recalcular a partir de uma banda térmica calibrada.

## Avaliação das quatro hipóteses

### 1. Bandas térmicas incompatíveis

A hipótese é parcialmente correta e importante. Landsat 8 e 9 têm duas bandas TIRS: B10, de aproximadamente 10,6–11,19 µm, e B11, de aproximadamente 11,50–12,51 µm. Não existe B12 nesses sensores. O USGS informa também que essas bandas têm resolução nativa de 100 m, embora sejam entregues reamostradas a 30 m no Level-1 [1].

Para o produto Landsat Collection 2 Level-2, a banda entregue como temperatura de superfície é **`ST_B10`**. A especificação informa a conversão:

```text
ST[K] = DN × 0.00341802 + 149.0
LST[°C] = ST[K] − 273.15
```

O guia do produto lista `ST_B10`, `ST_EMIS`, `ST_EMSD`, `ST_ATRAN`, `ST_URAD`, `ST_DRAD`, `ST_TRAD` e `ST_QA`; não entrega um `ST_B11` equivalente no pacote L2SP [2]. Portanto, um plugin que exige B11/B12 para um SR2D4 óptico está misturando nomenclaturas ou tentando aplicar um algoritmo que não corresponde ao produto disponível.

O B11 pode aparecer em um produto Level-1 TIRS, mas isso não autoriza usar B10/B11 como se fossem bandas de reflectância do SR2D4. Para derivar LST a partir de Level-1 é necessário calibrar radiância, corrigir atmosfera e estimar emissividade. Se o arquivo só tem Red, NIR e SWIR, não há observação térmica.

### 2. Mistura por escala espacial

A hipótese também é correta, mas não é a causa única do caso mostrado. A resolução térmica nativa do TIRS é muito mais grossa que a resolução óptica. Um pixel térmico mistura copa, sombra, água, solo, telhado, pista e carros. A reamostragem para 30 m não cria detalhe; apenas muda a grade de representação [1] [2].

TsHARP pode estimar detalhe espacial usando uma relação estatística entre LST coarse e um predictor óptico fine. Ele não recupera uma temperatura observada em cada pixel novo. A relação deve ser ajustada na escala coarse, aplicada aos predictors fine e corrigida com o residual coarse:

```text
LST_fine = f(predictor_fine) + residual_coarse
```

O artigo fundador deixa claro que a relação NDVI–temperatura é dependente da cena, do local e da cobertura. Ele recomenda excluir água e pixels coarse muito heterogêneos, pois água tem baixo NDVI e baixa temperatura e não pertence à mesma relação que a vegetação terrestre [3]. A revisão mais recente mostra que o desempenho varia por cobertura, estação, local e kernel; em ambientes urbanos são usados NDVI, NDBI, NDWI/MNDWI, umidade, emissividade, albedo, DEM e classificação de cobertura, entre outros [4].

No código anterior, não havia grade coarse separada, não havia agregação, não havia residual coarse e a equação era aplicada diretamente sobre a mesma grade. Isso não era TsHARP. Era uma regressão pixel a pixel que fabricava o mapa.

### 3. Ausência de índices de vegetação e materiais

A hipótese está correta, com uma ressalva: adicionar índices não corrige uma LST inválida. NDVI é um predictor útil para o efeito de cobertura vegetal, mas não substitui a cadeia radiométrica térmica. Em área urbana heterogênea, NDVI sozinho é insuficiente.

O mínimo para um sharpening urbano defensável é separar, conforme disponibilidade e validação:

- NDVI ou EVI para vegetação;
- fração de cobertura vegetal, em vez de usar NDVI bruto como temperatura;
- NDBI ou fração impermeável para superfície construída;
- NDWI/MNDWI e máscara de água;
- emissividade ou classe de cobertura;
- umidade/NDMI quando houver suporte;
- máscara de sombra, nuvem, cirrus e pixels saturados.

A associação esperada é probabilística, não uma regra rígida para todo pixel: água e vegetação tendem a reduzir LST em muitas cenas diurnas, mas água pode refletir condições atmosféricas, vento, profundidade, turbidez e geometria; árvores podem estar expostas ao sol, sofrer estresse hídrico ou ser misturadas com telhados e pavimento. O critério científico é validar a relação na cena e quantificar erro, não impor que todo verde seja sempre mais frio.

### 4. Falha do método/plugin

Há falha metodológica objetiva na implementação do aplicativo:

1. **Red foi usada como temperatura.**
2. **A faixa 22–45 °C foi imposta pelo código**, não obtida do sensor.
3. **A radiância foi simulada** com `val × 0.0003342`, sem metadados TIRS nem inversão radiométrica.
4. **NDVI, NDBI e temperatura não foram co-registrados em grades coarse/fine distintas.**
5. **Água foi excluída pelo teste `NDVI > 0` durante o ajuste**, mas depois a regressão foi aplicada também a pixels fora da máscara.
6. **Não houve emissividade, vapor d’água, transmitância, radiância ascendente/descendente ou QA térmico.**
7. **O UHI foi definido pela média e desvio-padrão da própria imagem**, sem referência rural.

Além desses erros do aplicativo, o próprio produto Landsat C2 ST tem limitações conhecidas. O USGS documenta artefatos de “blockiness” associados à emissividade ASTER GED reamostrada de 100 m para a grade de 30 m e uma anomalia na correção de vegetação da emissividade quando a condição da vegetação mudou entre a era ASTER e a aquisição Landsat [5]. Isso pode explicar padrões em blocos ou discrepâncias localizadas, mas não justifica o fluxo que usava Red como LST.

## Correções aplicadas no código

Foram aplicadas três correções estruturais no projeto:

1. **`thermalProcessing.ts`** agora aceita apenas `ST_B10` Landsat C2 em DN ou uma LST já calibrada em °C. Para ST_B10 aplica a escala oficial e converte Kelvin para Celsius. Fill values, NaN e valores fora de uma faixa física ampla são mascarados.
2. **A interface** passou a exigir uma quarta banda térmica separada de Red/NIR/SWIR. Um SR2D4 somente óptico deixa de produzir um mapa chamado LST.
3. **`downscaling.ts`** deixou de aplicar a regressão pixel a pixel. Quando existe apenas uma grade, calcula somente o diagnóstico da relação e conserva a LST observada. O resultado fica explicitamente marcado como `sharpened: false`.
4. **`README.md`** foi revisado para declarar que a classe por média e desvio-padrão é apenas uma anomalia exploratória, não SUHII.

A compilação e o lint foram executados com sucesso após as alterações.

## Correção necessária para o UHI/SUHI

O mapa de “UHI level” anterior não era intensidade de ilha de calor. Ele classificava pixels por:

```text
LST < média
média ≤ LST < média + 0,5σ
média + 0,5σ ≤ LST < média + 1,5σ
LST ≥ média + 1,5σ
```

Isso é um mapa de anomalia relativa à própria cena. Não separa cidade de entorno, não controla uso/cobertura e não informa quanto a área urbana está mais quente que uma referência rural.

A definição que deve ser usada no relatório é **SUHI**, não UHI atmosférico, quando a variável é LST. O USGS define SUHI como uma temperatura de superfície urbana maior que a de uma área não urbana e produz a intensidade a partir de Landsat ST e dados de cobertura do solo [6]. Para um estudo no Campo de Marte/Santana, a implementação correta deve:

1. definir previamente o polígono urbano e uma ou mais áreas não urbanas/rurais comparáveis;
2. excluir água, nuvens, sombras, pixels saturados e bordas misturadas;
3. calcular a média, mediana, dispersão e intervalo de confiança da LST em cada estrato;
4. calcular `SUHII = média(LST_urbana) − média(LST_referência)`;
5. repetir a análise por classes de cobertura, estação/horário e, se possível, várias cenas;
6. relatar que LST/SUHI não é temperatura do ar nem exposição térmica humana direta.

A referência rural não deve ser simplesmente “a média de toda a imagem”. Se ainda não houver máscara urbana/rural, o produto deve ser rotulado como **anomalia térmica exploratória** e não como UHI.

## Protocolo recomendado para a próxima versão

A entrada ideal deve ser composta por:

- Landsat 8/9 Collection 2 Level-2 `ST_B10` e `ST_QA`;
- bandas SR B4 (Red), B5 (NIR), B6/B7 (SWIR) da mesma cena;
- produto SR2D4 óptico co-registrado, se o objetivo for sharpening;
- máscara QA_PIXEL e QA_RADSAT;
- `ST_EMIS`/`ST_EMSD` para controle de emissividade e incerteza;
- máscara de água e classificação urbano/vegetação/solo/concreto/asfalto;
- referência rural definida por polígonos, não pela média global.

A cadeia de sharpening deve então ser: corrigir escala e máscaras → alinhar CRS/grid → ajustar modelo na escala térmica coarse → aplicar predictors fine → adicionar residual coarse por célula → limitar valores a uma faixa validada → avaliar MAE/RMSE/R² e conservação da média coarse → calcular SUHII somente com referência urbana/rural documentada.

## Veredito sobre a imagem apresentada

A leitura visual do usuário está correta como alerta: o padrão é fisicamente suspeito, sobretudo se água e copa densa aparecem sistematicamente mais quentes que as superfícies minerais sob o mesmo horário e condição atmosférica. Porém, a causa não precisa ser inferida apenas pela imagem. O código confirma uma causa suficiente e grave: **a aplicação não estava calculando LST Landsat**.

A imagem deve ser descartada para resultados quantitativos. Depois de carregar `ST_B10` calibrada e repetir o processamento com máscara/QA, é necessário verificar se a inversão desaparece. Só depois dessa etapa deve-se investigar emissividade ASTER, blockiness C2, mistura de escala e desempenho do sharpening.

## Referências

[1]: https://www.usgs.gov/faqs/what-are-band-designations-landsat-satellites "USGS — What are the band designations for the Landsat satellites?"
[2]: https://d9-wret.s3.us-west-2.amazonaws.com/assets/palladium/production/s3fs-public/media/files/LSDS-1619_Landsat8-9-Collection2-Level2-Science-Product-Guide-v6.pdf "Landsat 8–9 Collection 2 Level 2 Science Product Guide, version 6.0"
[3]: http://www.nuritagam.com/Papers/2006-Agam-et-al-RSE-TsHARP.pdf "Agam et al. — A vegetation index based technique for spatial sharpening of thermal imagery"
[4]: https://www.mdpi.com/2072-4292/13/7/1306 "Resolution enhancement of remotely sensed land surface temperature: Current status and perspectives"
[5]: https://www.usgs.gov/landsat-missions/landsat-collection-2-known-issues "USGS — Landsat Collection 2 Known Issues"
[6]: https://www.usgs.gov/publications/characterizing-urban-heat-islands-across-50-major-cities-united-states "USGS — Characterizing urban heat islands across 50 major cities in the United States"
