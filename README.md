# SR2D4 / LST Explorer

Aplicação GIS web independente para visualizar produtos multiespectrais SR2D4 e analisar uma banda de Temperatura da Superfície Terrestre (LST) calibrada. O projeto funciona diretamente no navegador e não envia o GeoTIFF a um servidor.

## Pré-requisito metodológico

**Um produto SR2D4 óptico, sozinho, não contém LST.** Red, NIR e SWIR não podem ser convertidos em temperatura por normalização min–max. Para calcular LST, o GeoTIFF carregado precisa conter uma banda térmica real:

- **Landsat Collection 2 Level-2 `ST_B10`**, decodificada por `ST[K] = DN × 0.00341802 + 149.0`; ou
- uma LST previamente calibrada em °C, com documentação da cadeia radiométrica, emissividade e correção atmosférica.

A aplicação rejeita o antigo fluxo que usava Red como proxy térmica de 22–45 °C. Esse fluxo era apenas uma simulação visual e não deve ser usado em análise científica.

## Fluxo de uso

1. Gere o produto óptico no Colab e obtenha a banda Landsat `ST_B10` da mesma cena, ou monte um GeoTIFF co-registrado que contenha as duas partes.
2. Abra a aplicação e carregue o GeoTIFF local.
3. Selecione Red, NIR, SWIR e a banda térmica. Para `ST_B10`, mantenha o modo **Landsat C2 ST_B10 (DN)**.
4. Calcule e confira a faixa térmica em °C, máscaras, histograma e metadados.
5. Use o mapa como LST observada/calibrada. A versão atual **não declara super-resolução térmica** quando recebe uma única grade.

## TsHARP e sharpening

TsHARP pressupõe uma relação cena-específica entre LST coarse e um índice óptico fine. O método exige uma grade térmica coarse, predictors fine co-registrados, ajuste na escala coarse e adição do residual coarse ao produto fine. Uma regressão NDVI–LST aplicada diretamente pixel a pixel não é TsHARP e pode inverter ou exagerar contrastes.

Quando recebe uma única grade, o aplicativo calcula apenas a regressão diagnóstica e conserva a LST observada. Para implementar sharpening científico, é necessário adicionar entrada separada para a grade térmica coarse, reamostragem/agregação documentada, máscara de água/nuvens e validação independente.

## UHI / SUHI

A classe por média e desvio-padrão da própria imagem é apenas uma **anomalia térmica exploratória**. Ela não é intensidade de ilha de calor de superfície (SUHII). Uma SUHII exige uma referência não urbana/rural definida a priori e deve ser calculada, por exemplo, como `média(LST_urbana) − média(LST_referência)`, com máscara de uso/cobertura, distância e janela temporal documentadas. O usuário deve evitar chamar a classificação global por σ de UHI em artigo ou dissertação.

## Recursos

A interface inclui mapa-base OSM/Esri, camada óptica, camada LST, estatísticas, histograma, análise exploratória por desvio-padrão, metadados e exportação. O resultado é local e deve ser validado com dados de campo ou produto de referência.

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
