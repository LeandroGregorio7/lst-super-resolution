import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { calculateOpticalIndices } from './opticalIndices';
import { downscaleLandsatLST } from './downscaling';
import { fetchNearestLandsatThermal, type ThermalProgress } from './landsatAuto';
import { readTiffPixels } from './tiffReader';
import { renderLstToCanvas, renderRGBBasemapToCanvas, type PaletteType } from './colorMapper';
import { downloadFloat32Tiff, downloadUhiTiff } from './exportTiff';
import { boundsExtent, rasterBoundsToWgs84, type RasterBounds } from './rasterGeo';
import { buildUhiSurface, downloadUhiSurface, type UhiSurface } from './uhiSurface';

type Lang = 'pt' | 'en';
type Theme = 'light' | 'dark';
type Provider = 'osm' | 'esri';
type SearchResult = { display_name: string; lat: string; lon: string };
type RasterState = {
  data: Float32Array; width: number; height: number; bounds: RasterBounds; origin: number[]; resolution: number[];
  epsg: number; isProjected: boolean; stats: { min: number; max: number; mean: number; stdDev: number };
  ndvi: Float32Array; ndbi: Float32Array; fileName: string; bands: number;
};
type ComparisonImage = { id: string; name: string; dateLabel: string; lstUrl: string; opticalUrl: string; uhiSurface: UhiSurface; bounds: RasterBounds; width: number; height: number; data: Float32Array; stats: RasterState['stats'] };

const COLAB_URL = 'https://colab.research.google.com/drive/1uKJohUXOqTmbNDZY7N8qVzyk1_laBKIg?usp=sharing';
const TILE_URLS: Record<Provider, string> = {
  osm: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  esri: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
};
const copy = {
  pt: {
    eyebrow: 'OPEN SOURCE • WEB GIS', title: 'SR2D4 / LST Explorer', subtitle: 'Laboratório térmico no navegador para transformar GeoTIFFs multiespectrais em evidência espacial.',
    colab: 'Abrir Colab', upload: 'Carregar produto SR2D4/MS', uploadHint: 'GeoTIFF local • nada é enviado para um servidor', bands: 'Bandas ópticas do SR2D4', red: 'Vermelho (Red)', nir: 'Infravermelho próximo (NIR)', swir: 'Infravermelho de ondas curtas (SWIR)', calculate: 'Calcular mapa térmico', processing: 'Processando raster…', layers: 'Camadas', lst: 'LST / temperatura', optical: 'Imagem óptica', opacity: 'Transparência', contrast: 'Contraste', palette: 'Paleta', stats: 'Resumo estatístico', min: 'mínima', max: 'máxima', mean: 'média', std: 'desvio', histogram: 'Distribuição térmica', sample: 'Escala Térmica & Inspeção', aoi: 'Área de interesse', draw: 'Desenhar AOI', clear: 'Limpar AOI', clip: 'Analisar AOI', export: 'Exportar', png: 'PNG composto', tiff: 'GeoTIFF LST', uhi: 'GeoTIFF UHI', method: 'Metodologia', help: 'Como usar', metadata: 'Metadados', theme: 'Tema', basemap: 'Mapa-base', ready: 'Pronto', error: 'Não foi possível processar. Carregue um GeoTIFF SR2D4 com Red, NIR e SWIR; o Landsat térmico é buscado automaticamente.', methodText: 'O app extrai a data AAAAMMDD do nome do SR2D4, busca automaticamente a cena Landsat 8/9 Collection 2 Level-2 mais próxima, mascara nuvens com QA_PIXEL, decodifica ST_B10 e ajusta uma regressão multivariada com NDVI, NDBI e NDWI. O app executa TsHARP: agrega NDVI/índices do SR2D4 na grade térmica, ajusta a relação LST–NDVI coarse, aplica-a no NDVI fino e adiciona o residual Landsat por célula para conservar a LST observada. A saída usa exatamente a grade nativa do SR2D4; o detalhe térmico é estimado, não uma medição independente em cada pixel.', helpText: '1. Gere o produto MS no Colab com o nome contendo AAAAMMDD e sufixo _MS.tif. 2. Carregue o GeoTIFF SR2D4. 3. Confirme apenas Red/NIR/SWIR do próprio SR2D4. 4. O app busca Landsat 8/9 automaticamente, pela área e data. 5. Explore LST, índices, AOI e exportações.', noData: 'Carregue um GeoTIFF para começar', search: 'Buscar cidade, bairro ou lugar', coords: 'Longitude, latitude', locate: 'Minha localização', go: 'Ir', compare: 'Comparar antes/depois', before: 'Óptico / antes', after: 'LST / depois', indices: 'Índices espectrais', ndvi: 'NDVI vegetação', ndbi: 'NDBI construído', report: 'Relatório rápido', resize: 'Arraste para redimensionar o painel', searchError: 'Local não encontrado.', uhiText: 'Níveis UHI (1m): Frescor, Amenizado, Neutro, Leve, Forte e Extremo.', aoiHelp: 'Ative Desenhar AOI, clique em pelo menos três pontos no mapa e finalize com ✓ ou duplo clique.', aoiStats: 'Média da AOI', limitation: 'Limitações da super-resolução', limitationText: 'A LST detalhada é uma estimativa guiada por índices ópticos. Use-a para investigação espacial e comparação, não como substituta de uma medição térmica de campo.',
  },
  en: {
    eyebrow: 'OPEN SOURCE • WEB GIS', title: 'SR2D4 / LST Explorer', subtitle: 'A browser-based thermal lab for turning multispectral GeoTIFFs into spatial evidence.', colab: 'Open Colab', upload: 'Load SR2D4/MS product', uploadHint: 'Local GeoTIFF • nothing is uploaded to a server', bands: 'SR2D4 optical bands', red: 'Red', nir: 'Near infrared (NIR)', swir: 'Short-wave infrared (SWIR)', calculate: 'Calculate thermal map', processing: 'Processing raster…', layers: 'Layers', lst: 'LST / temperature', optical: 'Optical image', opacity: 'Opacity', contrast: 'Contrast', palette: 'Palette', stats: 'Statistics', min: 'minimum', max: 'maximum', mean: 'mean', std: 'std dev', histogram: 'Temperature distribution', sample: 'Thermal Scale & Inspection', aoi: 'Area of interest', draw: 'Draw AOI', clear: 'Clear AOI', clip: 'Analyze AOI', export: 'Export', png: 'Composite PNG', tiff: 'LST GeoTIFF', uhi: 'UHI GeoTIFF', method: 'Methodology', help: 'How it works', metadata: 'Metadata', theme: 'Theme', basemap: 'Basemap', ready: 'Ready', error: 'Processing failed. Load an SR2D4 GeoTIFF with Red, NIR and SWIR; thermal Landsat is fetched automatically.', methodText: 'The workflow combines SR2D4 imagery with optical indices and TsHARP regression to estimate spatial LST. Spatial detail is estimated: super-resolution does not create independent thermal observations for every new pixel. Validate results with field data.', helpText: '1. Generate the MS product in Colab. 2. Load the GeoTIFF. 3. Confirm Red/NIR/SWIR. 4. Search a place, use GPS or enter coordinates. 5. Calculate and explore LST, indices, AOI and exports.', noData: 'Load a GeoTIFF to begin', search: 'Search city, neighborhood or place', coords: 'Longitude, latitude', locate: 'My location', go: 'Go', compare: 'Compare before/after', before: 'Optical / before', after: 'LST / after', indices: 'Spectral indices', ndvi: 'NDVI vegetation', ndbi: 'NDBI built-up', report: 'Quick report', resize: 'Drag to resize the panel', searchError: 'Place not found.', uhiText: 'UHI levels (1m): Cool island, Mitigated, Neutral, Mild, Strong and Extreme.', aoiHelp: 'Activate Draw AOI, click at least three map points, then finish with ✓ or double-click.', aoiStats: 'AOI mean', limitation: 'Super-resolution limitations', limitationText: 'Detailed LST is an optical-index-guided estimate. Use it for spatial investigation and comparison, not as a replacement for field thermal measurement.',
  },
} as const;

function renderHighDefUhiToCanvas(
  data: Float32Array,
  width: number,
  height: number,
  canvas: HTMLCanvasElement,
  mean: number,
  stdDev: number,
) {
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const img = ctx.createImageData(width, height);
  const out = img.data;
  const safeStd = Math.max(0.8, stdDev);

  const stops: [number, number, number, number][] = [
    [-1.65, 24, 90, 157],
    [-0.95, 43, 140, 104],
    [-0.30, 138, 196, 110],
    [0.15, 247, 226, 139],
    [0.65, 244, 132, 56],
    [1.20, 215, 38, 38],
    [1.90, 255, 242, 175],
  ];

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    const yPrev = Math.max(0, y - 1) * width;
    const yNext = Math.min(height - 1, y + 1) * width;

    for (let x = 0; x < width; x += 1) {
      const i = row + x;
      const val = data[i];
      const px = i * 4;

      if (!Number.isFinite(val)) {
        out[px + 3] = 0;
        continue;
      }

      const z = (val - mean) / safeStd;

      const xPrev = Math.max(0, x - 1);
      const xNext = Math.min(width - 1, x + 1);
      const vE = Number.isFinite(data[row + xNext]) ? data[row + xNext] : val;
      const vW = Number.isFinite(data[row + xPrev]) ? data[row + xPrev] : val;
      const vS = Number.isFinite(data[yNext + x]) ? data[yNext + x] : val;
      const vN = Number.isFinite(data[yPrev + x]) ? data[yPrev + x] : val;

      const slopeShade = ((vE - vW) * 0.7 - (vS - vN) * 0.7) / safeStd;
      const edgeLap = (val - 0.25 * (vE + vW + vS + vN)) / safeStd;
      const reliefFactor = Math.max(-0.22, Math.min(0.22, slopeShade * 0.28 + edgeLap * 0.35));

      let r = stops[stops.length - 1][1];
      let g = stops[stops.length - 1][2];
      let b = stops[stops.length - 1][3];

      if (z <= stops[0][0]) {
        r = stops[0][1];
        g = stops[0][2];
        b = stops[0][3];
      } else {
        for (let s = 0; s < stops.length - 1; s += 1) {
          const [z0, r0, g0, b0] = stops[s];
          const [z1, r1, g1, b1] = stops[s + 1];
          if (z <= z1) {
            const t = Math.max(0, Math.min(1, (z - z0) / (z1 - z0)));
            const tStepped = 0.65 * t + 0.35 * (Math.round(t * 2) / 2);
            r = r0 + (r1 - r0) * tStepped;
            g = g0 + (g1 - g0) * tStepped;
            b = b0 + (b1 - b0) * tStepped;
            break;
          }
        }
      }

      const shadeMult = 1 + reliefFactor;
      out[px] = Math.max(0, Math.min(255
