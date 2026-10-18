import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { calculateOpticalIndices } from './opticalIndices';
import { downscaleLandsatLST } from './downscaling';
import { fetchNearestLandsatThermal, type ThermalProgress } from './landsatAuto';
import { readTiffPixels } from './tiffReader';
import { renderRGBBasemapToCanvas, type PaletteType } from './colorMapper';
import { downloadFloat32Tiff, downloadUhiTiff } from './exportTiff';
import { boundsExtent, rasterBoundsToWgs84, type RasterBounds } from './rasterGeo';
import { buildUhiSurface, downloadUhiSurface, type UhiSurface } from './uhiSurface';

type Lang = 'pt' | 'en';
type Theme = 'light' | 'dark';
type Provider = 'osm' | 'esri';
type UhiClusterMethod = 'zscore' | 'quantiles' | 'natural' | 'kernel';
type SearchResult = { display_name: string; lat: string; lon: string };
type RasterStats = {
  min: number;
  max: number;
  mean: number;
  stdDev: number;
  q25: number;
  q50: number;
  q75: number;
};
type DifferenceStats = {
  min: number;
  max: number;
  mean: number;
  stdDev: number;
  thresholdSigma: number;
  maxScale: number;
  pctDecreased: number;
  pctEqual: number;
  pctIncreased: number;
};
type InspectPoint = {
  temp: number;
  lng: number;
  lat: number;
  beforeTemp?: number;
  afterTemp?: number;
  diffTemp?: number;
};
type RasterState = {
  data: Float32Array;
  width: number;
  height: number;
  bounds: RasterBounds;
  origin: number[];
  resolution: number[];
  epsg: number;
  isProjected: boolean;
  stats: RasterStats;
  ndvi: Float32Array;
  ndbi: Float32Array;
  fileName: string;
  bands: number;
};
type ComparisonImage = {
  id: string;
  name: string;
  dateLabel: string;
  lstUrl: string;
  opticalUrl: string;
  uhiSurface: UhiSurface;
  bounds: RasterBounds;
  width: number;
  height: number;
  data: Float32Array;
  stats: RasterStats;
};

type IsothermFeature = {
  type: 'Feature';
  properties: {
    level: number;
    tempCelsius: number;
    label: string;
    color: string;
    kmlColor: string;
  };
  geometry: {
    type: 'MultiLineString';
    coordinates: [number, number][][];
  };
};

type IsothermCollection = {
  type: 'FeatureCollection';
  features: IsothermFeature[];
};

const COLAB_URL = 'https://colab.research.google.com/drive/1uKJohUXOqTmbNDZY7N8qVzyk1_laBKIg?usp=sharing';
const DEFAULT_CUSTOM_COLORS = ['#0b2c7a', '#167288', '#48b574', '#f5d547', '#e86825', '#b81424'];
const TILE_URLS: Record<Provider, string> = {
  osm: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  esri: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
};

const PALETTE_STOPS: Record<string, string[]> = {
  ironbow: ['#061342', '#103b8c', '#186d8a', '#522b96', '#961774', '#cf2226', '#f26d18', '#ffca28', '#ffffff'],
  spectral: ['#323896', '#2668b8', '#2ba198', '#68c96e', '#c4e667', '#fee08b', '#f88d51', '#d53e4f', '#9e0142'],
  jet: ['#00007f', '#0038ff', '#00aaff', '#14e6a0', '#7dff40', '#ffff00', '#ff8800', '#ff1900', '#800000'],
  viridis: ['#300147', '#3b347a', '#2c688e', '#1f968b', '#38b977', '#7ad151', '#c2df23', '#fde725', '#fff89e'],
  magma: ['#040418', '#1f114b', '#491570', '#782282', '#a8327d', '#d6456c', '#f37152', '#fca86b', '#fcfdbf'],
  coolwarm: ['#1e3c96', '#386cb8', '#6da0d8', '#abd0e6', '#e6e8ed', '#f4b698', '#de6c56', '#b40426', '#7a0218'],
  terrain: ['#15478c', '#1f7a8c', '#3ea362', '#82c458', '#d8cf6a', '#c98e4b', '#9e4f31', '#7d2822', '#fff5eb'],
  grayscale: ['#080a0c', '#24292e', '#454c54', '#68707a', '#8c959f', '#b2bac2', '#d5dce3', '#ffffff'],
};

const UHI_STOPS: [number, number, number, number][] = [
  [-1.65, 16, 62, 138],
  [-1.05, 24, 122, 140],
  [-0.45, 58, 174, 108],
  [0.05, 186, 222, 118],
  [0.50, 248, 214, 104],
  [0.95, 244, 124, 48],
  [1.40, 212, 32, 38],
  [1.95, 255, 244, 184],
];

const DIFFERENCE_GRADIENT_CSS =
  'linear-gradient(90deg, #023e8a 0%, #0096c7 22%, #48cae4 36%, #45525a 37%, #526069 63%, #f77f00 64%, #d62828 84%, #ffea00 100%)';

const copy = {
  pt: {
    eyebrow: 'OPEN SOURCE • WEB GIS',
    title: 'SR2D4 / LST Explorer',
    subtitle: 'Laboratório térmico no navegador para transformar GeoTIFFs multiespectrais em evidência espacial.',
    colab: 'Abrir Colab',
    upload: 'Carregar produto SR2D4/MS',
    uploadHint: 'GeoTIFF local • nada é enviado para um servidor',
    bands: 'Bandas ópticas do SR2D4',
    red: 'Vermelho (Red)',
    nir: 'Infravermelho próximo (NIR)',
    swir: 'Infravermelho de ondas curtas (SWIR)',
    calculate: 'Calcular mapa térmico',
    processing: 'Processando raster…',
    layers: 'Camadas',
    lst: 'LST / temperatura',
    optical: 'Imagem óptica',
    opacity: 'Transparência',
    contrast: 'Contraste',
    palette: 'Paleta',
    stats: 'Resumo estatístico',
    min: 'mínima',
    max: 'máxima',
    mean: 'média',
    std: 'desvio',
    histogram: 'Histograma de Cores & Temperatura',
    sample: 'Escala Térmica & Inspeção',
    aoi: 'Área de interesse',
    draw: 'Desenhar AOI',
    clear: 'Limpar AOI',
    clip: 'Analisar AOI',
    export: 'Exportar',
    png: 'PNG composto',
    tiff: 'GeoTIFF LST',
    uhi: 'GeoTIFF UHI',
    method: 'Metodologia',
    help: 'Como usar',
    metadata: 'Metadados',
    theme: 'Tema',
    basemap: 'Mapa-base',
    ready: 'Pronto',
    error: 'Não foi possível processar. Carregue um GeoTIFF SR2D4 com Red, NIR e SWIR; o Landsat térmico é buscado automaticamente.',
    methodText: 'O app extrai a data AAAAMMDD do nome do SR2D4, busca automaticamente a cena Landsat 8/9 Collection 2 Level-2 mais próxima, mascara nuvens com QA_PIXEL, decodifica ST_B10 e ajusta uma regressão multivariada com NDVI, NDBI e NDWI. O app executa TsHARP: agrega NDVI/índices do SR2D4 na grade térmica, ajusta a relação LST–NDVI coarse, aplica-a no NDVI fino e adiciona o residual Landsat por célula para conservar a LST observada. A saída usa exatamente a grade nativa do SR2D4; o detalhe térmico é estimado, não uma medição independente em cada pixel.',
    helpText: '1. Gere o produto MS no Colab com o nome contendo AAAAMMDD e sufixo _MS.tif. 2. Carregue o GeoTIFF SR2D4. 3. Confirme apenas Red/NIR/SWIR do próprio SR2D4. 4. O app busca Landsat 8/9 automaticamente, pela área e data. 5. Explore LST, índices, AOI e exportações.',
    noData: 'Carregue um GeoTIFF para começar',
    search: 'Buscar cidade, bairro ou lugar',
    coords: 'Longitude, latitude',
    locate: 'Minha localização',
    go: 'Ir',
    compare: 'Comparar antes/depois',
    before: 'Óptico / antes',
    after: 'LST / depois',
    indices: 'Índices espectrais',
    ndvi: 'NDVI vegetação',
    ndbi: 'NDBI construído',
    report: 'Relatório Executivo',
    resize: 'Arraste para redimensionar o painel',
    searchError: 'Local não encontrado.',
    uhiText: 'Níveis UHI (1m): Frescor, Amenizado, Neutro, Leve, Forte e Extremo.',
    aoiHelp: 'Ative Desenhar AOI, clique em pelo menos três pontos no mapa e finalize com ✓ ou duplo clique.',
    aoiStats: 'Média da AOI',
    limitation: 'Limitações da super-resolução',
    limitationText: 'A LST detalhada é uma estimativa guiada por índices ópticos. Use-a para investigação espacial e comparação, não como substituta de uma medição térmica de campo.',
  },
  en: {
    eyebrow: 'OPEN SOURCE • WEB GIS',
    title: 'SR2D4 / LST Explorer',
    subtitle: 'A browser-based thermal lab for turning multispectral GeoTIFFs into spatial evidence.',
    colab: 'Open Colab',
    upload: 'Load SR2D4/MS product',
    uploadHint: 'Local GeoTIFF • nothing is uploaded to a server',
    bands: 'SR2D4 optical bands',
    red: 'Red',
    nir: 'Near infrared (NIR)',
    swir: 'Short-wave infrared (SWIR)',
    calculate: 'Calculate thermal map',
    processing: 'Processing raster…',
    layers: 'Layers',
    lst: 'LST / temperature',
    optical: 'Optical image',
    opacity: 'Opacity',
    contrast: 'Contrast',
    palette: 'Palette',
    stats: 'Statistics',
    min: 'minimum',
    max: 'maximum',
    mean: 'mean',
    std: 'std dev',
    histogram: 'Color & Temperature Histogram',
    sample: 'Thermal Scale & Inspection',
    aoi: 'Area of interest',
    draw: 'Draw AOI',
    clear: 'Clear AOI',
    clip: 'Analyze AOI',
    export: 'Export',
    png: 'Composite PNG',
    tiff: 'LST GeoTIFF',
    uhi: 'UHI GeoTIFF',
    method: 'Methodology',
    help: 'How it works',
    metadata: 'Metadata',
    theme: 'Theme',
    basemap: 'Basemap',
    ready: 'Ready',
    error: 'Processing failed. Load an SR2D4 GeoTIFF with Red, NIR and SWIR; thermal Landsat is fetched automatically.',
    methodText: 'The workflow combines SR2D4 imagery with optical indices and TsHARP regression to estimate spatial LST. Spatial detail is estimated: super-resolution does not create independent thermal observations for every new pixel. Validate results with field data.',
    helpText: '1. Generate the MS product in Colab. 2. Load the GeoTIFF. 3. Confirm Red/NIR/SWIR. 4. Search a place, use GPS or enter coordinates. 5. Calculate and explore LST, indices, AOI and exports.',
    noData: 'Load a GeoTIFF to begin',
    search: 'Search city, neighborhood or place',
    coords: 'Longitude, latitude',
    locate: 'My location',
    go: 'Go',
    compare: 'Compare before/after',
    before: 'Optical / before',
    after: 'LST / after',
    indices: 'Spectral indices',
    ndvi: 'NDVI vegetation',
    ndbi: 'NDBI built-up',
    report: 'Executive Report',
    resize: 'Drag to resize the panel',
    searchError: 'Place not found.',
    uhiText: 'UHI levels (1m): Cool island, Mitigated, Neutral, Mild, Strong and Extreme.',
    aoiHelp: 'Activate Draw AOI, click at least three map points, then finish with ✓ or double-click.',
    aoiStats: 'AOI mean',
    limitation: 'Super-resolution limitations',
    limitationText: 'Detailed LST is an optical-index-guided estimate. Use it for spatial investigation and comparison, not as a replacement for field thermal measurement.',
  },
} as const;

function hexToRgbTuple(hex: string): [number, number, number] {
  const clean = hex.replace('#', '').trim();
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const num = Number.parseInt(full, 16);
  if (Number.isNaN(num)) return [128, 128, 128];
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function perceptualCoolExpansion(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  if (c < 0.56) {
    return 0.58 * Math.pow(c / 0.56, 0.72);
  }
  return 0.58 + 0.42 * Math.pow((c - 0.56) / 0.44, 1.08);
}

function getPaletteStopList(palette: string, customColors: string[]): string[] {
  if (palette === 'custom') return customColors.length >= 2 ? customColors : DEFAULT_CUSTOM_COLORS;
  if (palette === 'uhi') return ['#103e8a', '#187a8c', '#3aae6c', '#bade76', '#f8d668', '#f47c30', '#d42026', '#fff4b8'];
  return PALETTE_STOPS[palette] || PALETTE_STOPS.ironbow;
}

function buildPaletteLut1024(palette: string, customColors: string[]): Uint8Array {
  const stops = getPaletteStopList(palette, customColors).map(hexToRgbTuple);
  const lut = new Uint8Array(1024 * 3);
  const maxSeg = stops.length - 1;

  for (let i = 0; i < 1024; i += 1) {
    const rawT = i / 1023;
    const t = perceptualCoolExpansion(rawT);
    const pos = t * maxSeg;
    const idx = Math.min(maxSeg - 1, Math.floor(pos));
    const frac = pos - idx;
    const [r0, g0, b0] = stops[idx];
    const [r1, g1, b1] = stops[idx + 1];
    lut[i * 3] = Math.round(r0 + (r1 - r0) * frac);
    lut[i * 3 + 1] = Math.round(g0 + (g1 - g0) * frac);
    lut[i * 3 + 2] = Math.round(b0 + (b1 - b0) * frac);
  }
  return lut;
}

function sampleUhiColor(z: number): [number, number, number] {
  if (z <= UHI_STOPS[0][0]) {
    return [UHI_STOPS[0][1], UHI_STOPS[0][2], UHI_STOPS[0][3]];
  }
  for (let s = 0; s < UHI_STOPS.length - 1; s += 1) {
    const [z0, r0, g0, b0] = UHI_STOPS[s];
    const [z1, r1, g1, b1] = UHI_STOPS[s + 1];
    if (z <= z1) {
      const t = Math.max(0, Math.min(1, (z - z0) / (z1 - z0)));
      const tStepped = 0.72 * t + 0.28 * (Math.round(t * 2) / 2);
      return [
        r0 + (r1 - r0) * tStepped,
        g0 + (g1 - g0) * tStepped,
        b0 + (b1 - b0) * tStepped,
      ];
    }
  }
  const last = UHI_STOPS[UHI_STOPS.length - 1];
  return [last[1], last[2], last[3]];
}

function sampleCssColorAt(t: number, palette: string, customColors: string[], isUhi: boolean): string {
  if (isUhi) {
    const z = -1.65 + Math.max(0, Math.min(1, t)) * 3.6;
    const [r, g, b] = sampleUhiColor(z);
    return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
  }
  const stops = getPaletteStopList(palette, customColors).map(hexToRgbTuple);
  const maxSeg = stops.length - 1;
  const p = perceptualCoolExpansion(t) * maxSeg;
  const idx = Math.min(maxSeg - 1, Math.floor(p));
  const frac = p - idx;
  const [r0, g0, b0] = stops[idx];
  const [r1, g1, b1] = stops[idx + 1];
  return `rgb(${Math.round(r0 + (r1 - r0) * frac)}, ${Math.round(g0 + (g1 - g0) * frac)}, ${Math.round(b0 + (b1 - b0) * frac)})`;
}

function computeRasterStats(data: Float32Array): RasterStats | null {
  let absMin = Infinity;
  let absMax = -Infinity;
  let sum = 0;
  let count = 0;
  const sample: number[] = [];
  const step = Math.max(1, Math.floor(data.length / 35000));

  for (let i = 0; i < data.length; i += 1) {
    const v = data[i];
    if (!Number.isFinite(v)) continue;
    if (v < absMin) absMin = v;
    if (v > absMax) absMax = v;
    sum += v;
    count += 1;
    if (i % step === 0) sample.push(v);
  }

  if (count === 0) return null;
  const mean = sum / count;

  let sqDiff = 0;
  for (let i = 0; i < sample.length; i += 1) {
    const d = sample[i] - mean;
    sqDiff += d * d;
  }
  const stdDev = sample.length > 1 ? Math.sqrt(sqDiff / sample.length) : 1;

  sample.sort((a, b) => a - b);
  // Recorte percentílico P0.5 e P99.5 evita que 1 pixel extremo achate a paleta de cores em azul escuro
  const p05 = sample[Math.floor(sample.length * 0.005)] ?? absMin;
  const p995 = sample[Math.floor(sample.length * 0.995)] ?? absMax;
  const q25 = sample[Math.floor(sample.length * 0.25)] ?? p05;
  const q50 = sample[Math.floor(sample.length * 0.5)] ?? mean;
  const q75 = sample[Math.floor(sample.length * 0.75)] ?? p995;

  return { min: p05, max: p995, mean, stdDev, q25, q50, q75 };
}

function renderPerceptualLstToCanvas(
  data: Float32Array,
  width: number,
  height: number,
  canvas: HTMLCanvasElement,
  palette: string,
  customColors: string[],
  existingStats?: RasterStats,
): RasterStats | null {
  const stats = existingStats ?? computeRasterStats(data);
  if (!stats) return null;

  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return stats;

  const img = ctx.createImageData(width, height);
  const out = img.data;
  const lut = buildPaletteLut1024(palette, customColors);
  const span = Math.max(1e-5, stats.max - stats.min);
  const invSpan = 1023 / span;

  for (let i = 0; i < data.length; i += 1) {
    const v = data[i];
    const px = i * 4;
    if (!Number.isFinite(v)) {
      out[px + 3] = 0;
      continue;
    }
    const lutIdx = Math.max(0, Math.min(1023, Math.round((v - stats.min) * invSpan))) * 3;
    out[px] = lut[lutIdx];
    out[px + 1] = lut[lutIdx + 1];
    out[px + 2] = lut[lutIdx + 2];
    out[px + 3] = 255;
  }

  ctx.putImageData(img, 0, 0);
  return stats;
}

function computeClusteredZ(
  val: number,
  neighborMean: number,
  stats: RasterStats,
  method: UhiClusterMethod,
  power: number,
): number {
  const safeStd = Math.max(0.6, stats.stdDev);
  const iqr = Math.max(0.5, stats.q75 - stats.q25);
  const norm = (val - stats.min) / Math.max(0.5, stats.max - stats.min);
  const centered = (norm - 0.46) * 3.3;

  const baseZ =
    method === 'quantiles'
      ? ((val - stats.q50) / (iqr * 0.68)) * 0.92
      : method === 'natural'
        ? centered + 0.18 * Math.sin(centered * Math.PI)
        : method === 'kernel'
          ? (((0.42 * val + 0.58 * neighborMean) - stats.mean) / safeStd) * 1.15
          : (val - stats.mean) / safeStd;

  const sign = baseZ < 0 ? -1 : 1;
  return sign * Math.pow(Math.abs(baseZ), power);
}

function renderHighDefUhiToCanvas(
  data: Float32Array,
  width: number,
  height: number,
  canvas: HTMLCanvasElement,
  stats: RasterStats,
  method: UhiClusterMethod,
  power: number,
) {
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const img = ctx.createImageData(width, height);
  const out = img.data;
  const safeStd = Math.max(0.8, stats.stdDev);

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    const yPrev = Math.max(0, y - 1) * width;
    const yNext = Math.min(height - 1, y + 1) * width;
    const yFarPrev = Math.max(0, y - 3) * width;
    const yFarNext = Math.min(height - 1, y + 3) * width;

    for (let x = 0; x < width; x += 1) {
      const i = row + x;
      const val = data[i];
      const px = i * 4;

      if (!Number.isFinite(val)) {
        out[px + 3] = 0;
        continue;
      }

      const xPrev = Math.max(0, x - 1);
      const xNext = Math.min(width - 1, x + 1);
      const xFarPrev = Math.max(0, x - 3);
      const xFarNext = Math.min(width - 1, x + 3);

      const vE = Number.isFinite(data[row + xNext]) ? data[row + xNext] : val;
      const vW = Number.isFinite(data[row + xPrev]) ? data[row + xPrev] : val;
      const vS = Number.isFinite(data[yNext + x]) ? data[yNext + x] : val;
      const vN = Number.isFinite(data[yPrev + x]) ? data[yPrev + x] : val;

      const vFarE = Number.isFinite(data[row + xFarNext]) ? data[row + xFarNext] : val;
      const vFarW = Number.isFinite(data[row + xFarPrev]) ? data[row + xFarPrev] : val;
      const vFarS = Number.isFinite(data[yFarNext + x]) ? data[yFarNext + x] : val;
      const vFarN = Number.isFinite(data[yFarPrev + x]) ? data[yFarPrev + x] : val;

      const neighborMean = 0.125 * (vE + vW + vS + vN + vFarE + vFarW + vFarS + vFarN);
      const z = computeClusteredZ(val, neighborMean, stats, method, power);

      const slopeShade = ((vE - vW) * 0.7 - (vS - vN) * 0.7) / safeStd;
      const edgeLap = (val - 0.25 * (vE + vW + vS + vN)) / safeStd;
      const reliefFactor = Math.max(-0.24, Math.min(0.24, slopeShade * 0.28 + edgeLap * 0.38));

      const [r, g, b] = sampleUhiColor(z);
      const shadeMult = 1 + reliefFactor;
      out[px] = Math.max(0, Math.min(255, Math.round(r * shadeMult)));
      out[px + 1] = Math.max(0, Math.min(255, Math.round(g * shadeMult)));
      out[px + 2] = Math.max(0, Math.min(255, Math.round(b * shadeMult)));
      out[px + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
}

function buildMesoIsothermsGeoJSON(
  data: Float32Array,
  width: number,
  height: number,
  bounds: RasterBounds,
  stats: RasterStats,
  method: UhiClusterMethod,
  power: number,
): IsothermCollection {
  const ext = boundsExtent(bounds);
  const gW = 96;
  const gH = Math.max(24, Math.round((height / Math.max(1, width)) * gW));
  const rawGrid = new Float32Array(gW * gH);
  const counts = new Uint32Array(gW * gH);

  for (let y = 0; y < height; y += 2) {
    const gy = Math.min(gH - 1, Math.floor((y / height) * gH));
    const row = y * width;
    for (let x = 0; x < width; x += 2) {
      const v = data[row + x];
      if (!Number.isFinite(v)) continue;
      const gx = Math.min(gW - 1, Math.floor((x / width) * gW));
      const idx = gy * gW + gx;
      rawGrid[idx] += v;
      counts[idx] += 1;
    }
  }

  let grid = new Float32Array(gW * gH);
  for (let i = 0; i < grid.length; i += 1) {
    grid[i] = counts[i] > 0 ? rawGrid[i] / counts[i] : stats.mean;
  }

  const passes = method === 'kernel' ? 4 : 3;
  const kernel = [1, 2, 1, 2, 4, 2, 1, 2, 1];
  for (let pass = 0; pass < passes; pass += 1) {
    const next = new Float32Array(gW * gH);
    for (let y = 0; y < gH; y += 1) {
      for (let x = 0; x < gW; x += 1) {
        let sum = 0;
        let wSum = 0;
        for (let ky = -1; ky <= 1; ky += 1) {
          for (let kx = -1; kx <= 1; kx += 1) {
            const ny = Math.max(0, Math.min(gH - 1, y + ky));
            const nx = Math.max(0, Math.min(gW - 1, x + kx));
            const kw = kernel[(ky + 1) * 3 + (kx + 1)];
            sum += grid[ny * gW + nx] * kw;
            wSum += kw;
          }
        }
        next[y * gW + x] = sum / wSum;
      }
    }
    grid = next;
  }

  const safeStd = Math.max(0.8, stats.stdDev);
  const invPower = 1 / Math.max(0.5, power);
  const baseZ = [-0.95, -0.35, 0.20, 0.75, 1.25];
  const labels = [
    { label: 'Ilha de Frescor', color: '#38bdf8', kmlColor: 'fff8bd38' },
    { label: 'Zona Amenizada', color: '#34d399', kmlColor: 'ff99d334' },
    { label: 'Limiar UHI Leve', color: '#fde047', kmlColor: 'ff47e0fd' },
    { label: 'Cluster UHI Forte', color: '#fb923c', kmlColor: 'ff3c92fb' },
    { label: 'Hotspot Extremo', color: '#f43f5e', kmlColor: 'ff5e3ff4' },
  ];

  const centerRef = method === 'quantiles' ? stats.q50 : stats.mean;
  const scaleRef = method === 'quantiles' ? Math.max(0.6, (stats.q75 - stats.q25) * 0.75) : safeStd;

  const toLng = (gx: number) => ext.west + ((gx + 0.5) / gW) * (ext.east - ext.west);
  const toLat = (gy: number) => ext.north - ((gy + 0.5) / gH) * (ext.north - ext.south);

  const features: IsothermFeature[] = [];

  labels.forEach((lvl, idx) => {
    const rawZ = baseZ[idx];
    const zAdj = (rawZ < 0 ? -1 : 1) * Math.pow(Math.abs(rawZ), invPower);
    const iso = Number((centerRef + zAdj * scaleRef).toFixed(2));
    const segments: [number, number][][] = [];

    for (let y = 0; y < gH - 1; y += 1) {
      for (let x = 0; x < gW - 1; x += 1) {
        const v0 = grid[y * gW + x];
        const v1 = grid[y * gW + (x + 1)];
        const v2 = grid[(y + 1) * gW + (x + 1)];
        const v3 = grid[(y + 1) * gW + x];

        const mask =
          (v0 >= iso ? 1 : 0) +
          (v1 >= iso ? 2 : 0) +
          (v2 >= iso ? 4 : 0) +
          (v3 >= iso ? 8 : 0);

        if (mask === 0 || mask === 15) continue;

        const interp = (a: number, b: number) => {
          const d = b - a;
          return Math.abs(d) < 1e-6 ? 0.5 : Math.max(0, Math.min(1, (iso - a) / d));
        };

        const top: [number, number] = [toLng(x + interp(v0, v1)), toLat(y)];
        const right: [number, number] = [toLng(x + 1), toLat(y + interp(v1, v2))];
        const bottom: [number, number] = [toLng(x + interp(v3, v2)), toLat(y + 1)];
        const left: [number, number] = [toLng(x), toLat(y + interp(v0, v3))];

        if (mask === 1 || mask === 14) segments.push([left, top]);
        else if (mask === 2 || mask === 13) segments.push([top, right]);
        else if (mask === 4 || mask === 11) segments.push([right, bottom]);
        else if (mask === 8 || mask === 7) segments.push([bottom, left]);
        else if (mask === 3 || mask === 12) segments.push([left, right]);
        else if (mask === 6 || mask === 9) segments.push([top, bottom]);
        else if (mask === 5) {
          segments.push([left, bottom]);
          segments.push([top, right]);
        } else if (mask === 10) {
          segments.push([left, top]);
          segments.push([bottom, right]);
        }
      }
    }

    if (segments.length > 0) {
      features.push({
        type: 'Feature',
        properties: {
          level: idx + 1,
          tempCelsius: iso,
          label: `${lvl.label} (${iso.toFixed(1)}°C)`,
          color: lvl.color,
          kmlColor: lvl.kmlColor,
        },
        geometry: {
          type: 'MultiLineString',
          coordinates: segments,
        },
      });
    }
  });

  return { type: 'FeatureCollection', features };
}

function LogoMark() {
  return (
    <svg className="logo-mark" viewBox="0 0 44 44" role="img" aria-label="SR2D4 LST Explorer logo">
      <defs>
        <linearGradient id="thermal-logo" x1="0" x2="1">
          <stop stopColor="#4324a8" />
          <stop offset=".52" stopColor="#f04435" />
          <stop offset="1" stopColor="#ffc400" />
        </linearGradient>
      </defs>
      <path d="M22 3c8 0 15 5 18 12-6-2-11-1-16 3-5 4-8 10-8 18-6-4-10-10-10-17C6 10 13 3 22 3Z" fill="url(#thermal-logo)" />
      <path d="M10 31c5-4 11-6 18-5 4 1 7 3 10 6-4 6-10 9-17 9-4 0-8-1-11-3Z" fill="none" stroke="#79e2dc" strokeWidth="2" />
      <circle cx="27" cy="14" r="3" fill="#fff5bf" />
    </svg>
  );
}

function Icon({ name }: { name: 'search' | 'gps' | 'pin' | 'resize' | 'layers' | 'sun' | 'moon' }) {
  const paths = {
    search: <><circle cx="11" cy="11" r="6" /><path d="m16 16 5 5" /></>,
    gps: <><circle cx="12" cy="12" r="7" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M12 9v6M9 12h6" /></>,
    pin: <><path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z" /><circle cx="12" cy="10" r="2.5" /></>,
    resize: <><path d="M8 3H3v5M16 21h5v-5M3 3l7 7M21 21l-7-7" /></>,
    layers: <><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5M3 16l9 5 9-5" /></>,
    sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
    moon: <path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z" />,
  }[name];
  return (
    <svg className="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {paths}
    </svg>
  );
}

function LayerRow({ label, visible, onToggle, color }: { label: string; visible: boolean; onToggle: () => void; color: string }) {
  return (
    <button className="layer-row" onClick={onToggle}>
      <span className={`layer-swatch ${color}`} />
      <span>{label}</span>
      <span className="layer-state">{visible ? 'VISIBLE' : 'HIDDEN'}</span>
    </button>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <small>{label}</small>
      <strong>{value}</strong>
    </div>
  );
}

function meanOf(data: Float32Array) {
  let sum = 0;
  let count = 0;
  for (const value of data) {
    if (Number.isFinite(value)) {
      sum += value;
      count += 1;
    }
  }
  return count ? sum / count : 0;
}

async function buildAutomaticThermalRaster(file: File, bandIndexes: [number, number, number], onProgress?: ThermalProgress) {
  onProgress?.('Abrindo GeoTIFF SR2D4 e lendo metadata…');
  const tiff = await readTiffPixels(file);
  if (tiff.rasters.length < 3) throw new Error('SR2D4 precisa conter Red, NIR e SWIR.');
  const red = tiff.rasters[bandIndexes[0]] as Float32Array;
  const nir = tiff.rasters[bandIndexes[1]] as Float32Array;
  const swir = tiff.rasters[bandIndexes[2]] as Float32Array;
  if (!red || !nir || !swir) throw new Error('As bandas ópticas selecionadas não existem no SR2D4.');
  const bounds = rasterBoundsToWgs84(tiff.origin, tiff.resolution, tiff.width, tiff.height, tiff.epsg);
  onProgress?.(`SR2D4 lido: ${tiff.width.toLocaleString()}×${tiff.height.toLocaleString()} px · calculando extensão geográfica…`);
  const landsat = await fetchNearestLandsatThermal(file.name, bounds, onProgress);
  onProgress?.('Calculando NDVI, NDBI e NDWI nas bandas selecionadas…');
  const indices = calculateOpticalIndices(red, nir, swir);
  onProgress?.('Executando TsHARP HD 1m: separando telhados, ruas, pista e dossel arbóreo…');
  const result = downscaleLandsatLST(
    landsat.lstCelsius,
    landsat.width,
    landsat.height,
    landsat.bounds,
    { ...indices, red, nir, swir },
    tiff.width,
    tiff.height,
    bounds,
  );
  const resolutionLabel = tiff.isProjected ? `${Math.abs(tiff.resolution[0]).toFixed(2)} m/pixel` : `${Math.abs(tiff.resolution[0]).toFixed(6)} graus/pixel`;
  onProgress?.(`Fusão concluída: ${result.model} · ${result.validCount} células coarse · coef. NDVI ${result.slope.toFixed(4)} · saída ${tiff.width.toLocaleString()}×${tiff.height.toLocaleString()} px · resolução ${resolutionLabel}`);
  onProgress?.(`Prova numérica: LST coarse ${result.coarseRange.toFixed(2)} °C · LST fina ${result.fineRange.toFixed(2)} °C · sinal transferido do SR2D4 ${result.fineSignalRange.toFixed(2)} °C · erro médio de conservação ${result.conservationMae.toFixed(3)} °C`);
  return { tiff, bounds, indices, landsat, result };
}

function pointInPolygon(point: [number, number], polygon: [number, number][]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersects = ((yi > point[1]) !== (yj > point[1])) && point[0] < ((xj - xi) * (point[1] - yi)) / ((yj - yi) || Number.EPSILON) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function thermalDifference(
  primary: { data: Float32Array; width: number; height: number; bounds: RasterBounds; stats: { stdDev: number } },
  secondary: { data: Float32Array; width: number; height: number; bounds: RasterBounds; stats: { stdDev: number } },
) {
  const result = new Float32Array(primary.width * primary.height);
  const primaryExtent = boundsExtent(primary.bounds);
  const secondaryExtent = boundsExtent(secondary.bounds);
  for (let y = 0; y < primary.height; y += 1) {
    for (let x = 0; x < primary.width; x += 1) {
      const lng = primaryExtent.west + ((x + 0.5) / primary.width) * (primaryExtent.east - primaryExtent.west);
      const lat = primaryExtent.north - ((y + 0.5) / primary.height) * (primaryExtent.north - primaryExtent.south);
      const sx = Math.floor(((lng - secondaryExtent.west) / (secondaryExtent.east - secondaryExtent.west)) * secondary.width);
      const sy = Math.floor(((secondaryExtent.north - lat) / (secondaryExtent.north - secondaryExtent.south)) * secondary.height);
      const a = primary.data[y * primary.width + x];
      const b = sx >= 0 && sy >= 0 && sx < secondary.width && sy < secondary.height ? secondary.data[sy * secondary.width + sx] : NaN;
      result[y * primary.width + x] = Number.isFinite(a) && Number.isFinite(b) ? b - a : NaN;
    }
  }
  return result;
}

function sampleDiffColor(centeredDiff: number, sigma: number, maxScale: number): [number, number, number] {
  const absV = Math.abs(centeredDiff);
  // Variação dentro de ±1σ em torno da tendência sazonal da cena: Cinza-Ardoise Neutro (Permaneceu Igual)
  if (absV <= sigma) {
    const t = centeredDiff / Math.max(0.1, sigma);
    return [
      Math.round(68 + t * 8),
      Math.round(80 - Math.abs(t) * 4),
      Math.round(88 - t * 8),
    ];
  }

  const norm = Math.min(1, (absV - sigma) / Math.max(0.35, maxScale - sigma));
  if (centeredDiff < -sigma) {
    // Diminuiu (< μΔ - 1σ): Azul-Turquesa vibrante -> Azul-Royal Profundo
    if (norm < 0.5) {
      const u = norm * 2;
      return [
        Math.round(72 + (0 - 72) * u),
        Math.round(202 + (136 - 202) * u),
        Math.round(228 + (204 - 228) * u),
      ];
    }
    const u = (norm - 0.5) * 2;
    return [
      Math.round(0 + (3 - 0) * u),
      Math.round(136 + (35 - 136) * u),
      Math.round(204 + (138 - 204) * u),
    ];
  }

  // Aumentou (> μΔ + 1σ): Laranja Forte -> Vermelho Rubi -> Amarelo Ouro
  if (norm < 0.55) {
    const u = norm / 0.55;
    return [
      Math.round(247 + (214 - 247) * u),
      Math.round(127 + (40 - 127) * u),
      Math.round(0 + (40 - 0) * u),
    ];
  }
  const u = (norm - 0.55) / 0.45;
  return [
    Math.round(214 + (255 - 214) * u),
    Math.round(40 + (234 - 40) * u),
    Math.round(40 + (0 - 40) * u),
  ];
}

function renderDifferenceToCanvas(
  data: Float32Array,
  baseTemp: Float32Array,
  width: number,
  height: number,
  canvas: HTMLCanvasElement,
): DifferenceStats | null {
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let count = 0;
  const step = Math.max(1, Math.floor(data.length / 25000));

  for (let i = 0; i < data.length; i += 1) {
    const v = data[i];
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    count += 1;
  }

  if (count === 0) return null;
  const mean = sum / count;

  let sqSum = 0;
  let sqCount = 0;
  const devSamples: number[] = [];
  for (let i = 0; i < data.length; i += step) {
    const v = data[i];
    if (!Number.isFinite(v)) continue;
    const d = v - mean;
    sqSum += d * d;
    sqCount += 1;
    devSamples.push(Math.abs(d));
  }
  const stdDev = sqCount > 1 ? Math.sqrt(sqSum / sqCount) : 0.8;
  const thresholdSigma = Math.max(0.25, stdDev);

  devSamples.sort((a, b) => a - b);
  const p98 = devSamples[Math.floor(devSamples.length * 0.985)] ?? thresholdSigma * 2.5;
  const maxScale = Math.max(thresholdSigma * 1.8, p98);

  let decCount = 0;
  let eqCount = 0;
  let incCount = 0;

  const image = ctx.createImageData(width, height);
  const out = image.data;

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    const yPrev = Math.max(0, y - 1) * width;
    const yNext = Math.min(height - 1, y + 1) * width;

    for (let x = 0; x < width; x += 1) {
      const i = row + x;
      const value = data[i];
      const px = i * 4;
      if (!Number.isFinite(value)) {
        out[px + 3] = 0;
        continue;
      }

      // Desvio da estrutura em relação à variação sazonal média da cena (μΔ)
      const centeredDiff = value - mean;
      if (centeredDiff < -thresholdSigma) decCount += 1;
      else if (centeredDiff > thresholdSigma) incCount += 1;
      else eqCount += 1;

      const xPrev = Math.max(0, x - 1);
      const xNext = Math.min(width - 1, x + 1);
      const bC = Number.isFinite(baseTemp[i]) ? baseTemp[i] : 0;
      const bE = Number.isFinite(baseTemp[row + xNext]) ? baseTemp[row + xNext] : bC;
      const bW = Number.isFinite(baseTemp[row + xPrev]) ? baseTemp[row + xPrev] : bC;
      const bS = Number.isFinite(baseTemp[yNext + x]) ? baseTemp[yNext + x] : bC;
      const bN = Number.isFinite(baseTemp[yPrev + x]) ? data[yPrev + x] : bC;

      const microRelief = Math.max(-0.18, Math.min(0.18, ((bE - bW) * 0.12 - (bS - bN) * 0.12) + (bC - 0.25 * (bE + bW + bS + bN)) * 0.22));
      const [r, g, b] = sampleDiffColor(centeredDiff, thresholdSigma, maxScale);
      const mult = 1 + microRelief;

      out[px] = Math.max(0, Math.min(255, Math.round(r * mult)));
      out[px + 1] = Math.max(0, Math.min(255, Math.round(g * mult)));
      out[px + 2] = Math.max(0, Math.min(255, Math.round(b * mult)));
      out[px + 3] = 255;
    }
  }

  ctx.putImageData(image, 0, 0);

  return {
    min,
    max,
    mean,
    stdDev,
    thresholdSigma,
    maxScale,
    pctDecreased: (decCount / count) * 100,
    pctEqual: (eqCount / count) * 100,
    pctIncreased: (incCount / count) * 100,
  };
}

function differenceClassLabel(diff: number, meanDiff: number, sigma: number, lang: Lang): { label: string; color: string; rel: number } {
  if (!Number.isFinite(diff)) return { label: '—', color: '#9ab0b5', rel: 0 };
  const rel = diff - meanDiff;
  if (rel < -2 * sigma) {
    return {
      label: lang === 'pt' ? `↓ DIMINUIU FORTE (< -2σ)` : `↓ STRONG COOLING (< -2σ)`,
      color: '#38bdf8',
      rel,
    };
  }
  if (rel < -sigma) {
    return {
      label: lang === 'pt' ? `↓ DIMINUIU (abaixo de -1σ)` : `↓ DECREASED (< -1σ)`,
      color: '#48cae4',
      rel,
    };
  }
  if (rel > 2 * sigma) {
    return {
      label: lang === 'pt' ? `↑ AUMENTOU FORTE (> +2σ)` : `↑ STRONG WARMING (> +2σ)`,
      color: '#ffea00',
      rel,
    };
  }
  if (rel > sigma) {
    return {
      label: lang === 'pt' ? `↑ AUMENTOU (acima de +1σ)` : `↑ INCREASED (> +1σ)`,
      color: '#ff7b29',
      rel,
    };
  }
  return {
    label: lang === 'pt' ? `＝ PERMANECEU IGUAL (dentro de ±1σ)` : `＝ REMAINED EQUAL (within ±1σ)`,
    color: '#a3b8c2',
    rel,
  };
}

function uhiClassLabel(value: number, stats: RasterStats, method: UhiClusterMethod, power: number, lang: Lang) {
  if (!Number.isFinite(value)) return '—';
  const z = computeClusteredZ(value, value, stats, method, power);
  if (z < -0.95) return lang === 'pt' ? 'Ilha de Frescor' : 'Cool Island';
  if (z < -0.30) return lang === 'pt' ? 'Amenizado' : 'Mitigated';
  if (z < 0.25) return lang === 'pt' ? 'Neutro' : 'Neutral';
  if (z < 0.85) return lang === 'pt' ? 'UHI Moderada' : 'Moderate UHI';
  if (z < 1.40) return lang === 'pt' ? 'UHI Forte' : 'Strong UHI';
  return lang === 'pt' ? 'UHI Extrema (Hotspot)' : 'Extreme Hotspot';
}

function imageDateLabel(name: string, index: number) {
  const match = name.match(/(20\d{2})[-_]?([01]\d)[-_]?([0-3]\d)/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : `Data ${String(index + 1).padStart(2, '0')}`;
}

function paletteGradient(palette: string, customColors: string[]) {
  const samplePoints = Array.from({ length: 13 }, (_, idx) => sampleCssColorAt(idx / 12, palette, customColors, false));
  return `linear-gradient(90deg, ${samplePoints.join(', ')})`;
}

export default function App() {
  const [lang, setLang] = useState<Lang>(() => (navigator.language.toLowerCase().startsWith('pt') ? 'pt' : 'en'));
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('lst-theme') as Theme) || 'dark');
  const [provider, setProvider] = useState<Provider>('osm');
  const [raster, setRaster] = useState<RasterState | null>(null);
  const [lstUrl, setLstUrl] = useState<string | null>(null);
  const [opticalUrl, setOpticalUrl] = useState<string | null>(null);
  const [visibleLst, setVisibleLst] = useState(true);
  const [visibleOptical, setVisibleOptical] = useState(true);
  const [opacity, setOpacity] = useState(0.96);
  const [contrast, setContrast] = useState(0);
  const [palette, setPalette] = useState<PaletteType>('ironbow');
  const [customColors, setCustomColors] = useState<string[]>(DEFAULT_CUSTOM_COLORS);
  const [draftCustomColors, setDraftCustomColors] = useState<string[]>(DEFAULT_CUSTOM_COLORS);
  const [displayMode, setDisplayMode] = useState<'temperature' | 'uhi'>('temperature');
  const [uhiMethod, setUhiMethod] = useState<UhiClusterMethod>('zscore');
  const [uhiPower, setUhiPower] = useState(1.10);
  const [file, setFile] = useState<File | null>(null);
  const [bandCount, setBandCount] = useState(3);
  const [bandLabels, setBandLabels] = useState<string[]>([]);
  const [bands, setBands] = useState(['0', '1', '2']);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [processingLog, setProcessingLog] = useState<Array<{ time: string; message: string; level: 'info' | 'success' | 'error' }>>([]);
  const [sample, setSample] = useState<InspectPoint | null>(null);
  const [hoverSample, setHoverSample] = useState<InspectPoint | null>(null);
  const [identifyMode, setIdentifyMode] = useState(false);
  const [panEnabled, setPanEnabled] = useState(true);
  const [showMethod, setShowMethod] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showMeta, setShowMeta] = useState(false);
  const [showLimits, setShowLimits] = useState(false);
  const [showTutorial, setShowTutorial] = useState(() => sessionStorage.getItem('sr2d4-tutorial-seen') !== '1');
  const [tutorialStep, setTutorialStep] = useState(0);
  const [showSearch, setShowSearch] = useState(true);
  const [aoi, setAoi] = useState<[number, number][]>([]);
  const [aoiCursor, setAoiCursor] = useState<[number, number] | null>(null);
  const [drawAoi, setDrawAoi] = useState(false);
  const [aoiStats, setAoiStats] = useState<{ count: number; min: number; max: number; mean: number } | null>(null);
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [coordText, setCoordText] = useState('');
  const [comparisonCount, setComparisonCount] = useState(2);
  const [comparisonFiles, setComparisonFiles] = useState<(File | null)[]>([null, null]);
  const [comparisonImages, setComparisonImages] = useState<ComparisonImage[]>([]);
  const [comparisonMode, setComparisonMode] = useState<'difference' | 'secondary'>('difference');
  const [differenceReady, setDifferenceReady] = useState(false);
  const [swipeActive, setSwipeActive] = useState(false);
  const [swipePosition, setSwipePosition] = useState(50);
  const [uhiSurface, setUhiSurface] = useState<UhiSurface | null>(null);
  const [isotherms, setIsotherms] = useState<IsothermCollection | null>(null);
  const [uhiSurfaceVisible, setUhiSurfaceVisible] = useState(false);
  const [panelWidth, setPanelWidth] = useState(390);

  const resizing = useRef(false);
  const curtainDragging = useRef(false);
  const curtainMapRef = useRef<MapLibreMap | null>(null);
  const curtainContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<MapLibreMap | null>(null);
  const lastFittedKey = useRef<string>('');
  const lstCanvas = useRef<HTMLCanvasElement | null>(null);
  const opticalCanvas = useRef<HTMLCanvasElement | null>(null);

  const t = copy[lang];
  const extent = useMemo(() => (raster ? boundsExtent(raster.bounds) : null), [raster]);
  const comparisonPrimary = comparisonImages[0] ?? null;
  const comparisonSecondary = comparisonImages[1] ?? null;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setCustomColors(draftCustomColors);
    }, 140);
    return () => window.clearTimeout(timer);
  }, [draftCustomColors]);

  const differenceRender = useMemo(() => {
    if (!comparisonPrimary || !comparisonSecondary || !differenceReady) return null;
    const data = thermalDifference(comparisonPrimary, comparisonSecondary);
    const canvas = document.createElement('canvas');
    const stats = renderDifferenceToCanvas(
      data,
      comparisonPrimary.data,
      comparisonPrimary.width,
      comparisonPrimary.height,
      canvas,
    );
    if (!stats) return null;
    return { url: canvas.toDataURL('image/png'), stats, data };
  }, [comparisonPrimary, comparisonSecondary, differenceReady]);

  const mapClickMode = useRef({
    drawAoi: false,
    raster: null as RasterState | null,
    extent: null as ReturnType<typeof boundsExtent> | null,
    identifyMode: false,
    comparisonPrimary: null as ComparisonImage | null,
    comparisonSecondary: null as ComparisonImage | null,
    differenceData: null as Float32Array | null,
    differenceReady: false,
  });

  const uhiGradient = 'linear-gradient(90deg, #103e8a, #187a8c, #3aae6c, #bade76, #f8d668, #f47c30, #d42026, #fff4b8)';
  const legendGradient = displayMode === 'uhi' ? uhiGradient : paletteGradient(palette, draftCustomColors);
  const differenceStats = differenceRender?.stats ?? null;

  useEffect(() => {
    localStorage.setItem('lst-theme', theme);
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    mapClickMode.current = {
      drawAoi,
      raster,
      extent,
      identifyMode,
      comparisonPrimary,
      comparisonSecondary,
      differenceData: differenceRender?.data ?? null,
      differenceReady,
    };
  }, [drawAoi, raster, extent, identifyMode, comparisonPrimary, comparisonSecondary, differenceRender, differenceReady]);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      if (resizing.current) setPanelWidth(Math.max(330, Math.min(560, window.innerWidth - event.clientX)));
      if (curtainDragging.current) {
        const stage = document.querySelector('.map-stage') as HTMLElement | null;
        if (stage) {
          const rect = stage.getBoundingClientRect();
          setSwipePosition(Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100)));
        }
      }
    };
    const onUp = () => {
      resizing.current = false;
      curtainDragging.current = false;
      document.body.classList.remove('is-resizing');
      document.body.classList.remove('is-curtain-dragging');
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, []);

  // Cálculo rápido da AOI usando caixa envolvente (bounding box) para nunca travar o navegador
  const computeAoiStatsForPolygon = useCallback(
    (poly: [number, number][]) => {
      if (!raster || poly.length < 3 || !extent) return null;
      let west = Infinity;
      let east = -Infinity;
      let south = Infinity;
      let north = -Infinity;
      for (const pt of poly) {
        if (pt[0] < west) west = pt[0];
        if (pt[0] > east) east = pt[0];
        if (pt[1] < south) south = pt[1];
        if (pt[1] > north) north = pt[1];
      }
      const x0 = Math.max(0, Math.floor(((west - extent.west) / (extent.east - extent.west)) * raster.width));
      const x1 = Math.min(raster.width - 1, Math.ceil(((east - extent.west) / (extent.east - extent.west)) * raster.width));
      const y0 = Math.max(0, Math.floor(((extent.north - north) / (extent.north - extent.south)) * raster.height));
      const y1 = Math.min(raster.height - 1, Math.ceil(((extent.north - south) / (extent.north - extent.south)) * raster.height));

      let sum = 0;
      let count = 0;
      let min = Infinity;
      let max = -Infinity;
      const spanLng = extent.east - extent.west;
      const spanLat = extent.north - extent.south;

      for (let y = y0; y <= y1; y += 1) {
        const lat = extent.north - ((y + 0.5) / raster.height) * spanLat;
        const row = y * raster.width;
        for (let x = x0; x <= x1; x += 1) {
          const val = raster.data[row + x];
          if (!Number.isFinite(val)) continue;
          const lng = extent.west + ((x + 0.5) / raster.width) * spanLng;
          if (pointInPolygon([lng, lat], poly)) {
            sum += val;
            count += 1;
            if (val < min) min = val;
            if (val > max) max = val;
          }
        }
      }
      if (!count) return null;
      return { count, min, max, mean: sum / count };
    },
    [extent, raster],
  );

  useEffect(() => {
    if (!mapRef.current || mapInstance.current) return;
    const map = new maplibregl.Map({
      container: mapRef.current,
      style: {
        version: 8,
        sources: {
          basemap: { type: 'raster', tiles: [TILE_URLS.osm], tileSize: 256, attribution: '© OpenStreetMap contributors' },
        },
        layers: [{ id: 'basemap', type: 'raster', source: 'basemap' }],
      },
      center: [-46.63, -23.55],
      zoom: 4,
      attributionControl: false,
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

    const inspectAt = (event: maplibregl.MapMouseEvent, commit: boolean) => {
      const mode = mapClickMode.current;
      if (mode.differenceReady && mode.comparisonPrimary && mode.comparisonSecondary && mode.differenceData) {
        const pExt = boundsExtent(mode.comparisonPrimary.bounds);
        const sExt = boundsExtent(mode.comparisonSecondary.bounds);
        const px = Math.floor(((event.lngLat.lng - pExt.west) / (pExt.east - pExt.west)) * mode.comparisonPrimary.width);
        const py = Math.floor(((pExt.north - event.lngLat.lat) / (pExt.north - pExt.south)) * mode.comparisonPrimary.height);
        const sx = Math.floor(((event.lngLat.lng - sExt.west) / (sExt.east - sExt.west)) * mode.comparisonSecondary.width);
        const sy = Math.floor(((sExt.north - event.lngLat.lat) / (sExt.north - sExt.south)) * mode.comparisonSecondary.height);

        if (px >= 0 && py >= 0 && px < mode.comparisonPrimary.width && py < mode.comparisonPrimary.height) {
          const idx1 = py * mode.comparisonPrimary.width + px;
          const t1 = mode.comparisonPrimary.data[idx1];
          const t2 =
            sx >= 0 && sy >= 0 && sx < mode.comparisonSecondary.width && sy < mode.comparisonSecondary.height
              ? mode.comparisonSecondary.data[sy * mode.comparisonSecondary.width + sx]
              : NaN;
          const diff = mode.differenceData[idx1];

          if (Number.isFinite(t1) || Number.isFinite(diff)) {
            const point: InspectPoint = {
              temp: Number.isFinite(t2) ? t2 : t1,
              lng: event.lngLat.lng,
              lat: event.lngLat.lat,
              beforeTemp: Number.isFinite(t1) ? t1 : undefined,
              afterTemp: Number.isFinite(t2) ? t2 : undefined,
              diffTemp: Number.isFinite(diff) ? diff : undefined,
            };
            if (commit) setSample(point);
            else if (mode.identifyMode) setHoverSample(point);
            return;
          }
        }
      }

      if (!mode.raster || !mode.extent) return;
      const x = Math.floor(((event.lngLat.lng - mode.extent.west) / (mode.extent.east - mode.extent.west)) * mode.raster.width);
      const y = Math.floor(((mode.extent.north - event.lngLat.lat) / (mode.extent.north - mode.extent.south)) * mode.raster.height);
      if (x >= 0 && y >= 0 && x < mode.raster.width && y < mode.raster.height) {
        const temp = mode.raster.data[y * mode.raster.width + x];
        if (Number.isFinite(temp)) {
          const point: InspectPoint = { temp, lng: event.lngLat.lng, lat: event.lngLat.lat };
          if (commit) setSample(point);
          else if (mode.identifyMode) setHoverSample(point);
        }
      }
    };

    map.on('click', (event) => {
      const mode = mapClickMode.current;
      if (mode.drawAoi) {
        event.preventDefault();
        const pt: [number, number] = [event.lngLat.lng, event.lngLat.lat];
        setAoi((prev) => {
          if (prev.length > 0) {
            const last = prev[prev.length - 1];
            if (Math.abs(last[0] - pt[0]) < 1e-7 && Math.abs(last[1] - pt[1]) < 1e-7) return prev;
          }
          return [...prev, pt];
        });
        return;
      }
      inspectAt(event, true);
    });

    map.on('dblclick', (event) => {
      const mode = mapClickMode.current;
      if (!mode.drawAoi) return;
      event.preventDefault();
      setAoiCursor(null);
      setDrawAoi(false);
      setPanEnabled(true);
      map.dragPan.enable();
      map.doubleClickZoom.enable();
      map.scrollZoom.enable();
      map.touchZoomRotate.enable();
    });

    let hoverFrame = 0;
    map.on('mousemove', (event) => {
      const mode = mapClickMode.current;
      if (mode.drawAoi) {
        if (!hoverFrame) {
          const cursorPt: [number, number] = [event.lngLat.lng, event.lngLat.lat];
          hoverFrame = requestAnimationFrame(() => {
            setAoiCursor(cursorPt);
            hoverFrame = 0;
          });
        }
        return;
      }
      if (mode.identifyMode && !hoverFrame) {
        hoverFrame = requestAnimationFrame(() => {
          inspectAt(event, false);
          hoverFrame = 0;
        });
      }
    });
    map.on('dragstart', () => setHoverSample(null));
    map.dragPan.enable();
    mapInstance.current = map;
    return () => {
      map.remove();
      mapInstance.current = null;
    };
  }, []);

  // Sincronização EXCLUSIVA das imagens raster (não recarrega imagens durante cliques na AOI)
  const syncRasterSources = useCallback(() => {
    const map = mapInstance.current;
    if (!map || !map.isStyleLoaded()) return;
    const addOrUpdate = (id: string, url: string, coordinates: RasterBounds) => {
      const existing = map.getSource(id) as any;
      if (existing) existing.updateImage({ url, coordinates });
      else map.addSource(id, { type: 'image', url, coordinates });
    };
    if (raster && lstUrl && opticalUrl) {
      addOrUpdate('lst-raster', lstUrl, raster.bounds);
      addOrUpdate('optical-raster', opticalUrl, raster.bounds);
      if (!map.getLayer('optical-layer')) {
        map.addLayer({ id: 'optical-layer', type: 'raster', source: 'optical-raster', paint: { 'raster-opacity': 1 } });
      }
      if (!map.getLayer('lst-layer')) {
        map.addLayer({ id: 'lst-layer', type: 'raster', source: 'lst-raster', paint: { 'raster-opacity': opacity, 'raster-contrast': contrast } });
      }
    }
    if (comparisonPrimary && comparisonSecondary && differenceReady) {
      addOrUpdate('comparison-primary-raster', comparisonPrimary.lstUrl, comparisonPrimary.bounds);
      addOrUpdate('comparison-lst-raster', comparisonSecondary.lstUrl, comparisonSecondary.bounds);
      if (!map.getLayer('comparison-primary-layer')) {
        map.addLayer({ id: 'comparison-primary-layer', type: 'raster', source: 'comparison-primary-raster', paint: { 'raster-opacity': 1 } });
      }
      if (!map.getLayer('comparison-lst-layer')) {
        map.addLayer({ id: 'comparison-lst-layer', type: 'raster', source: 'comparison-lst-raster', paint: { 'raster-opacity': 0.95 } });
      }
      if (differenceRender) addOrUpdate('comparison-difference-raster', differenceRender.url, comparisonPrimary.bounds);
      if (!map.getLayer('comparison-difference-layer')) {
        map.addLayer({ id: 'comparison-difference-layer', type: 'raster', source: 'comparison-difference-raster', paint: { 'raster-opacity': 0.94 } });
      }
    }
    // Mantém camadas da AOI sempre no topo
    for (const layerId of ['aoi-fill', 'aoi-line', 'aoi-vertices']) {
      if (map.getLayer(layerId)) map.moveLayer(layerId);
    }
  }, [comparisonPrimary, comparisonSecondary, contrast, differenceReady, differenceRender, lstUrl, opacity, opticalUrl, raster]);

  // Atualização rápida apenas de opacidade e visibilidade
  useEffect(() => {
    const map = mapInstance.current;
    if (!map || !map.isStyleLoaded()) return;
    if (comparisonPrimary && comparisonSecondary && differenceReady) {
      if (map.getLayer('comparison-primary-layer')) {
        map.setLayoutProperty('comparison-primary-layer', 'visibility', swipeActive ? 'visible' : 'none');
      }
      if (map.getLayer('comparison-lst-layer')) {
        map.setLayoutProperty('comparison-lst-layer', 'visibility', !swipeActive && comparisonMode === 'secondary' ? 'visible' : 'none');
        map.setPaintProperty('comparison-lst-layer', 'raster-opacity', 0.95);
      }
      if (map.getLayer('comparison-difference-layer')) {
        map.setLayoutProperty('comparison-difference-layer', 'visibility', comparisonMode === 'difference' && !swipeActive ? 'visible' : 'none');
      }
    } else {
      for (const id of ['comparison-primary-layer', 'comparison-lst-layer', 'comparison-difference-layer']) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
      }
    }
    if (map.getLayer('lst-layer')) {
      map.setLayoutProperty('lst-layer', 'visibility', visibleLst && !swipeActive && !(comparisonMode === 'difference' && differenceReady) ? 'visible' : 'none');
      map.setPaintProperty('lst-layer', 'raster-opacity', opacity);
      map.setPaintProperty('lst-layer', 'raster-contrast', contrast);
    }
    if (map.getLayer('optical-layer')) {
      map.setLayoutProperty('optical-layer', 'visibility', visibleOptical && !swipeActive && !(comparisonMode === 'difference' && differenceReady) ? 'visible' : 'none');
    }
  }, [comparisonMode, comparisonPrimary, comparisonSecondary, contrast, differenceReady, opacity, swipeActive, visibleLst, visibleOptical]);

  useEffect(() => {
    const container = curtainContainerRef.current;
    const main = mapInstance.current;
    if (!container || !main || !swipeActive || !comparisonSecondary || !differenceReady) {
      curtainMapRef.current?.remove();
      curtainMapRef.current = null;
      return;
    }
    const savedCenter = main.getCenter();
    const savedZoom = main.getZoom();
    const savedBearing = main.getBearing();
    const savedPitch = main.getPitch();

    const curtainMap = new maplibregl.Map({
      container,
      style: { version: 8, sources: {}, layers: [] },
      center: savedCenter,
      zoom: savedZoom,
      bearing: savedBearing,
      pitch: savedPitch,
      interactive: false,
      attributionControl: false,
    });
    const syncCamera = () => {
      curtainMap.jumpTo({
        center: main.getCenter(),
        zoom: main.getZoom(),
        bearing: main.getBearing(),
        pitch: main.getPitch(),
      });
    };
    const addCurtainLayer = () => {
      curtainMap.resize();
      curtainMap.addSource('curtain-secondary-raster', {
        type: 'image',
        url: comparisonSecondary.lstUrl,
        coordinates: comparisonSecondary.bounds,
      });
      curtainMap.addLayer({
        id: 'curtain-secondary-layer',
        type: 'raster',
        source: 'curtain-secondary-raster',
        paint: { 'raster-opacity': 1 },
      });
      syncCamera();
    };
    curtainMap.on('load', addCurtainLayer);
    main.on('move', syncCamera);
    curtainMapRef.current = curtainMap;
    return () => {
      main.off('move', syncCamera);
      curtainMap.remove();
      curtainMapRef.current = null;
    };
  }, [comparisonSecondary, differenceReady, swipeActive]);

  useEffect(() => {
    const source = mapInstance.current?.getSource('basemap') as any;
    if (source?.setTiles) source.setTiles([TILE_URLS[provider]]);
  }, [provider]);

  // Durante Desenhar AOI ou Identificar, bloqueia apenas o arraste (dragPan) mas mantém o zoom da roda do mouse livre
  useEffect(() => {
    const map = mapInstance.current;
    if (!map) return;
    const locked = drawAoi || identifyMode;
    if (locked) {
      map.dragPan.disable();
      map.doubleClickZoom.disable();
      map.scrollZoom.enable();
      map.getCanvas().style.cursor = 'crosshair';
    } else {
      if (panEnabled) map.dragPan.enable();
      else map.dragPan.disable();
      map.scrollZoom.enable();
      map.boxZoom.enable();
      map.doubleClickZoom.enable();
      map.dragRotate.enable();
      map.keyboard.enable();
      map.touchZoomRotate.enable();
      map.getCanvas().style.cursor = '';
    }
  }, [drawAoi, identifyMode, panEnabled]);

  useEffect(() => {
    const map = mapInstance.current;
    if (!map || (!raster && !differenceReady)) return;
    if (map.isStyleLoaded()) syncRasterSources();
    else map.once('load', syncRasterSources);
    return () => {
      map.off('load', syncRasterSources);
    };
  }, [lstUrl, opticalUrl, raster, differenceReady, syncRasterSources]);

  useEffect(() => {
    const key = raster?.fileName ?? comparisonPrimary?.id ?? '';
    if (!key || key === lastFittedKey.current) return;
    const viewExtent = extent ?? (comparisonPrimary ? boundsExtent(comparisonPrimary.bounds) : null);
    if (mapInstance.current && viewExtent) {
      lastFittedKey.current = key;
      mapInstance.current.fitBounds(
        [[viewExtent.west, viewExtent.south], [viewExtent.east, viewExtent.north]],
        { padding: 70, duration: 850, maxZoom: 16 },
      );
    }
  }, [comparisonPrimary, extent, raster]);

  // Renderização em Tempo Real da AOI (Polígono + Linha Elástica + Vértices Visíveis no Topo do Mapa)
  useEffect(() => {
    const map = mapInstance.current;
    if (!map) return;
    const renderAoiGeometry = () => {
      if (!map.isStyleLoaded()) return;
      const previewPts = drawAoi && aoiCursor && aoi.length >= 1 ? [...aoi, aoiCursor] : aoi;
      const features: any[] = [];

      if (previewPts.length >= 3) {
        features.push({
          type: 'Feature',
          properties: { kind: 'poly' },
          geometry: { type: 'Polygon', coordinates: [[...previewPts, previewPts[0]]] },
        });
      }
      if (previewPts.length >= 2) {
        const lineCoords = previewPts.length >= 3 ? [...previewPts, previewPts[0]] : previewPts;
        features.push({
          type: 'Feature',
          properties: { kind: 'line' },
          geometry: { type: 'LineString', coordinates: lineCoords },
        });
      }
      for (let i = 0; i < aoi.length; i += 1) {
        features.push({
          type: 'Feature',
          properties: { kind: 'vertex', index: i + 1 },
          geometry: { type: 'Point', coordinates: aoi[i] },
        });
      }

      const geojsonData = { type: 'FeatureCollection' as const, features };
      const source = map.getSource('aoi-source') as maplibregl.GeoJSONSource | undefined;
      if (source) {
        source.setData(geojsonData as any);
      } else {
        map.addSource('aoi-source', { type: 'geojson', data: geojsonData as any });
        map.addLayer({
          id: 'aoi-fill',
          type: 'fill',
          source: 'aoi-source',
          filter: ['==', '$type', 'Polygon'],
          paint: { 'fill-color': '#ffb000', 'fill-opacity': 0.24 },
        });
        map.addLayer({
          id: 'aoi-line',
          type: 'line',
          source: 'aoi-source',
          filter: ['==', '$type', 'LineString'],
          paint: { 'line-color': '#ffb000', 'line-width': 3.5, 'line-dasharray': [2, 1] },
        });
        map.addLayer({
          id: 'aoi-vertices',
          type: 'circle',
          source: 'aoi-source',
          filter: ['==', '$type', 'Point'],
          paint: {
            'circle-radius': 6,
            'circle-color': '#071317',
            'circle-stroke-color': '#79e2dc',
            'circle-stroke-width': 2.5,
          },
        });
      }
      for (const layerId of ['aoi-fill', 'aoi-line', 'aoi-vertices']) {
        if (map.getLayer(layerId)) map.moveLayer(layerId);
      }
    };

    if (map.isStyleLoaded()) renderAoiGeometry();
    else map.once('load', renderAoiGeometry);
  }, [aoi, aoiCursor, drawAoi]);

  // Atualiza automaticamente as estatísticas da AOI assim que um polígono de 3+ pontos é fechado
  useEffect(() => {
    if (!drawAoi && aoi.length >= 3 && raster) {
      const stats = computeAoiStatsForPolygon(aoi);
      setAoiStats(stats);
    }
  }, [aoi, computeAoiStatsForPolygon, drawAoi, raster]);

  useEffect(() => {
    if (raster) {
      setUhiSurface(buildUhiSurface({ data: raster.data, width: raster.width, height: raster.height, bounds: raster.bounds, mean: raster.stats.mean, stdDev: raster.stats.stdDev }));
      setIsotherms(buildMesoIsothermsGeoJSON(raster.data, raster.width, raster.height, raster.bounds, raster.stats, uhiMethod, uhiPower));
    } else {
      setUhiSurface(null);
      setIsotherms(null);
    }
  }, [raster, uhiMethod, uhiPower]);

  useEffect(() => {
    if (!raster) return;
    const canvas = document.createElement('canvas');
    if (displayMode === 'uhi') {
      renderHighDefUhiToCanvas(raster.data, raster.width, raster.height, canvas, raster.stats, uhiMethod, uhiPower);
    } else {
      renderPerceptualLstToCanvas(raster.data, raster.width, raster.height, canvas, palette, customColors, raster.stats);
    }
    lstCanvas.current = canvas;
    setLstUrl(canvas.toDataURL('image/png'));
  }, [customColors, displayMode, palette, raster, uhiMethod, uhiPower]);

  useEffect(() => {
    const map = mapInstance.current;
    if (!map || !isotherms) return;
    const syncIsotherms = () => {
      if (!map.isStyleLoaded()) return;
      const source = map.getSource('uhi-surface') as maplibregl.GeoJSONSource | undefined;
      if (source) {
        source.setData(isotherms as any);
      } else {
        map.addSource('uhi-surface', { type: 'geojson', data: isotherms as any });
        map.addLayer({
          id: 'uhi-surface-casing',
          type: 'line',
          source: 'uhi-surface',
          paint: { 'line-color': '#061014', 'line-opacity': 0.85, 'line-width': 3.4 },
        });
        map.addLayer({
          id: 'uhi-surface-line',
          type: 'line',
          source: 'uhi-surface',
          paint: { 'line-color': ['get', 'color'], 'line-opacity': 0.96, 'line-width': 1.9 },
        });
      }
      const vis = uhiSurfaceVisible ? 'visible' : 'none';
      if (map.getLayer('uhi-surface-casing')) map.setLayoutProperty('uhi-surface-casing', 'visibility', vis);
      if (map.getLayer('uhi-surface-line')) map.setLayoutProperty('uhi-surface-line', 'visibility', vis);
    };
    if (map.isStyleLoaded()) syncIsotherms();
    else map.once('load', syncIsotherms);
    return () => {
      map.off('load', syncIsotherms);
    };
  }, [isotherms, uhiSurfaceVisible]);

  const handleFileChange = async (selected: File | null) => {
    setFile(selected);
    setError('');
    setSearchResults([]);
    if (!selected) return;
    setStatus(lang === 'pt' ? 'Lendo bandas e metadados…' : 'Reading bands and metadata…');
    try {
      const preview = await readTiffPixels(selected);
      const count = preview.rasters.length;
      setBandCount(count);
      setBandLabels(preview.bandLabels);
      const standardTenBand =
        preview.bandLabels.length === 10 &&
        preview.bandLabels[2]?.includes('B04') &&
        preview.bandLabels[6]?.includes('B08') &&
        preview.bandLabels[8]?.includes('B11') &&
        preview.bandLabels[9]?.includes('B12');
      setBands(
        standardTenBand
          ? ['2', '6', '8']
          : (prev) => prev.map((value, index) => (Number(value) < count ? value : String(Math.max(0, count - 1 - index)))),
      );
      setStatus(lang === 'pt' ? `${count} bandas detectadas — confirme Red, NIR e SWIR.` : `${count} bands detected — confirm Red, NIR and SWIR.`);
    } catch {
      setError(lang === 'pt' ? 'Não foi possível ler as bandas deste GeoTIFF.' : 'Unable to read the bands from this GeoTIFF.');
      setStatus('');
    }
  };

  const closeTutorial = () => {
    setShowTutorial(false);
    sessionStorage.setItem('sr2d4-tutorial-seen', '1');
  };

  const updateComparisonCount = (value: number) => {
    setComparisonCount(value);
    setComparisonFiles((previous) => Array.from({ length: value }, (_, index) => previous[index] ?? null));
    setComparisonImages([]);
    setDifferenceReady(false);
  };

  const calculateComparisons = async () => {
    const selected = comparisonFiles.filter((item): item is File => Boolean(item));
    if (selected.length < 2) {
      setError(lang === 'pt' ? 'Selecione pelo menos duas imagens para comparar.' : 'Select at least two images to compare.');
      return;
    }
    setBusy(true);
    setError('');
    setDifferenceReady(false);
    setComparisonMode('difference');
    const loaded: ComparisonImage[] = [];
    for (let index = 0; index < selected.length; index += 1) {
      const selectedFile = selected[index];
      setStatus(lang === 'pt' ? `Buscando Landsat para ${selectedFile.name}…` : `Finding Landsat for ${selectedFile.name}…`);
      try {
        const automatic = await buildAutomaticThermalRaster(selectedFile, [Number(bands[0]), Number(bands[1]), Number(bands[2])]);
        const lst = document.createElement('canvas');
        const optical = document.createElement('canvas');
        const stats = renderPerceptualLstToCanvas(automatic.result.lstDownscaled, automatic.tiff.width, automatic.tiff.height, lst, palette, customColors);
        renderRGBBasemapToCanvas(
          automatic.tiff.rasters[Number(bands[2])] as Float32Array,
          automatic.tiff.rasters[Number(bands[1])] as Float32Array,
          automatic.tiff.rasters[Number(bands[0])] as Float32Array,
          automatic.tiff.width,
          automatic.tiff.height,
          optical,
        );
        if (!stats) continue;
        const uhi = buildUhiSurface({
          data: automatic.result.lstDownscaled,
          width: automatic.tiff.width,
          height: automatic.tiff.height,
          bounds: automatic.bounds,
          mean: stats.mean,
          stdDev: stats.stdDev,
        });
        loaded.push({
          id: `${selectedFile.name}-${selectedFile.lastModified}-${index}`,
          name: selectedFile.name,
          dateLabel: imageDateLabel(selectedFile.name, index),
          lstUrl: lst.toDataURL('image/png'),
          opticalUrl: optical.toDataURL('image/png'),
          uhiSurface: uhi,
          bounds: automatic.bounds,
          width: automatic.tiff.width,
          height: automatic.tiff.height,
          data: automatic.result.lstDownscaled,
          stats,
        });
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      } catch {
        /* ignora falha individual */
      }
    }
    setComparisonImages(loaded);
    setDifferenceReady(loaded.length >= 2);
    if (loaded.length < 2) {
      setError(lang === 'pt' ? 'Não foi possível processar duas imagens SR2D4 com Landsat automático válido.' : 'Could not process two SR2D4 images with valid automatic Landsat.');
      setStatus('');
    } else {
      setStatus(lang === 'pt' ? 'Diferença térmica pronta.' : 'Thermal difference ready.');
    }
    setBusy(false);
  };

  const calculateDifference = () => {
    void calculateComparisons();
  };

  const getAoiWindow = () => {
    if (!raster || aoi.length < 3 || !extent) return null;
    let west = Infinity;
    let east = -Infinity;
    let south = Infinity;
    let north = -Infinity;
    for (const point of aoi) {
      west = Math.min(west, point[0]);
      east = Math.max(east, point[0]);
      south = Math.min(south, point[1]);
      north = Math.max(north, point[1]);
    }
    const x0 = Math.max(0, Math.floor(((west - extent.west) / (extent.east - extent.west)) * raster.width));
    const x1 = Math.min(raster.width, Math.ceil(((east - extent.west) / (extent.east - extent.west)) * raster.width));
    const y0 = Math.max(0, Math.floor(((extent.north - north) / (extent.north - extent.south)) * raster.height));
    const y1 = Math.min(raster.height, Math.ceil(((extent.north - south) / (extent.north - extent.south)) * raster.height));
    return { x0, y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
  };

  const exportAoiPng = () => {
    const win = getAoiWindow();
    if (!win || !lstCanvas.current || !opticalCanvas.current) return;
    const minOutWidth = Math.max(1200, win.width);
    const scale = minOutWidth / win.width;
    const outW = Math.round(win.width * scale);
    const outH = Math.round(win.height * scale);
    const output = document.createElement('canvas');
    output.width = outW;
    output.height = outH + 220;
    const ctx = output.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#071317';
    ctx.fillRect(0, 0, output.width, output.height);
    ctx.drawImage(opticalCanvas.current, win.x0, win.y0, win.width, win.height, 0, 0, outW, outH);
    ctx.globalAlpha = opacity;
    ctx.drawImage(lstCanvas.current, win.x0, win.y0, win.width, win.height, 0, 0, outW, outH);
    ctx.globalAlpha = 1;
    drawLegend(ctx, 24, outH + 20);
    const link = document.createElement('a');
    link.href = output.toDataURL('image/png');
    link.download = `SR2D4-AOI-${displayMode === 'uhi' ? 'UHI-classes' : `LST-${palette}`}.png`;
    link.click();
  };

  const exportAoiTiff = () => {
    const win = getAoiWindow();
    if (!win || !raster) return;
    const clipped = new Float32Array(win.width * win.height);
    for (let y = 0; y < win.height; y += 1) {
      clipped.set(raster.data.subarray((win.y0 + y) * raster.width + win.x0, (win.y0 + y) * raster.width + win.x0 + win.width), y * win.width);
    }
    const outputData =
      displayMode === 'uhi'
        ? clipped.map((value) =>
            value < raster.stats.mean
              ? 1
              : value < raster.stats.mean + 0.5 * raster.stats.stdDev
                ? 2
                : value < raster.stats.mean + 1.5 * raster.stats.stdDev
                  ? 3
                  : 4,
          )
        : clipped;
    downloadFloat32Tiff(
      outputData instanceof Float32Array ? outputData : new Float32Array(outputData),
      win.width,
      win.height,
      `SR2D4-AOI-${displayMode}.tif`,
      [raster.origin[0] + win.x0 * raster.resolution[0], raster.origin[1] + win.y0 * raster.resolution[1], raster.origin[2] || 0],
      raster.resolution,
      raster.epsg,
      raster.isProjected,
    );
  };

  const exportVectorIsotherms = (format: 'geojson' | 'kml') => {
    if (!isotherms) return;
    if (format === 'geojson') {
      const blob = new Blob([JSON.stringify(isotherms, null, 2)], { type: 'application/geo+json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = 'SR2D4-Isotermas-Meso.geojson';
      link.click();
      URL.revokeObjectURL(link.href);
    } else {
      const placemarks = isotherms.features
        .map((f) => {
          const linesXml = f.geometry.coordinates
            .map((seg) => `<LineString><coordinates>${seg.map((c) => `${c[0]},${c[1]},0`).join(' ')}</coordinates></LineString>`)
            .join('');
          return `<Placemark><name>${f.properties.label}</name><description>Isoterma Meso-escala: ${f.properties.tempCelsius}°C</description><Style><LineStyle><color>${f.properties.kmlColor}</color><width>2.5</width></LineStyle></Style><MultiGeometry>${linesXml}</MultiGeometry></Placemark>`;
        })
        .join('');
      const kml = `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>SR2D4 Isotermas e Clusters Meso-escala</name>${placemarks}</Document></kml>`;
      const blob = new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = 'SR2D4-Isotermas-Meso.kml';
      link.click();
      URL.revokeObjectURL(link.href);
    }
  };

  const processFile = async (selectedFile: File = file as File) => {
    if (!selectedFile) return;
    const addLog = (message: string, level: 'info' | 'success' | 'error' = 'info') => {
      setProcessingLog((previous) => [...previous.slice(-99), { time: new Date().toLocaleTimeString('pt-BR'), message, level }]);
      setStatus(message);
    };
    setProcessingLog([]);
    setBusy(true);
    setError('');
    addLog(`Iniciando processamento: ${selectedFile.name}`);
    try {
      const automatic = await buildAutomaticThermalRaster(selectedFile, [Number(bands[0]), Number(bands[1]), Number(bands[2])], addLog);
      addLog(
        `${automatic.landsat.satellite} ${automatic.landsat.acquisitionDate} selecionado · ${automatic.landsat.validThermalPixels.toLocaleString()} pixels válidos · ${automatic.result.model} · saída na resolução do SR2D4 (${automatic.tiff.isProjected ? `${Math.abs(automatic.tiff.resolution[0]).toFixed(2)} m/pixel` : `${Math.abs(automatic.tiff.resolution[0]).toFixed(6)} graus/pixel`})`,
      );
      const lst = document.createElement('canvas');
      const optical = document.createElement('canvas');
      const stats = renderPerceptualLstToCanvas(automatic.result.lstDownscaled, automatic.tiff.width, automatic.tiff.height, lst, palette, customColors);
      if (displayMode === 'uhi' && stats) {
        renderHighDefUhiToCanvas(automatic.result.lstDownscaled, automatic.tiff.width, automatic.tiff.height, lst, stats, uhiMethod, uhiPower);
      }
      renderRGBBasemapToCanvas(
        automatic.tiff.rasters[Number(bands[2])] as Float32Array,
        automatic.tiff.rasters[Number(bands[1])] as Float32Array,
        automatic.tiff.rasters[Number(bands[0])] as Float32Array,
        automatic.tiff.width,
        automatic.tiff.height,
        optical,
      );
      if (!stats) throw new Error('empty raster');
      const next: RasterState = {
        data: automatic.result.lstDownscaled,
        width: automatic.tiff.width,
        height: automatic.tiff.height,
        bounds: automatic.bounds,
        origin: automatic.tiff.origin,
        resolution: automatic.tiff.resolution,
        epsg: automatic.tiff.epsg,
        isProjected: automatic.tiff.isProjected,
        stats,
        ndvi: automatic.indices.ndvi,
        ndbi: automatic.indices.ndbi,
        fileName: `${selectedFile.name} · ${automatic.landsat.itemId}`,
        bands: automatic.tiff.rasters.length,
      };
      lstCanvas.current = lst;
      opticalCanvas.current = optical;
      setRaster(next);
      setAoi([]);
      setAoiCursor(null);
      setAoiStats(null);
      setLstUrl(lst.toDataURL('image/png'));
      setOpticalUrl(optical.toDataURL('image/png'));
      addLog(t.ready, 'success');
    } catch (e) {
      console.error(e);
      const message = e instanceof Error ? e.message : t.error;
      setError(message);
      addLog(message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const colorTempHistogram = useMemo(() => {
    if (!raster) return [];
    const numBins = 24;
    const bins = Array.from({ length: numBins }, () => 0);
    const span = raster.stats.max - raster.stats.min || 1;
    let total = 0;

    for (let i = 0; i < raster.data.length; i += 2) {
      const v = raster.data[i];
      if (!Number.isFinite(v)) continue;
      const idx = Math.max(0, Math.min(numBins - 1, Math.floor(((v - raster.stats.min) / span) * numBins)));
      bins[idx] += 1;
      total += 1;
    }

    const peak = Math.max(bins.reduce((maximum, value) => Math.max(maximum, value), 0), 1);
    return bins.map((count, i) => {
      const tNorm = (i + 0.5) / numBins;
      const tempStart = raster.stats.min + (span * i) / numBins;
      const tempEnd = raster.stats.min + (span * (i + 1)) / numBins;
      const pct = total > 0 ? ((count / total) * 100).toFixed(1) : '0.0';
      return {
        count,
        pct,
        height: Math.max(6, Math.pow(count / peak, 0.78) * 100),
        tempLabel: `${tempStart.toFixed(1)}°C – ${tempEnd.toFixed(1)}°C (${pct}%)`,
        shortLabel: `${((tempStart + tempEnd) * 0.5).toFixed(0)}°`,
        color: sampleCssColorAt(tNorm, palette, draftCustomColors, displayMode === 'uhi'),
      };
    });
  }, [displayMode, draftCustomColors, palette, raster]);

  const drawDifferenceLegend = (
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    stats: DifferenceStats | null,
  ) => {
    const sigma = stats?.thresholdSigma ?? 1.0;
    const meanShift = stats?.mean ?? 0;
    const signStr = meanShift >= 0 ? `+${meanShift.toFixed(1)}` : meanShift.toFixed(1);

    ctx.save();
    ctx.fillStyle = '#071317';
    ctx.fillRect(x, y, width, height);
    ctx.strokeStyle = '#79e2dc';
    ctx.lineWidth = 3;
    ctx.strokeRect(x, y, width, height);

    ctx.fillStyle = '#ffffff';
    ctx.font = '700 28px system-ui, -apple-system, Arial, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`DIFERENÇA ΔLST (DEPOIS − ANTES) · Desvio 1σ = ±${sigma.toFixed(2)} °C (Média Δ = ${signStr} °C)`, x + 28, y + 44);

    const barX = x + 28;
    const barY = y + 64;
    const barW = width - 56;
    const barH = 34;

    const gradient = ctx.createLinearGradient(barX, barY, barX + barW, barY);
    gradient.addColorStop(0, '#023e8a');
    gradient.addColorStop(0.24, '#0096c7');
    gradient.addColorStop(0.36, '#48cae4');
    gradient.addColorStop(0.37, '#45525a');
    gradient.addColorStop(0.63, '#526069');
    gradient.addColorStop(0.64, '#f77f00');
    gradient.addColorStop(0.84, '#d62828');
    gradient.addColorStop(1, '#ffea00');
    ctx.fillStyle = gradient;
    ctx.fillRect(barX, barY, barW, barH);
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 2;
    ctx.strokeRect(barX, barY, barW, barH);

    ctx.font = '700 23px system-ui, -apple-system, Arial, sans-serif';
    ctx.fillStyle = '#48cae4';
    ctx.textAlign = 'left';
    ctx.fillText(`↓ Diminuiu (< -1σ): ${stats?.pctDecreased.toFixed(1) ?? '0.0'}%`, barX, y + 134);

    ctx.fillStyle = '#e2e8f0';
    ctx.textAlign = 'center';
    ctx.fillText(`＝ Permaneceu Igual (±1σ): ${stats?.pctEqual.toFixed(1) ?? '0.0'}%`, x + width / 2, y + 134);

    ctx.fillStyle = '#ffb000';
    ctx.textAlign = 'right';
    ctx.fillText(`↑ Aumentou (> +1σ): ${stats?.pctIncreased.toFixed(1) ?? '0.0'}%`, barX + barW, y + 134);

    ctx.textAlign = 'left';
    ctx.fillStyle = '#9ab0b5';
    ctx.font = '500 20px system-ui, -apple-system, Arial, sans-serif';
    ctx.fillText(
      `Classificação estatística (±1σ = ±${sigma.toFixed(2)}°C em relação à tendência média de ${signStr}°C entre as datas).`,
      barX,
      y + 172,
    );
    ctx.restore();
  };

  const drawLegend = (ctx: CanvasRenderingContext2D, x: number, y: number) => {
    const height = 180;
    const width = Math.min(820, Math.max(380, ctx.canvas.width - x - 24));
    const pad = 26;
    ctx.save();
    ctx.fillStyle = 'rgba(7,19,23,.96)';
    ctx.fillRect(x, y, width, height);
    ctx.strokeStyle = 'rgba(121,226,220,.7)';
    ctx.lineWidth = 3;
    ctx.strokeRect(x, y, width, height);
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 28px system-ui, -apple-system, Arial, sans-serif';
    ctx.textAlign = 'left';
    const title = displayMode === 'uhi' ? 'UHI · INTENSIDADE DE ILHA DE CALOR (1m)' : 'LST · TEMPERATURA DA SUPERFÍCIE (°C)';
    ctx.fillText(title, x + pad, y + 43);
    if (displayMode === 'uhi') {
      const items: [string, string][] = [
        ['Frescor', '#103e8a'],
        ['Amenizado', '#3aae6c'],
        ['Neutro', '#f8d668'],
        ['Moderada', '#f47c30'],
        ['Forte', '#d42026'],
        ['Hotspot', '#fff4b8'],
      ];
      const itemWidth = (width - pad * 2) / items.length;
      items.forEach(([label, color], index) => {
        const itemX = x + pad + index * itemWidth;
        ctx.fillStyle = color;
        ctx.fillRect(itemX, y + 66, 24, 24);
        ctx.fillStyle = '#ffffff';
        ctx.font = '600 18px system-ui, -apple-system, Arial, sans-serif';
        ctx.fillText(label, itemX + 30, y + 85);
      });
      ctx.fillStyle = '#b7c9cb';
      ctx.font = '16px system-ui, -apple-system, Arial, sans-serif';
      ctx.fillText(`Método: ${uhiMethod.toUpperCase()} · Potenciação γ=${uhiPower.toFixed(2)}`, x + pad, y + 139);
    } else {
      const gradient = ctx.createLinearGradient(x + pad, y + 84, x + width - pad, y + 84);
      for (let s = 0; s <= 16; s += 1) {
        gradient.addColorStop(s / 16, sampleCssColorAt(s / 16, palette, draftCustomColors, false));
      }
      ctx.fillStyle = gradient;
      ctx.fillRect(x + pad, y + 67, width - pad * 2, 38);
      ctx.strokeStyle = 'rgba(255,255,255,.7)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x + pad, y + 67, width - pad * 2, 38);
      ctx.fillStyle = '#ffffff';
      ctx.font = '700 22px system-ui, -apple-system, Arial, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(`Mín: ${raster?.stats.min.toFixed(1) ?? '—'} °C`, x + pad, y + 139);
      ctx.textAlign = 'center';
      ctx.fillText(`Média: ${raster?.stats.mean.toFixed(1) ?? '—'} °C`, x + width / 2, y + 139);
      ctx.textAlign = 'right';
      ctx.fillText(`Máx: ${raster?.stats.max.toFixed(1) ?? '—'} °C`, x + width - pad, y + 139);
      ctx.textAlign = 'left';
      ctx.fillStyle = '#b7c9cb';
      ctx.font = '16px system-ui, -apple-system, Arial, sans-serif';
      ctx.fillText(`Paleta: ${palette === 'custom' ? 'Custom' : palette} · Desvio-padrão σ = ${raster?.stats.stdDev.toFixed(2) ?? '—'} °C`, x + pad, y + 164);
    }
    ctx.restore();
  };

  const exportPng = () => {
    if (!lstCanvas.current || !opticalCanvas.current) return;
    const canvas = document.createElement('canvas');
    canvas.width = lstCanvas.current.width;
    canvas.height = lstCanvas.current.height + 210;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#071317';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(opticalCanvas.current, 0, 0);
    ctx.globalAlpha = opacity;
    ctx.drawImage(lstCanvas.current, 0, 0);
    ctx.globalAlpha = 1;
    drawLegend(ctx, 20, canvas.height - 195);
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = `SR2D4-${displayMode === 'uhi' ? 'UHI-classes' : `LST-${palette}`}.png`;
    a.click();
  };

  const goTo = (lng: number, lat: number) => {
    if (Number.isFinite(lng) && Number.isFinite(lat)) mapInstance.current?.flyTo({ center: [lng, lat], zoom: 13, essential: true });
  };

  const locateMe = () =>
    navigator.geolocation?.getCurrentPosition(
      ({ coords }) => goTo(coords.longitude, coords.latitude),
      () => setSearchError(lang === 'pt' ? 'Permita o acesso à localização no navegador.' : 'Allow location access in your browser.'),
    );

  const searchPlace = async () => {
    if (!search.trim()) return;
    setSearching(true);
    setSearchError('');
    try {
      const response = await fetch(
        `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&accept-language=${lang === 'pt' ? 'pt-BR' : 'en'}&q=${encodeURIComponent(search.trim())}`,
      );
      const results = (await response.json()) as SearchResult[];
      setSearchResults(results);
      if (results[0]) goTo(Number(results[0].lon), Number(results[0].lat));
      else setSearchError(t.searchError);
    } catch {
      setSearchError(t.searchError);
    } finally {
      setSearching(false);
    }
  };

  const startCurtainDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!swipeActive || !differenceReady) return;
    event.preventDefault();
    event.stopPropagation();
    curtainDragging.current = true;
    document.body.classList.add('is-curtain-dragging');
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const goToCoordinates = () => {
    const values = coordText.split(/[,;\s]+/).map(Number);
    if (values.length >= 2) goTo(values[0], values[1]);
  };

  const zoomIn = () => mapInstance.current?.zoomIn();
  const zoomOut = () => mapInstance.current?.zoomOut();

  const togglePan = () => {
    if (drawAoi || identifyMode) return;
    const next = !panEnabled;
    setPanEnabled(next);
    if (next) mapInstance.current?.dragPan.enable();
    else mapInstance.current?.dragPan.disable();
  };

  const toggleIdentify = () => {
    const next = !identifyMode;
    setIdentifyMode(next);
    setHoverSample(null);
    if (next) {
      setPanEnabled(false);
      mapInstance.current?.dragPan.disable();
    } else {
      setPanEnabled(true);
      mapInstance.current?.dragPan.enable();
    }
  };

  const visibleBandCount = raster?.bands ?? bandCount;
  const displayBandLabels =
    bandLabels.length === visibleBandCount
      ? bandLabels
      : Array.from({ length: visibleBandCount }, (_, i) => `${lang === 'pt' ? 'Camada' : 'Layer'} ${String(i + 1).padStart(2, '0')} · ${lang === 'pt' ? 'nome ausente' : 'name missing'}`);
  const isStandardSr2d4TenBand =
    displayBandLabels.length === 10 &&
    displayBandLabels[2]?.includes('B04') &&
    displayBandLabels[6]?.includes('B08') &&
    displayBandLabels[8]?.includes('B11') &&
    displayBandLabels[9]?.includes('B12');
  const hasSpectralMetadata = displayBandLabels.some((label) => /B(?:and)?[-_ ]?0?[1-9]|B(?:and)?[-_ ]?1[0-2]|red|nir|swir/i.test(label));
  const options = Array.from({ length: visibleBandCount }, (_, i) => (
    <option value={i} key={i}>
      {displayBandLabels[i]}
    </option>
  ));

  const updateBand = (index: number, value: string) => setBands((prev) => prev.map((v, i) => (i === index ? value : v)));

  const restoreMapNavigation = () => {
    mapInstance.current?.dragPan.enable();
    mapInstance.current?.scrollZoom.enable();
    mapInstance.current?.doubleClickZoom.enable();
    mapInstance.current?.touchZoomRotate.enable();
    setPanEnabled(true);
  };

  const pauseMapNavigation = () => {
    mapInstance.current?.dragPan.disable();
    mapInstance.current?.doubleClickZoom.disable();
    mapInstance.current?.scrollZoom.enable();
    setPanEnabled(false);
  };

  const clearAoi = () => {
    setAoi([]);
    setAoiCursor(null);
    setAoiStats(null);
    setDrawAoi(false);
    restoreMapNavigation();
  };

  const finishAoi = () => {
    if (aoi.length >= 3) {
      setAoiCursor(null);
      setDrawAoi(false);
      restoreMapNavigation();
    }
  };

  const toggleAoi = () => {
    const next = !drawAoi;
    setDrawAoi(next);
    setIdentifyMode(false);
    if (next) {
      setAoi([]);
      setAoiCursor(null);
      setAoiStats(null);
      pauseMapNavigation();
    } else {
      setAoiCursor(null);
      restoreMapNavigation();
    }
  };

  const analyzeAoi = () => {
    if (!raster || aoi.length < 3) return;
    const stats = computeAoiStatsForPolygon(aoi);
    setAoiStats(stats);
    if (stats) {
      setStatus(lang === 'pt' ? `AOI analisada · ${stats.count.toLocaleString()} pixels` : `AOI analyzed · ${stats.count.toLocaleString()} pixels`);
    }
  };

  // Relatório Técnico Executivo Completo: Análise Espacial, Ambiental, Gestão Pública e Mobilidade Urbana
  const downloadReport = () => {
    if (!raster || !lstCanvas.current || !opticalCanvas.current) return;

    const pixelSizeM = raster.isProjected ? Math.abs(raster.resolution[0]) : Math.abs(raster.resolution[0]) * 111320;
    const pixelAreaM2 = pixelSizeM * pixelSizeM;

    let valid = 0;
    let denseVegCount = 0;
    let sparseVegCount = 0;
    let imperviousCount = 0;
    let waterCount = 0;
    let vegTempSum = 0;
    let impTempSum = 0;

    // 6 classes de UHI
    const uhiCounts = [0, 0, 0, 0, 0, 0];
    const uhiSums = [0, 0, 0, 0, 0, 0];

    // 5 setores geográficos (NO, NE, SO, SE, Centro)
    const sectorNames = [
      'Noroeste (NO)',
      'Nordeste (NE)',
      'Centro Urbano',
      'Sudoeste (SO)',
      'Sudeste (SE)',
    ];
    const sectorCounts = [0, 0, 0, 0, 0];
    const sectorSums = [0, 0, 0, 0, 0];
    const sectorHotspots = [0, 0, 0, 0, 0];

    // UTFVI classes (Índice de Variação do Campo Térmico Urbano)
    let utfviOptimal = 0;
    let utfviMild = 0;
    let utfviStrong = 0;
    let utfviSevere = 0;

    const mean = raster.stats.mean;
    const std = Math.max(0.6, raster.stats.stdDev);
    const w = raster.width;
    const h = raster.height;

    for (let y = 0; y < h; y += 2) {
      const row = y * w;
      const ny = y / h;
      for (let x = 0; x < w; x += 2) {
        const i = row + x;
        const temp = raster.data[i];
        const ndvi = raster.ndvi[i];
        const ndbi = raster.ndbi[i];
        if (!Number.isFinite(temp) || !Number.isFinite(ndvi) || !Number.isFinite(ndbi)) continue;

        valid += 1;
        const z = (temp - mean) / std;

        // Classificação UHI
        const cIdx = z < -0.95 ? 0 : z < -0.30 ? 1 : z < 0.25 ? 2 : z < 0.85 ? 3 : z < 1.40 ? 4 : 5;
        uhiCounts[cIdx] += 1;
        uhiSums[cIdx] += temp;

        // Cobertura biofísica
        if (ndvi >= 0.35) {
          denseVegCount += 1;
          vegTempSum += temp;
        } else if (ndvi >= 0.20) {
          sparseVegCount += 1;
          vegTempSum += temp;
        } else if (ndvi < 0.05 && ndbi < -0.05) {
          waterCount += 1;
        } else if (ndbi > 0.02 || ndvi < 0.18) {
          imperviousCount += 1;
          impTempSum += temp;
        }

        // UTFVI = (Ts - Tmean) / Tmean
        const utfvi = (temp - mean) / Math.max(1, mean);
        if (utfvi <= 0) utfviOptimal += 1;
        else if (utfvi <= 0.01) utfviMild += 1;
        else if (utfvi <= 0.02) utfviStrong += 1;
        else utfviSevere += 1;

        // Setor Geográfico
        const nx = x / w;
        const inCenter = nx >= 0.30 && nx <= 0.70 && ny >= 0.30 && ny <= 0.70;
        const sIdx = inCenter ? 2 : ny < 0.5 ? (nx < 0.5 ? 0 : 1) : nx < 0.5 ? 3 : 4;
        sectorCounts[sIdx] += 1;
        sectorSums[sIdx] += temp;
        if (z >= 1.25) sectorHotspots[sIdx] += 1;
      }
    }

    const scaleSample = 4; // amostragem passo 2x2
    const totalAreaHa = ((valid * scaleSample * pixelAreaM2) / 10000);
    const totalAreaKm2 = totalAreaHa / 100;
    const pct = (c: number) => (valid ? ((c / valid) * 100).toFixed(1) : '0.0');
    const areaHa = (c: number) => (((c * scaleSample * pixelAreaM2) / 10000).toFixed(1));

    const totalVeg = denseVegCount + sparseVegCount;
    const meanVegTemp = totalVeg > 0 ? vegTempSum / totalVeg : mean - std;
    const meanImpTemp = imperviousCount > 0 ? impTempSum / imperviousCount : mean + std;
    const coolingEffect = Math.max(0.1, meanImpTemp - meanVegTemp);
    const hotspotThreshold = mean + 1.40 * std;
    const criticalAreaHa = areaHa(uhiCounts[4] + uhiCounts[5]);
    const criticalPct = pct(uhiCounts[4] + uhiCounts[5]);

    // Setor mais quente e mais frio
    let hottestSectorIdx = 0;
    let coolestSectorIdx = 0;
    for (let s = 1; s < 5; s += 1) {
      const mS = sectorCounts[s] ? sectorSums[s] / sectorCounts[s] : mean;
      const mHot = sectorCounts[hottestSectorIdx] ? sectorSums[hottestSectorIdx] / sectorCounts[hottestSectorIdx] : mean;
      const mCool = sectorCounts[coolestSectorIdx] ? sectorSums[coolestSectorIdx] / sectorCounts[coolestSectorIdx] : mean;
      if (mS > mHot) hottestSectorIdx = s;
      if (mS < mCool) coolestSectorIdx = s;
    }

    // Imagens para o relatório
    const compCanvas = document.createElement('canvas');
    compCanvas.width = lstCanvas.current.width;
    compCanvas.height = lstCanvas.current.height;
    const compCtx = compCanvas.getContext('2d');
    if (compCtx) {
      compCtx.drawImage(opticalCanvas.current, 0, 0);
      compCtx.globalAlpha = opacity;
      compCtx.drawImage(lstCanvas.current, 0, 0);
      compCtx.globalAlpha = 1;
    }
    const compositeDataUrl = compCanvas.toDataURL('image/jpeg', 0.88);
    const lstPureDataUrl = lstCanvas.current.toDataURL('image/jpeg', 0.88);
    const opticalDataUrl = opticalCanvas.current.toDataURL('image/jpeg', 0.85);

    const uhiClassesMeta = [
      { name: '1. Ilha de Frescor (< -0,95σ)', color: '#103e8a', desc: 'Corpos hídricos, matas ciliares e parques densos' },
      { name: '2. Zona Amenizada (-0,95σ a -0,30σ)', color: '#3aae6c', desc: 'Quadras arborizadas, praças e jardins permeáveis' },
      { name: '3. Condição Neutra (-0,30σ a +0,25σ)', color: '#bade76', desc: 'Ocupação mista equilibrada com sombreamento parcial' },
      { name: '4. UHI Moderada (+0,25σ a +0,85σ)', color: '#f8d668', desc: 'Malha residencial adensada e vias secundárias' },
      { name: '5. UHI Forte (+0,85σ a +1,40σ)', color: '#f47c30', desc: 'Corredores viários arteriais, asfalto exposto e comércio' },
      { name: '6. Hotspot Extremo (> +1,40σ)', color: '#d42026', desc: 'Grandes galpões logísticos/industriais, telhados metálicos e pátios' },
    ];

    const uhiRowsHtml = uhiClassesMeta
      .map((cls, idx) => {
        const c = uhiCounts[idx];
        const mTemp = c > 0 ? (uhiSums[idx] / c).toFixed(1) : '—';
        return `<tr>
          <td><span class="swatch" style="background:${cls.color}"></span><b>${cls.name}</b></td>
          <td>${cls.desc}</td>
          <td style="text-align:right"><b>${mTemp} °C</b></td>
          <td style="text-align:right">${areaHa(c)} ha</td>
          <td style="text-align:right"><b>${pct(c)}%</b></td>
        </tr>`;
      })
      .join('');

    const sectorRowsHtml = sectorNames
      .map((name, idx) => {
        const cnt = sectorCounts[idx];
        const mT = cnt > 0 ? (sectorSums[idx] / cnt).toFixed(2) : '—';
        const diffM = cnt > 0 ? (sectorSums[idx] / cnt - mean) : 0;
        const diffStr = `${diffM >= 0 ? '+' : ''}${diffM.toFixed(2)} °C`;
        const hotPct = cnt > 0 ? ((sectorHotspots[idx] / cnt) * 100).toFixed(1) : '0.0';
        const statusBadge =
          diffM > 0.45
            ? '<span class="badge badge-hot">Prioridade Alta (Mitigação)</span>'
            : diffM < -0.35
              ? '<span class="badge badge-cool">Sumidouro Térmico (Preservar)</span>'
              : '<span class="badge badge-neutral">Transição Urbana</span>';
        return `<tr>
          <td><b>${name}</b></td>
          <td style="text-align:right"><b>${mT} °C</b></td>
          <td style="text-align:right;color:${diffM >= 0 ? '#c22525' : '#11698e'}"><b>${diffStr}</b></td>
          <td style="text-align:right">${hotPct}%</td>
          <td>${statusBadge}</td>
        </tr>`;
      })
      .join('');

    const histBarsHtml = colorTempHistogram
      .map(
        (b) =>
          `<div class="hbar-col" title="${b.tempLabel}">
            <div class="hbar-fill" style="height:${b.height.toFixed(1)}%;background:${b.color}"></div>
            <span>${b.shortLabel}</span>
          </div>`,
      )
      .join('');

    const aoiSectionHtml =
      aoi.length >= 3 && aoiStats
        ? `<div class="callout callout-aoi">
            <h3>Recorte Especial: Área de Interesse (AOI Demarcada pelo Analista)</h3>
            <p>Polígono analisado com <b>${aoiStats.count.toLocaleString('pt-BR')} pixels</b> (${(((aoiStats.count * pixelAreaM2) / 10000)).toFixed(2)} ha) · Temperatura Média: <b>${aoiStats.mean.toFixed(2)} °C</b> (Anomalia em relação à cena: <b>${(aoiStats.mean - mean) >= 0 ? '+' : ''}${(aoiStats.mean - mean).toFixed(2)} °C</b>) · Amplitude interna: <b>${aoiStats.min.toFixed(1)} °C a ${aoiStats.max.toFixed(1)} °C</b>.</p>
          </div>`
        : '';

    const report = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Relatório Executivo de Inteligência Térmica Urbana — SR2D4 / LST Explorer</title>
<style>
  :root { --ink:#102329; --muted:#4a636b; --brand:#0d3b4c; --accent:#d97706; --bg:#f4f7f8; --card:#ffffff; --border:#d5e1e4; }
  * { box-sizing:border-box; }
  body { font:14.5px/1.6 system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif; color:var(--ink); background:var(--bg); margin:0; padding:28px; }
  .page { max-width:1180px; margin:0 auto; background:var(--card); padding:42px 48px; border-radius:14px; box-shadow:0 10px 35px rgba(10,32,42,.08); }
  .header-bar { display:flex; justify-content:space-between; align-items:flex-start; border-bottom:3px solid var(--brand); padding-bottom:20px; margin-bottom:26px; gap:20px; }
  .kicker { font-size:11px; font-weight:800; letter-spacing:.12em; color:var(--accent); text-transform:uppercase; }
  h1 { margin:4px 0 8px; font-size:28px; color:var(--brand); line-height:1.2; }
  h2 { margin:34px 0 12px; font-size:19px; color:var(--brand); border-bottom:2px solid var(--border); padding-bottom:8px; display:flex; align-items:center; gap:8px; }
  h3 { margin:16px 0 8px; font-size:15.5px; color:#164e63; }
  p { margin:0 0 12px; }
  .meta-box { font-size:12.5px; color:var(--muted); background:#eef4f6; padding:12px 16px; border-radius:8px; border-left:4px solid var(--brand); margin-bottom:22px; }
  .print-btn { background:var(--brand); color:#fff; border:none; padding:10px 18px; border-radius:8px; font-weight:700; cursor:pointer; font-size:13px; }
  .print-btn:hover { background:#164e63; }
  .kpi-grid { display:grid; grid-template-columns:repeat(6,1fr); gap:12px; margin:18px 0 24px; }
  .kpi { background:#f0f6f8; border:1px solid var(--border); padding:14px; border-radius:10px; }
  .kpi small { display:block; font-size:11px; text-transform:uppercase; color:var(--muted); font-weight:700; }
  .kpi strong { display:block; font-size:22px; color:var(--brand); margin-top:4px; }
  .kpi span { font-size:11.5px; color:var(--muted); }
  .map-triptych { display:grid; grid-template-columns:repeat(3,1fr); gap:14px; margin:18px 0; }
  .map-triptych figure { margin:0; background:#071317; border-radius:10px; overflow:hidden; border:1px solid var(--border); }
  .map-triptych img { width:100%; height:260px; object-fit:cover; display:block; }
  .map-triptych figcaption { padding:9px 12px; color:#e2f1f4; font-size:12px; font-weight:700; text-align:center; }
  table { width:100%; border-collapse:collapse; margin:14px 0 22px; font-size:13.5px; }
  th, td { padding:10px 12px; border-bottom:1px solid var(--border); text-align:left; }
  th { background:#edf4f6; color:var(--brand); font-weight:700; font-size:12px; text-transform:uppercase; }
  .swatch { display:inline-block; width:13px; height:13px; border-radius:3px; margin-right:8px; vertical-align:middle; }
  .badge { display:inline-block; padding:3px 9px; border-radius:99px; font-size:11.5px; font-weight:700; }
  .badge-hot { background:#fee2e2; color:#991b1b; }
  .badge-cool { background:#e0f2fe; color:#075985; }
  .badge-neutral { background:#f1f5f9; color:#334155; }
  .hist-wrap { background:#09171c; color:#e2f1f4; padding:18px 20px; border-radius:10px; margin:16px 0 24px; }
  .hbar-grid { display:grid; grid-template-columns:repeat(24,1fr); align-items:end; gap:4px; height:95px; padding:10px 0 6px; border-bottom:1px solid rgba(255,255,255,.2); }
  .hbar-col { display:flex; flex-direction:column; align-items:center; justify-content:flex-end; height:100%; }
  .hbar-fill { width:100%; border-radius:3px 3px 0 0; }
  .hbar-col span { font-size:9.5px; color:#9ab0b5; margin-top:4px; }
  .two-col { display:grid; grid-template-columns:1fr 1fr; gap:20px; margin:16px 0; }
  .card-panel { background:#f8fbfc; border:1px solid var(--border); border-radius:10px; padding:18px 20px; }
  .card-panel ul { margin:8px 0 0; padding-left:18px; }
  .card-panel li { margin-bottom:8px; }
  .callout { padding:16px 20px; border-radius:10px; margin:18px 0; border-left:5px solid var(--accent); background:#fffbeb; }
  .callout-aoi { border-left-color:#0284c7; background:#f0f9ff; }
  .footer { margin-top:36px; padding-top:16px; border-top:1px solid var(--border); font-size:12px; color:var(--muted); display:flex; justify-content:space-between; }
  @media print {
    body { background:#fff; padding:0; }
    .page { box-shadow:none; padding:15px; max-width:100%; }
    .print-btn { display:none; }
  }
</style>
</head>
<body>
<div class="page">
  <div class="header-bar">
    <div>
      <span class="kicker">SR2D4 / LST EXPLORER • DIAGNÓSTICO GEOTECNOLÓGICO DE ALTA DEFINIÇÃO (1 METRO)</span>
      <h1>Relatório Executivo de Inteligência Térmica, Ambiental, Gestão Pública e Mobilidade Urbana</h1>
    </div>
    <button class="print-btn" onclick="window.print()">🖨️ Imprimir / Salvar PDF</button>
  </div>

  <div class="meta-box">
    <b>Produto Analisado:</b> ${raster.fileName} &nbsp;|&nbsp;
    <b>Dimensões da Grade (1m):</b> ${raster.width.toLocaleString('pt-BR')} × ${raster.height.toLocaleString('pt-BR')} px (${totalAreaHa.toFixed(1)} ha / ${totalAreaKm2.toFixed(2)} km²) &nbsp;|&nbsp;
    <b>Sistema de Referência:</b> EPSG:${raster.epsg} &nbsp;|&nbsp;
    <b>Bandas:</b> Red (B04), NIR (B08), SWIR (B11) + Landsat 8/9 ST_B10
  </div>

  ${aoiSectionHtml}

  <div class="kpi-grid">
    <div class="kpi"><small>LST Mínima (P0.5)</small><strong>${raster.stats.min.toFixed(1)} °C</strong><span>Refúgios frios / água</span></div>
    <div class="kpi"><small>LST Média (μ)</small><strong>${raster.stats.mean.toFixed(1)} °C</strong><span>Mediana Q50: ${raster.stats.q50.toFixed(1)} °C</span></div>
    <div class="kpi"><small>LST Máxima (P99.5)</small><strong>${raster.stats.max.toFixed(1)} °C</strong><span>Amplitude: ${(raster.stats.max - raster.stats.min).toFixed(1)} °C</span></div>
    <div class="kpi"><small>Desvio Térmico (σ)</small><strong>${raster.stats.stdDev.toFixed(2)} °C</strong><span>IQR: ${raster.stats.q25.toFixed(1)}° a ${raster.stats.q75.toFixed(1)}°C</span></div>
    <div class="kpi"><small>Efeito Arborização</small><strong>-${coolingEffect.toFixed(1)} °C</strong><span>Resfriamento médio veg.</span></div>
    <div class="kpi"><small>Área Crítica (UHI)</small><strong>${criticalPct}%</strong><span>${criticalAreaHa} ha acima de ${hotspotThreshold.toFixed(1)} °C</span></div>
  </div>

  <div class="map-triptych">
    <figure><img src="${compositeDataUrl}" alt="Composto LST"><figcaption>1. Fusão Composta LST + Óptico (1 m)</figcaption></figure>
    <figure><img src="${lstPureDataUrl}" alt="Mapa Térmico"><figcaption>2. Campo Térmico / UHI em Alta Definição</figcaption></figure>
    <figure><img src="${opticalDataUrl}" alt="Base Óptica"><figcaption>3. Base Multiespectral SR2D4 (Referência)</figcaption></figure>
  </div>

  <div class="hist-wrap">
    <div style="display:flex;justify-content:space-between;font-size:13px;font-weight:700">
      <span>DISTRIBUIÇÃO ESPECTRAL-TÉRMICA E HISTOGRAMA CROMÁTICO DA CENA (24 FAIXAS)</span>
      <span>Limiar de Hotspot Extremo (μ + 1,4σ): ${hotspotThreshold.toFixed(1)} °C</span>
    </div>
    <div class="hbar-grid">${histBarsHtml}</div>
  </div>

  <h2>1. Análise Espacial e Morfologia das Ilhas de Calor Urbanas (UHI de 1 Metro)</h2>
  <p>A desagregação espacial em 1 metro permite superar a limitação clássica dos blocos de 100 metros do satélite térmico, individualizando o comportamento radiativo de telhados, vias asfaltadas, calçadas, pátios logísticos e copas arbóreas. A tabela abaixo sintetiza a partição territorial das seis classes térmicas identificadas na cena:</p>
  <table>
    <thead>
      <tr>
        <th>Classe de Ilha de Calor (UHI)</th>
        <th>Tipologia Morfológica Predominante (1 m)</th>
        <th style="text-align:right">Temp. Média</th>
        <th style="text-align:right">Área (ha)</th>
        <th style="text-align:right">Proporção</th>
      </tr>
    </thead>
    <tbody>${uhiRowsHtml}</tbody>
  </table>

  <h3>Diagnóstico Zonal por Setores Geográficos da Cena</h3>
  <p>A setorização espacial evidencia assimetrias térmicas intraurbanas. O setor <b>${sectorNames[hottestSectorIdx]}</b> apresenta a maior sobrecarga térmica da área mapeada, enquanto o setor <b>${sectorNames[coolestSectorIdx]}</b> atua como principal infraestrutura natural de amortecimento microclimático:</p>
  <table>
    <thead>
      <tr>
        <th>Setor Geográfico</th>
        <th style="text-align:right">LST Média Setorial</th>
        <th style="text-align:right">Anomalia (Δ vs Média)</th>
        <th style="text-align:right">Área em Hotspot (%)</th>
        <th>Enquadramento para Planejamento</th>
      </tr>
    </thead>
    <tbody>${sectorRowsHtml}</tbody>
  </table>

  <h2>2. Diagnóstico Ambiental, Serviços Ecossistêmicos e Balanço Radiativo</h2>
  <div class="two-col">
    <div class="card-panel">
      <h3>Balanço Biofísico (NDVI × NDBI × LST)</h3>
      <ul>
        <li><b>Cobertura Vegetal Densa (NDVI ≥ 0,35):</b> representa <b>${pct(denseVegCount)}%</b> da cena (${areaHa(denseVegCount)} ha), mantendo temperatura média de <b>${meanVegTemp.toFixed(1)} °C</b> graças à evapotranspiração ativa e interceptação de radiação solar pelo dossel.</li>
        <li><b>Vegetação Rala / Gramados (0,20 ≤ NDVI &lt; 0,35):</b> ocupa <b>${pct(sparseVegCount)}%</b> (${areaHa(sparseVegCount)} ha). Gramados expostos sem sombreamento arbóreo apresentam aquecimento diurno moderado.</li>
        <li><b>Matriz Construída e Impermeável:</b> atinge <b>${pct(imperviousCount)}%</b> (${areaHa(imperviousCount)} ha), com temperatura média de <b>${meanImpTemp.toFixed(1)} °C</b>.</li>
        <li><b>Serviço Ecossistêmico de Resfriamento:</b> o dossel arbóreo proporciona redução térmica média de <b>${coolingEffect.toFixed(2)} °C</b> em relação às superfícies impermeáveis adjacentes.</li>
      </ul>
    </div>
    <div class="card-panel">
      <h3>Índice de Variação do Campo Térmico Urbano (UTFVI)</h3>
      <p>O índice <i>UTFVI = (T<sub>s</sub> − T<sub>média</sub>) / T<sub>média</sub></i> mensura a severidade ecológica da ilha de calor sobre a qualidade ambiental urbana:</p>
      <ul>
        <li><b>Conforto Ecológico Ótimo (UTFVI ≤ 0):</b> <b>${pct(utfviOptimal)}%</b> (${areaHa(utfviOptimal)} ha) — áreas sob influência direta de parques, matas e corpos d'água.</li>
        <li><b>Estresse Térmico Leve (0 &lt; UTFVI ≤ 0,01):</b> <b>${pct(utfviMild)}%</b> (${areaHa(utfviMild)} ha) — tecido residencial com arborização viária.</li>
        <li><b>Estresse Térmico Forte (0,01 &lt; UTFVI ≤ 0,02):</b> <b>${pct(utfviStrong)}%</b> (${areaHa(utfviStrong)} ha) — quadras adensadas com déficit de permeabilidade.</li>
        <li><b>Estresse Ecológico Severo (UTFVI &gt; 0,02):</b> <b>${pct(utfviSevere)}%</b> (${areaHa(utfviSevere)} ha) — núcleos críticos de retenção de calor sensível.</li>
      </ul>
    </div>
  </div>

  <h2>3. Diretrizes para Gestão Pública, Ordenamento Territorial e Adaptação Climática</h2>
  <div class="two-col">
    <div class="card-panel">
      <h3>Instrumentos Urbanísticos e Edilícios</h3>
      <ul>
        <li><b>Programa de Telhados Frios (Cool Roofs) em Grandes Coberturas:</b> os <i>hotspots</i> extremos acima de <b>${hotspotThreshold.toFixed(1)} °C</b> (${criticalAreaHa} ha) concentram-se em galpões logísticos, centros de eventos, hangares e coberturas comerciais. A aplicação de pintura reflexiva (alto índice de refletância solar — SRI ≥ 78) ou telhados verdes reduz a temperatura superficial em até 12 °C e diminui o consumo energético de climatização.</li>
        <li><b>Incentivos Fiscais (IPTU Verde e Quota Ambiental):</b> direcionar redução progressiva de alíquotas para lotes no setor <b>${sectorNames[hottestSectorIdx]}</b> que ampliem a taxa de permeabilidade ou instalem fachadas/coberturas vegetadas.</li>
        <li><b>Microdrenagem e Infraestrutura Verde:</b> implantar jardins de chuva, biovaletas e canteiros pluviais nas zonas de UHI Forte (${areaHa(uhiCounts[4])} ha), combinando retenção de águas pluviais com resfriamento evaporativo.</li>
      </ul>
    </div>
    <div class="card-panel">
      <h3>Saúde Pública e Defesa Civil (Ondas de Calor)</h3>
      <ul>
        <li><b>Mapeamento de Vulnerabilidade Climática:</b> cruzar os polígonos de isotermas acima de <b>${(mean + std).toFixed(1)} °C</b> com o cadastro de equipamentos públicos (escolas, UBS, creches e centros de convivência de idosos).</li>
        <li><b>Refúgios Climáticos Urbanos:</b> qualificar os fragmentos de Ilha de Frescor (${areaHa(uhiCounts[0])} ha) com mobiliário urbano, bebedouros e sombreamento contínuo para atendimento à população em episódios de ondas de calor extremo.</li>
        <li><b>Monitoramento Multitemporal Contínuo:</b> utilizar a exportação vetorial de isotermas (GeoJSON/KML) no SIG municipal para auditar a eficácia do plantio de árvores a cada ciclo anual.</li>
      </ul>
    </div>
  </div>

  <h2>4. Mobilidade Urbana, Infraestrutura Viária e Microclima do Pedestre</h2>
  <p>Na resolução de 1 metro, observa-se forte contribuição da malha viária asfaltada, estacionamentos descobertos e corredores de transporte para a formação de canais contínuos de calor sensível. Para orientar políticas de <b>Mobilidade Urbana Sustentável e Caminhabilidade</b>, recomendam-se as seguintes intervenções:</p>
  <div class="two-col">
    <div class="card-panel">
      <h3>Caminhabilidade, Transporte Coletivo e Ciclovias</h3>
      <ul>
        <li><b>Corredores Verdes de Mobilidade Ativa (Cool Corridors):</b> priorizar o plantio de espécies arbóreas de copa ampla em calçadas e eixos cicloviários situados nas zonas de UHI Moderada e Forte (${pct(uhiCounts[3] + uhiCounts[4])}% da área), garantindo continuidade de sombra nos horários de pico radiativo (10h às 16h).</li>
        <li><b>Conforto Térmico no Transporte Público:</b> substituir coberturas metálicas ou translúcidas sem isolamento em paradas de ônibus e terminais situados em manchas acima de <b>${(mean + 0.85 * std).toFixed(1)} °C</b> por abrigos com cobertura termoacústica/vegetada e arborização adjacente, reduzindo o estresse térmico dos usuários durante o tempo de espera.</li>
      </ul>
    </div>
    <div class="card-panel">
      <h3>Engenharia de Pavimentos e Pátios Viários</h3>
      <ul>
        <li><b>Pavimentos Refletivos e Permeáveis:</b> em recapeamentos de vias locais, bolsões de estacionamento e calçadões que exibem anomalia positiva (&gt; +1σ), adotar asfalto modificado de maior albedo (revestimentos claros/frios) ou blocos intertravados drenantes, mitigando a reemissão de radiação de ondas longas no período noturno.</li>
        <li><b>Sombreamento de Grandes Estacionamentos:</b> exigir arborização mínima (1 árvore a cada 3 vagas) ou cobertura fotovoltaica (*solar carports*) em pátios descobertos identificados como <i>hotspots</i> extremos.</li>
      </ul>
    </div>
  </div>

  <div class="callout">
    <b>Nota Metodológica e Rigor Científico:</b> Os valores térmicos em 1 metro derivam da fusão física conservativa (TsHARP + Desagregação Morfológica Multiescala) entre a radiometria termodinâmica oficial do sensor <b>Landsat 8/9 OLI/TIRS Collection 2 Level-2 (ST_B10)</b> e os índices espectrais de 1 metro do produto <b>SR2D4</b>. Para projetos executivos de engenharia ao nível do lote, recomenda-se aferição complementar in loco.
  </div>

  <div class="footer">
    <span>Gerado em ${new Date().toLocaleString('pt-BR')} pelo <b>SR2D4 / LST Explorer</b></span>
    <span>Laboratório Web GIS Open Source • Resolução Espacial de 1 Metro</span>
  </div>
</div>
</body>
</html>`;

    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([report], { type: 'text/html;charset=utf-8' }));
    a.download = 'SR2D4-LST-relatorio-executivo.html';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // Exportação A / B / Δ em Ultra-HD (4200 px de largura) com tipografia nítida e sem estouro de letras
  const downloadComparisonPanel = async () => {
    if (!comparisonPrimary || !comparisonSecondary || !differenceRender) return;
    const load = (url: string) =>
      new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = reject;
        image.src = url;
      });
    const [a, b, d] = await Promise.all([
      load(comparisonPrimary.lstUrl),
      load(comparisonSecondary.lstUrl),
      load(differenceRender.url),
    ]);

    const panelW = 1400;
    const pad = 28;
    const headerH = 110;
    const imgW = panelW - pad * 2;
    const imgH = Math.round((imgW * a.height) / a.width);
    const legendH = 210;
    const totalW = panelW * 3;
    const totalH = headerH + imgH + legendH + pad * 2;

    const canvas = document.createElement('canvas');
    canvas.width = totalW;
    canvas.height = totalH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    ctx.fillStyle = '#050e12';
    ctx.fillRect(0, 0, totalW, totalH);

    const panels = [
      { image: a, title: `ANTES · ${comparisonPrimary.dateLabel} (LST °C)`, stats: comparisonPrimary.stats },
      { image: b, title: `DEPOIS · ${comparisonSecondary.dateLabel} (LST °C)`, stats: comparisonSecondary.stats },
      { image: d, title: `DIFERENÇA ΔLST (${comparisonSecondary.dateLabel} − ${comparisonPrimary.dateLabel})`, stats: null },
    ];

    panels.forEach((panel, index) => {
      const x0 = index * panelW;

      // Moldura do cartão
      ctx.fillStyle = '#0b1b22';
      ctx.fillRect(x0 + 12, 12, panelW - 24, totalH - 24);
      ctx.strokeStyle = 'rgba(121, 226, 220, 0.35)';
      ctx.lineWidth = 3;
      ctx.strokeRect(x0 + 12, 12, panelW - 24, totalH - 24);

      // Título em Alta Definição (sempre restaurando a fonte em cada painel!)
      ctx.fillStyle = '#ffffff';
      ctx.font = '800 38px system-ui, -apple-system, Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(panel.title, x0 + panelW / 2, 72);

      // Imagem do Mapa
      const imgX = x0 + pad;
      const imgY = headerH;
      ctx.drawImage(panel.image, imgX, imgY, imgW, imgH);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
      ctx.lineWidth = 2;
      ctx.strokeRect(imgX, imgY, imgW, imgH);

      const legY = imgY + imgH + 18;
      if (index === 2) {
        drawDifferenceLegend(ctx, imgX, legY, imgW, legendH - 12, differenceStats);
      } else if (panel.stats) {
        const st = panel.stats;
        ctx.fillStyle = '#071317';
        ctx.fillRect(imgX, legY, imgW, legendH - 12);
        ctx.strokeStyle = 'rgba(121, 226, 220, 0.5)';
        ctx.lineWidth = 2;
        ctx.strokeRect(imgX, legY, imgW, legendH - 12);

        ctx.fillStyle = '#ffffff';
        ctx.font = '700 26px system-ui, -apple-system, Arial, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(
          `ESCALA TÉRMICA (${palette.toUpperCase()}) · Média μ = ${st.mean.toFixed(1)} °C · Desvio σ = ${st.stdDev.toFixed(2)} °C`,
          imgX + 28,
          legY + 42,
        );

        const barX = imgX + 28;
        const barY = legY + 62;
        const barW = imgW - 56;
        const barH = 34;

        const gradient = ctx.createLinearGradient(barX, barY, barX + barW, barY);
        for (let s = 0; s <= 16; s += 1) {
          gradient.addColorStop(s / 16, sampleCssColorAt(s / 16, palette, draftCustomColors, false));
        }
        ctx.fillStyle = gradient;
        ctx.fillRect(barX, barY, barW, barH);
        ctx.strokeStyle = 'rgba(255,255,255,0.75)';
        ctx.lineWidth = 2;
        ctx.strokeRect(barX, barY, barW, barH);

        ctx.fillStyle = '#79e2dc';
        ctx.font = '700 24px system-ui, -apple-system, Arial, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(`Mín: ${st.min.toFixed(1)} °C`, barX, legY + 134);

        ctx.fillStyle = '#e2e8f0';
        ctx.textAlign = 'center';
        ctx.fillText(`Q25: ${st.q25.toFixed(1)}°C  |  Mediana: ${st.q50.toFixed(1)}°C  |  Q75: ${st.q75.toFixed(1)}°C`, x0 + panelW / 2, legY + 134);

        ctx.fillStyle = '#ffb000';
        ctx.textAlign = 'right';
        ctx.fillText(`Máx: ${st.max.toFixed(1)} °C`, barX + barW, legY + 134);

        ctx.textAlign = 'left';
        ctx.fillStyle = '#9ab0b5';
        ctx.font = '500 20px system-ui, -apple-system, Arial, sans-serif';
        ctx.fillText(`Super-resolução térmica de 1 metro ancorada no sensor Landsat 8/9 ST_B10.`, barX, legY + 172);
      }
    });

    const link = document.createElement('a');
    link.href = canvas.toDataURL('image/png');
    link.download = `mapa-diferenca-HD-${comparisonPrimary.dateLabel}-${comparisonSecondary.dateLabel}.png`;
    link.click();
  };

  const uhiLevel = raster ? raster.stats.mean + 1.5 * raster.stats.stdDev : 0;
  const activeInspect = hoverSample || sample;
  const activeDiffInfo =
    activeInspect?.diffTemp !== undefined && differenceStats
      ? differenceClassLabel(activeInspect.diffTemp, differenceStats.mean, differenceStats.thresholdSigma, lang)
      : null;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <LogoMark />
          <div>
            <span className="eyebrow">{t.eyebrow}</span>
            <h1>{t.title}</h1>
          </div>
        </div>
        <div className="top-actions">
          <span className={`status-dot ${raster || differenceReady ? 'active' : ''}`} />
          <span className="status-label">{status || (raster || differenceReady ? t.ready : t.noData)}</span>
          <button className="icon-button" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} title={t.theme}>
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
          </button>
          <button className="lang-button" onClick={() => setLang(lang === 'pt' ? 'en' : 'pt')}>
            {lang === 'pt' ? 'EN' : 'PT'}
          </button>
        </div>
      </header>

      <div className="intro-strip">
        <div>
          <strong>{t.subtitle}</strong>
          <span>
            {raster
              ? `${raster.fileName} · ${raster.width.toLocaleString()} × ${raster.height.toLocaleString()} px · EPSG:${raster.epsg}`
              : 'Local-first analysis for SR2D4 multispectral products'}
          </span>
        </div>
        <a className="colab-button" href={COLAB_URL} target="_blank" rel="noreferrer">
          ↗ {t.colab}
        </a>
      </div>

      <main className="workspace" style={{ '--rail-width': `${panelWidth}px` } as React.CSSProperties}>
        <section className="map-stage" style={{ position: 'relative', overflow: 'hidden' }}>
          <div ref={mapRef} className={`map-container ${identifyMode ? 'identify-active' : ''}`} />
          {swipeActive && differenceReady && (
            <div
              className="curtain-map"
              ref={curtainContainerRef}
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                pointerEvents: 'none',
                zIndex: 2,
                clipPath: `inset(0 0 0 ${swipePosition}%)`,
              }}
              aria-label="Imagem Depois (Data 2)"
            />
          )}
          {swipeActive && differenceReady && (
            <>
              <div
                style={{
                  position: 'absolute',
                  top: '76px',
                  left: '16px',
                  zIndex: 6,
                  background: 'rgba(7, 19, 23, 0.92)',
                  border: '2px solid #38bdf8',
                  color: '#ffffff',
                  padding: '8px 14px',
                  borderRadius: '10px',
                  fontWeight: 800,
                  fontSize: '13px',
                  boxShadow: '0 4px 14px rgba(0,0,0,0.45)',
                  pointerEvents: 'none',
                }}
              >
                <span style={{ color: '#38bdf8', display: 'block', fontSize: '10px', letterSpacing: '0.08em' }}>
                  ◀ LADO ESQUERDO (ANTES)
                </span>
                DATA 1 · {comparisonPrimary?.dateLabel ?? 'ANTES'}
              </div>

              <div
                style={{
                  position: 'absolute',
                  top: '76px',
                  right: '58px',
                  zIndex: 6,
                  background: 'rgba(7, 19, 23, 0.92)',
                  border: '2px solid #ffb000',
                  color: '#ffffff',
                  padding: '8px 14px',
                  borderRadius: '10px',
                  fontWeight: 800,
                  fontSize: '13px',
                  textAlign: 'right',
                  boxShadow: '0 4px 14px rgba(0,0,0,0.45)',
                  pointerEvents: 'none',
                }}
              >
                <span style={{ color: '#ffb000', display: 'block', fontSize: '10px', letterSpacing: '0.08em' }}>
                  LADO DIREITO (DEPOIS) ▶
                </span>
                DATA 2 · {comparisonSecondary?.dateLabel ?? 'DEPOIS'}
              </div>

              <div
                className="curtain-divider"
                style={{
                  position: 'absolute',
                  top: 0,
                  bottom: 0,
                  left: `${swipePosition}%`,
                  width: '4px',
                  background: '#ffb000',
                  boxShadow: '0 0 12px rgba(0,0,0,0.8)',
                  cursor: 'ew-resize',
                  zIndex: 7,
                }}
                onPointerDown={startCurtainDrag}
                role="slider"
                aria-label={lang === 'pt' ? 'Arrastar cortina entre antes e depois' : 'Drag curtain between before and after'}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={swipePosition}
                tabIndex={0}
              >
                <div
                  style={{
                    position: 'absolute',
                    top: '50%',
                    left: '50%',
                    transform: 'translate(-50%, -50%)',
                    background: '#071317',
                    border: '2px solid #ffb000',
                    color: '#ffffff',
                    padding: '6px 12px',
                    borderRadius: '999px',
                    fontSize: '11px',
                    fontWeight: 800,
                    whiteSpace: 'nowrap',
                    boxShadow: '0 4px 14px rgba(0,0,0,0.65)',
                  }}
                >
                  ◀ ANTES | DEPOIS ▶
                </div>
              </div>
            </>
          )}
          {drawAoi && (
            <div
              style={{
                position: 'absolute',
                bottom: '22px',
                left: '50%',
                transform: 'translateX(-50%)',
                zIndex: 8,
                background: 'rgba(7, 19, 23, 0.94)',
                border: '2px solid #ffb000',
                color: '#ffffff',
                padding: '8px 16px',
                borderRadius: '999px',
                fontSize: '12px',
                fontWeight: 700,
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                boxShadow: '0 6px 20px rgba(0,0,0,0.55)',
              }}
            >
              <span>⌗ Modo Desenho AOI ({aoi.length} {aoi.length === 1 ? 'ponto' : 'pontos'}) — Clique no mapa para marcar vértices</span>
              {aoi.length >= 3 && (
                <button
                  onClick={finishAoi}
                  style={{
                    background: '#ffb000',
                    color: '#071317',
                    border: 'none',
                    padding: '4px 10px',
                    borderRadius: '99px',
                    fontWeight: 800,
                    cursor: 'pointer',
                  }}
                >
                  ✓ Concluir AOI
                </button>
              )}
              <button
                onClick={clearAoi}
                style={{
                  background: 'transparent',
                  color: '#f87171',
                  border: '1px solid #f87171',
                  padding: '4px 10px',
                  borderRadius: '99px',
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                × Cancelar
              </button>
            </div>
          )}
          {showSearch ? (
            <div className="map-search">
              <div className="search-line">
                <Icon name="search" />
                <input value={search} placeholder={t.search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && searchPlace()} />
                <button onClick={searchPlace} disabled={searching}>
                  {searching ? '…' : t.go}
                </button>
                <button
                  className="search-close"
                  onClick={() => {
                    setShowSearch(false);
                    setSearchResults([]);
                  }}
                  aria-label={lang === 'pt' ? 'Fechar busca' : 'Close search'}
                >
                  ×
                </button>
              </div>
              {searchResults.length > 0 && (
                <div className="search-results">
                  {searchResults.map((result) => (
                    <button
                      key={`${result.lat}-${result.lon}`}
                      onClick={() => {
                        goTo(Number(result.lon), Number(result.lat));
                        setSearchResults([]);
                      }}
                    >
                      {result.display_name}
                    </button>
                  ))}
                </div>
              )}
              <div className="coord-line">
                <Icon name="pin" />
                <input value={coordText} placeholder={t.coords} onChange={(e) => setCoordText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && goToCoordinates()} />
                <button onClick={goToCoordinates}>{t.go}</button>
                <button className="gps-button" onClick={locateMe} title={t.locate}>
                  <Icon name="gps" />
                </button>
              </div>
              {searchError && <small className="search-error">{searchError}</small>}
            </div>
          ) : (
            <button className="search-open" onClick={() => setShowSearch(true)} title={t.search}>
              <Icon name="search" />
            </button>
          )}
          {!raster && !differenceReady && (
            <div className="map-empty">
              <div className="empty-orbit">◌</div>
              <strong>{t.noData}</strong>
              <span>{t.uploadHint}</span>
            </div>
          )}
          {(raster || differenceReady) && (
            <div className={`map-legend ${displayMode === 'uhi' ? 'uhi-legend' : ''}`} style={{ top: '14px', right: '54px', bottom: 'auto', left: 'auto', maxWidth: '370px', zIndex: 5 }}>
              <span>
                {comparisonMode === 'difference' && differenceReady && !swipeActive
                  ? `Δ LST (${comparisonPrimary?.dateLabel ?? 'Antes'} → ${comparisonSecondary?.dateLabel ?? 'Depois'}) · 1σ = ±${differenceStats?.thresholdSigma.toFixed(2) ?? '1.0'}°C`
                  : swipeActive && differenceReady
                    ? `CORTINA: ${comparisonPrimary?.dateLabel ?? 'Antes'} ◀ | ▶ ${comparisonSecondary?.dateLabel ?? 'Depois'}`
                    : displayMode === 'uhi'
                      ? `UHI (${uhiMethod.toUpperCase()} · γ=${uhiPower.toFixed(2)})`
                      : t.lst}
              </span>
              {comparisonMode === 'difference' && differenceReady && !swipeActive && differenceStats ? (
                <>
                  <div className="legend-gradient" style={{ background: DIFFERENCE_GRADIENT_CSS, height: '10px', borderRadius: '5px' }} />
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', marginTop: '4px' }}>
                    <b style={{ color: '#48cae4' }}>↓ Diminuiu (&lt; -1σ)</b>
                    <b style={{ color: '#cbd5e1' }}>＝ Igual (±1σ)</b>
                    <b style={{ color: '#ff9e00' }}>↑ Aumentou (&gt; +1σ)</b>
                  </div>
                  <small className="difference-note" style={{ display: 'block', marginTop: '3px', fontSize: '10px', opacity: 0.88 }}>
                    ↓ {differenceStats.pctDecreased.toFixed(1)}% · ＝ {differenceStats.pctEqual.toFixed(1)}% · ↑ {differenceStats.pctIncreased.toFixed(1)}% (Média Δ: {differenceStats.mean >= 0 ? '+' : ''}{differenceStats.mean.toFixed(1)}°C)
                  </small>
                </>
              ) : displayMode === 'uhi' ? (
                <>
                  <div className="legend-gradient" style={{ background: uhiGradient }} />
                  <div>
                    <b>Frescor</b>
                    <b>Neutro</b>
                    <b>Forte</b>
                    <b>Hotspot</b>
                  </div>
                </>
              ) : (
                <>
                  <div className="legend-gradient" style={{ background: legendGradient }} />
                  <div>
                    <b>{(raster?.stats.min ?? comparisonPrimary?.stats.min ?? 0).toFixed(1)}°C</b>
                    <b>{(raster?.stats.mean ?? comparisonPrimary?.stats.mean ?? 0).toFixed(1)}°C</b>
                    <b>{(raster?.stats.max ?? comparisonPrimary?.stats.max ?? 0).toFixed(1)}°C</b>
                  </div>
                </>
              )}
            </div>
          )}
          <div className="map-tools">
            <button onClick={zoomIn} title="Zoom in">＋</button>
            <button onClick={zoomOut} title="Zoom out">−</button>
            <button className={panEnabled ? 'active' : ''} onClick={togglePan} title="Pan">✋</button>
            <button className={identifyMode ? 'active' : ''} onClick={toggleIdentify} title="Identify">ⓘ</button>
            <button className={drawAoi ? 'active' : ''} onClick={toggleAoi} title={t.draw}>⌗</button>
            {drawAoi && aoi.length >= 3 && (
              <button onClick={finishAoi} title={lang === 'pt' ? 'Finalizar desenho' : 'Finish drawing'}>✓</button>
            )}
            {!drawAoi && aoi.length >= 3 && (
              <button onClick={analyzeAoi} title={t.clip}>✓</button>
            )}
          </div>
        </section>

        <div
          className="resize-handle"
          onPointerDown={() => {
            resizing.current = true;
            document.body.classList.add('is-resizing');
          }}
          title={t.resize}
        >
          <Icon name="resize" />
        </div>

        <aside className="control-rail">
          <div className="rail-scroll">
            <div className="scroll-map-tools" aria-label={lang === 'pt' ? 'Controles rápidos do mapa' : 'Quick map controls'}>
              <button onClick={zoomIn} title="Zoom in">＋</button>
              <button onClick={zoomOut} title="Zoom out">−</button>
              <button className={panEnabled ? 'active' : ''} onClick={togglePan} title="Pan">✋</button>
              <button className={identifyMode ? 'active' : ''} onClick={toggleIdentify} title={lang === 'pt' ? 'Identificar temperatura' : 'Identify temperature'}>ⓘ</button>
              <button
                className={drawAoi ? 'active' : ''}
                onClick={drawAoi ? finishAoi : aoi.length >= 3 ? clearAoi : toggleAoi}
                title={drawAoi ? (lang === 'pt' ? 'Finalizar AOI' : 'Finish AOI') : aoi.length >= 3 ? t.clear : t.draw}
              >
                ⌗
              </button>
            </div>

            <section className="rail-card start-card">
              <div className="card-kicker">00 / START HERE</div>
              <div className="card-heading">
                <h3>{lang === 'pt' ? 'Primeiros passos' : 'Start here'}</h3>
                <span className="chip">{tutorialStep + 1}/4</span>
              </div>
              <p className="microcopy">{lang === 'pt' ? 'Veja o tutorial, entenda a metodologia e depois carregue seu raster.' : 'Watch the tutorial, review the methodology, then load your raster.'}</p>
              <div className="start-actions">
                <button onClick={() => { setTutorialStep(0); setShowTutorial(true); }}>▶ Tutorial</button>
                <button onClick={() => setShowMethod(true)}>◈ {t.method}</button>
                <button onClick={() => setShowHelp(true)}>？ {t.help}</button>
                <button onClick={() => setShowLimits(true)}>△ {t.limitation}</button>
                <button onClick={() => setShowMeta(true)} disabled={!raster}>⌁ {t.metadata}</button>
              </div>
            </section>

            <section className="rail-card hero-card">
              <div className="card-kicker">01 / INPUT</div>
              <h2>{t.upload}</h2>
              <p>{t.uploadHint}</p>
              <label className="file-drop" style={{ cursor: 'pointer', position: 'relative', zIndex: 10 }}>
                <input
                  type="file"
                  accept=".tif,.tiff,image/tiff,application/geotiff,application/octet-stream"
                  style={{ position: 'absolute', inset: 0, opacity: 0, width: '100%', height: '100%', cursor: 'pointer', zIndex: 12 }}
                  onChange={(e) => void handleFileChange(e.target.files?.[0] || null)}
                />
                <span className="upload-icon">↑</span>
                <strong>{file ? file.name : lang === 'pt' ? 'Escolher GeoTIFF' : 'Choose GeoTIFF'}</strong>
                <small>
                  {file
                    ? `${(file.size / 1024 / 1024).toFixed(1)} MB · ${visibleBandCount} ${lang === 'pt' ? 'bandas detectadas' : 'bands detected'}`
                    : 'TIFF / BigTIFF supported by GeoTIFF reader'}
                </small>
              </label>

              <div className="band-grid">
                <h3>{t.bands}</h3>
                <label title={lang === 'pt' ? 'Selecione a banda vermelha do sensor. Em Sentinel-2, normalmente Banda 04.' : 'Select the sensor red band. In Sentinel-2, usually Band 04.'}>
                  {t.red}
                  <small className="band-role">{lang === 'pt' ? 'selecione a camada identificada como Red/B04' : 'select the layer identified as Red/B04'}</small>
                  <select value={bands[0]} onChange={(e) => updateBand(0, e.target.value)}>{options}</select>
                </label>
                <label title={lang === 'pt' ? 'Selecione a banda NIR. Em Sentinel-2, normalmente Banda 08.' : 'Select the NIR band. In Sentinel-2, usually Band 08.'}>
                  {t.nir}
                  <small className="band-role">{lang === 'pt' ? 'selecione a camada identificada como NIR/B08' : 'select the layer identified as NIR/B08'}</small>
                  <select value={bands[1]} onChange={(e) => updateBand(1, e.target.value)}>{options}</select>
                </label>
                <label title={lang === 'pt' ? 'Selecione a banda SWIR. Em Sentinel-2, normalmente Banda 11 ou 12.' : 'Select the SWIR band. In Sentinel-2, usually Band 11 or 12.'}>
                  {t.swir}
                  <small className="band-role">{lang === 'pt' ? 'somente SWIR/B11 ou SWIR/B12; não use B10 por posição' : 'only SWIR/B11 or SWIR/B12; do not infer B10 by position'}</small>
                  <select value={bands[2]} onChange={(e) => updateBand(2, e.target.value)}>{options}</select>
                </label>
              </div>

              <div className="processing-log" aria-live="polite">
                <div className="processing-log-head">
                  <b>{lang === 'pt' ? 'Log de processamento' : 'Processing log'}</b>
                  <span>{busy ? (lang === 'pt' ? 'em andamento' : 'running') : processingLog.length ? (lang === 'pt' ? 'última execução' : 'last run') : '—'}</span>
                </div>
                {processingLog.length ? (
                  <div className="processing-log-list">
                    {processingLog.map((entry, index) => (
                      <div className={`processing-log-entry ${entry.level}`} key={`${entry.time}-${index}`}>
                        <time>{entry.time}</time>
                        <span>{entry.message}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p>{lang === 'pt' ? 'As etapas aparecerão aqui quando você clicar em Calcular temperatura.' : 'Steps will appear here when you click Calculate temperature.'}</p>
                )}
              </div>

              {isStandardSr2d4TenBand && (
                <p className="microcopy" style={{ color: '#9edb86' }}>
                  <b>SR2D4/MS x10 reconhecido:</b> Camada 03 = B04 Red; Camada 07 = B08 NIR; Camada 09 = B11 SWIR-1 (recomendado) ou Camada 10 = B12 SWIR-2.{' '}
                  <a href="https://www.researchgate.net/figure/Sentinel-2-band-characteristics_tbl1_314119510" target="_blank" rel="noreferrer">
                    Referência das bandas Sentinel-2
                  </a>.
                </p>
              )}
              {!hasSpectralMetadata && (
                <p className="microcopy" style={{ color: '#f2b84b' }}>
                  {lang === 'pt'
                    ? 'Aviso: este GeoTIFF não informa os nomes espectrais no metadata. Camada 10 não significa Sentinel-2 B10 nem SWIR. Confira a ordem usada no Colab antes de calcular.'
                    : 'Warning: this GeoTIFF has no spectral names in its metadata. Layer 10 does not mean Sentinel-2 B10 or SWIR. Check the Colab export order before calculating.'}
                </p>
              )}

              <button className="primary-button" onClick={() => void processFile()} disabled={!file || busy}>
                {busy ? t.processing : t.calculate}
                <span>→</span>
              </button>
              {error && <div className="error-box">{error}</div>}
            </section>

            {(raster || differenceReady || hoverSample || sample || identifyMode) && (
              <section className="rail-card inspector-rail-card">
                <div className="card-heading">
                  <h3>ⓘ {t.sample}</h3>
                  <span className="chip">
                    {differenceReady && activeInspect?.diffTemp !== undefined
                      ? 'Δ LST ±1σ'
                      : displayMode === 'uhi'
                        ? 'UHI 1m'
                        : '°C'}
                  </span>
                </div>
                <div className="inspector-split">
                  <div>
                    {differenceReady && activeInspect?.diffTemp !== undefined && differenceStats ? (
                      <>
                        <strong className="inspector-temperature" style={{ color: activeDiffInfo?.color }}>
                          {activeInspect.diffTemp >= 0 ? `+${activeInspect.diffTemp.toFixed(2)}°C` : `${activeInspect.diffTemp.toFixed(2)}°C`}
                        </strong>
                        <span className="inspector-uhi-class" style={{ display: 'block', marginTop: '4px' }}>
                          <b style={{ color: activeDiffInfo?.color }}>{activeDiffInfo?.label}</b>
                        </span>
                        <div className="inspector-coordinates" style={{ marginTop: '4px' }}>
                          Antes: <b>{activeInspect.beforeTemp?.toFixed(1) ?? '—'}°C</b> → Depois: <b>{activeInspect.afterTemp?.toFixed(1) ?? '—'}°C</b>
                          <br />
                          Anomalia Local: <b>{activeDiffInfo && activeDiffInfo.rel >= 0 ? `+${activeDiffInfo.rel.toFixed(2)}` : activeDiffInfo?.rel.toFixed(2)}°C</b> (1σ = ±{differenceStats.thresholdSigma.toFixed(2)}°C)
                        </div>
                      </>
                    ) : (
                      <>
                        <strong className="inspector-temperature">
                          {activeInspect ? `${activeInspect.temp.toFixed(1)}°C` : `${raster?.stats.mean.toFixed(1) ?? comparisonPrimary?.stats.mean.toFixed(1) ?? '—'}°C`}
                        </strong>
                        {raster && (
                          <span className="inspector-uhi-class">
                            {activeInspect ? `${lang === 'pt' ? 'Nível local' : 'Local level'}: ` : `${lang === 'pt' ? 'Média da cena' : 'Scene mean'} · `}
                            <b>
                              {activeInspect
                                ? uhiClassLabel(activeInspect.temp, raster.stats, uhiMethod, uhiPower, lang)
                                : `${raster.stats.min.toFixed(1)}°C – ${raster.stats.max.toFixed(1)}°C`}
                            </b>
                          </span>
                        )}
                        {activeInspect && (
                          <div className="inspector-coordinates">
                            Lat: {activeInspect.lat.toFixed(4)} · Lon: {activeInspect.lng.toFixed(4)}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                  <div className="side-legends">
                    <div className="side-legend">
                      <b>
                        {differenceReady && comparisonMode === 'difference' && !swipeActive
                          ? 'Escala ΔLST (±1σ)'
                          : displayMode === 'uhi'
                            ? 'Escala UHI (8 níveis)'
                            : lang === 'pt'
                              ? `Paleta: ${palette}`
                              : `Palette: ${palette}`}
                      </b>
                      <i
                        className="legend-gradient"
                        style={{
                          background:
                            differenceReady && comparisonMode === 'difference' && !swipeActive
                              ? DIFFERENCE_GRADIENT_CSS
                              : legendGradient,
                        }}
                      />
                      <small>
                        {differenceReady && comparisonMode === 'difference' && !swipeActive
                          ? 'Diminuiu ← Igual (±1σ) → Aumentou'
                          : displayMode === 'uhi'
                            ? 'Frescor → Neutro → Hotspot'
                            : `${raster?.stats.min.toFixed(1) ?? '—'}°C → ${raster?.stats.max.toFixed(1) ?? '—'}°C`}
                      </small>
                    </div>
                  </div>
                </div>

                {raster && colorTempHistogram.length > 0 && (
                  <div style={{ marginTop: '12px', padding: '10px', background: 'rgba(0,0,0,0.22)', borderRadius: '8px', border: '1px solid rgba(121,226,220,0.14)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px', fontSize: '11px', opacity: 0.85 }}>
                      <b>{t.histogram}</b>
                      <span>σ = {raster.stats.stdDev.toFixed(2)}°C</span>
                    </div>
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: `repeat(${colorTempHistogram.length}, 1fr)`,
                        alignItems: 'end',
                        gap: '2px',
                        height: '64px',
                        paddingBottom: '4px',
                      }}
                    >
                      {colorTempHistogram.map((bar, idx) => (
                        <div
                          key={idx}
                          title={bar.tempLabel}
                          style={{
                            height: `${bar.height}%`,
                            background: bar.color,
                            borderRadius: '2px 2px 0 0',
                            boxShadow: '0 0 2px rgba(0,0,0,0.4)',
                          }}
                        />
                      ))}
                    </div>
                    <div className="legend-gradient" style={{ background: legendGradient, height: '8px', borderRadius: '4px', margin: '2px 0 5px' }} />
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', opacity: 0.82 }}>
                      <span>{raster.stats.min.toFixed(1)}°C</span>
                      <span>Q25: {raster.stats.q25.toFixed(1)}°</span>
                      <b>μ: {raster.stats.mean.toFixed(1)}°C</b>
                      <span>Q75: {raster.stats.q75.toFixed(1)}°</span>
                      <span>{raster.stats.max.toFixed(1)}°C</span>
                    </div>
                  </div>
                )}

                <div className="control-row" style={{ marginTop: '10px' }}>
                  <span>{lang === 'pt' ? 'Modo' : 'Mode'}</span>
                  <select value={displayMode} onChange={(e) => setDisplayMode(e.target.value as 'temperature' | 'uhi')}>
                    <option value="temperature">{lang === 'pt' ? 'Temperatura (°C)' : 'Temperature (°C)'}</option>
                    <option value="uhi">UHI / {lang === 'pt' ? 'ilhas de calor (1m)' : 'heat islands (1m)'}</option>
                  </select>
                </div>

                {displayMode === 'temperature' ? (
                  <>
                    <div className="control-row">
                      <span>{t.palette}</span>
                      <select value={palette} onChange={(e) => setPalette(e.target.value as PaletteType)}>
                        <option value="ironbow">Ironbow (Perceptual HD)</option>
                        <option value="spectral">Spectral</option>
                        <option value="jet">Jet</option>
                        <option value="viridis">Viridis</option>
                        <option value="magma">Magma</option>
                        <option value="coolwarm">Coolwarm</option>
                        <option value="terrain">Terrain</option>
                        <option value="grayscale">Grayscale</option>
                        <option value="custom">Custom (Rápido)</option>
                      </select>
                    </div>
                    {palette === 'custom' && (
                      <div style={{ marginTop: '8px', padding: '8px', background: 'rgba(255,255,255,0.03)', borderRadius: '6px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                          <small style={{ fontSize: '11px', opacity: 0.85 }}>
                            {lang === 'pt' ? 'Toque para editar paradas (instantâneo):' : 'Edit stops (instant):'}
                          </small>
                          <div style={{ display: 'flex', gap: '4px' }}>
                            <button
                              type="button"
                              style={{ padding: '2px 6px', fontSize: '10px' }}
                              onClick={() => setDraftCustomColors((prev) => [...prev].reverse())}
                            >
                              ⇄ {lang === 'pt' ? 'Inverter' : 'Invert'}
                            </button>
                            <button
                              type="button"
                              style={{ padding: '2px 6px', fontSize: '10px' }}
                              onClick={() => setDraftCustomColors(DEFAULT_CUSTOM_COLORS)}
                            >
                              ↺ Reset
                            </button>
                          </div>
                        </div>
                        <div className="custom-colors" style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: '6px' }}>
                          {draftCustomColors.map((color, index) => (
                            <input
                              key={index}
                              type="color"
                              value={color}
                              onChange={(e) => {
                                const val = e.target.value;
                                setDraftCustomColors((colors) => colors.map((item, i) => (i === index ? val : item)));
                              }}
                              title={`Stop ${index + 1}`}
                              style={{ width: '100%', height: '28px', cursor: 'pointer', border: 'none', borderRadius: '4px' }}
                            />
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div className="control-row">
                      <span>{lang === 'pt' ? 'Clustering UHI' : 'UHI Clustering'}</span>
                      <select value={uhiMethod} onChange={(e) => setUhiMethod(e.target.value as UhiClusterMethod)}>
                        <option value="zscore">{lang === 'pt' ? 'Z-Score (Desvio-Padrão)' : 'Z-Score (Std Dev)'}</option>
                        <option value="quantiles">{lang === 'pt' ? 'Quantis Adaptativos (IQR)' : 'Adaptive Quantiles (IQR)'}</option>
                        <option value="natural">{lang === 'pt' ? 'Quebras Naturais (Jenks-Otsu)' : 'Natural Breaks (Jenks)'}</option>
                        <option value="kernel">{lang === 'pt' ? 'Kernel Espacial (Gi* Hotspot)' : 'Spatial Kernel (Gi* Hotspot)'}</option>
                      </select>
                    </div>
                    <div className="control-row">
                      <span>
                        {lang === 'pt' ? 'Potenciação (γ)' : 'Power (γ)'} <b>{uhiPower.toFixed(2)}x</b>
                      </span>
                      <input
                        type="range"
                        min="0.60"
                        max="2.20"
                        step="0.05"
                        value={uhiPower}
                        onChange={(e) => setUhiPower(Number(e.target.value))}
                      />
                    </div>
                  </>
                )}

                <p className="microcopy">{lang === 'pt' ? 'Clique ou ative ⓘ para inspecionar temperatura e variação ΔLST.' : 'Click or enable ⓘ to inspect temperature and ΔLST.'}</p>
              </section>
            )}

            <section className="rail-card">
              <div className="card-heading">
                <h3><Icon name="layers" /> {t.layers}</h3>
                <span className="chip">{raster ? (uhiSurfaceVisible ? '3' : '2') : '0'}</span>
              </div>
              <LayerRow label={t.lst} visible={visibleLst} onToggle={() => setVisibleLst(!visibleLst)} color="thermal" />
              <LayerRow label={t.optical} visible={visibleOptical} onToggle={() => setVisibleOptical(!visibleOptical)} color="optical" />
              {raster && (
                <LayerRow
                  label={lang === 'pt' ? 'Clusterizar / Isotermas (vetor)' : 'Cluster / Isotherms (vector)'}
                  visible={uhiSurfaceVisible}
                  onToggle={() => setUhiSurfaceVisible(!uhiSurfaceVisible)}
                  color="thermal"
                />
              )}
              <div className="control-row">
                <span>{t.basemap}</span>
                <select value={provider} onChange={(e) => setProvider(e.target.value as Provider)}>
                  <option value="osm">OpenStreetMap</option>
                  <option value="esri">Esri World Imagery</option>
                </select>
              </div>
              <div className="control-row">
                <span>{t.opacity}</span>
                <input type="range" min="0" max="1" step="0.05" value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} />
              </div>
              <div className="control-row">
                <span>{t.contrast}</span>
                <input type="range" min="-1" max="1" step="0.05" value={contrast} onChange={(e) => setContrast(Number(e.target.value))} />
              </div>
            </section>

            <section className="rail-card compare-card">
              <div className="card-heading">
                <h3>{t.compare}</h3>
                <span className="chip">{comparisonImages.length ? `${comparisonImages.length} LST` : '—'}</span>
              </div>
              <p className="microcopy comparison-help">
                {lang === 'pt'
                  ? 'Escolha as datas para comparar. Somente diferenças acima de 1 desvio-padrão (±1σ) são classificadas como Aumentou ou Diminuiu.'
                  : 'Choose dates to compare. Only differences beyond 1 standard deviation (±1σ) are classified as Increased or Decreased.'}
              </p>
              <div className="control-row comparison-count">
                <span>{lang === 'pt' ? 'Quantidade de imagens' : 'Number of images'}</span>
                <select value={comparisonCount} onChange={(e) => updateComparisonCount(Number(e.target.value))}>
                  {[2, 3, 4, 5, 6].map((value) => (
                    <option key={value} value={value}>{value}</option>
                  ))}
                </select>
              </div>
              <div className="comparison-file-list">
                {comparisonFiles.map((selected, index) => (
                  <label className="comparison-file" key={index} style={{ cursor: 'pointer', position: 'relative' }}>
                    <span>
                      <b>{index === 0 ? (lang === 'pt' ? 'Imagem 1 (ANTES)' : 'Image 1 (BEFORE)') : index === 1 ? (lang === 'pt' ? 'Imagem 2 (DEPOIS)' : 'Image 2 (AFTER)') : `${lang === 'pt' ? 'Imagem' : 'Image'} ${index + 1}`}</b>
                      <small>{selected ? `${imageDateLabel(selected.name, index)} · ${selected.name}` : lang === 'pt' ? 'Selecione um GeoTIFF SR2D4/MS' : 'Select an SR2D4/MS GeoTIFF'}</small>
                    </span>
                    <input
                      type="file"
                      accept=".tif,.tiff,image/tiff,application/geotiff,application/octet-stream"
                      style={{ position: 'absolute', inset: 0, opacity: 0, width: '100%', height: '100%', cursor: 'pointer', zIndex: 12 }}
                      onChange={(e) => {
                        const selectedFile = e.target.files?.[0] ?? null;
                        setComparisonFiles((previous) => previous.map((item, itemIndex) => (itemIndex === index ? selectedFile : item)));
                        setDifferenceReady(false);
                      }}
                      disabled={busy}
                    />
                  </label>
                ))}
              </div>
              {comparisonImages.length > 0 && (
                <div className="comparison-list">
                  {comparisonImages.map((image, idx) => (
                    <div className="comparison-result" key={image.id}>
                      <b>{idx === 0 ? `ANTES (${image.dateLabel})` : idx === 1 ? `DEPOIS (${image.dateLabel})` : image.dateLabel}</b>
                      <span>{image.name}</span>
                      <em>μ {image.stats.mean.toFixed(1)}°C</em>
                    </div>
                  ))}
                </div>
              )}
              <div className="compare-actions">
                <button onClick={calculateDifference} disabled={busy || comparisonFiles.filter(Boolean).length < 2}>
                  {busy ? (lang === 'pt' ? 'Processando…' : 'Processing…') : lang === 'pt' ? 'Calcular Δ LST (Depois − Antes)' : 'Calculate Δ LST'}
                </button>
                <button
                  onClick={() => {
                    setSwipeActive(false);
                    setComparisonMode('difference');
                  }}
                  disabled={!differenceReady}
                  className={!swipeActive && differenceReady && comparisonMode === 'difference' ? 'active' : ''}
                >
                  {lang === 'pt' ? 'Mapa Diferença' : 'Difference Map'}
                </button>
                <button
                  onClick={() => setSwipeActive(!swipeActive)}
                  disabled={!differenceReady}
                  className={swipeActive ? 'active' : ''}
                >
                  {swipeActive ? (lang === 'pt' ? 'Cortina Fixa Ativa' : 'Curtain Active') : lang === 'pt' ? 'Cortina (Antes/Depois)' : 'Curtain (Swipe)'}
                </button>
                <button onClick={() => void downloadComparisonPanel()} disabled={!differenceReady}>
                  {lang === 'pt' ? 'Exportar Painel HD (A/B/Δ)' : 'Export HD Panel (A/B/Δ)'}
                </button>
              </div>
              {swipeActive && differenceReady && (
                <label className="swipe-control">
                  <span>
                    ◀ ANTES ({comparisonPrimary?.dateLabel}) | DEPOIS ({comparisonSecondary?.dateLabel}) ▶ <b>{swipePosition.toFixed(0)}%</b>
                  </span>
                  <input type="range" min="0" max="100" value={swipePosition} onChange={(e) => setSwipePosition(Number(e.target.value))} />
                </label>
              )}
              {differenceReady && differenceStats && (
                <div style={{ marginTop: '10px', padding: '10px', background: 'rgba(0,0,0,0.26)', borderRadius: '8px', border: '1px solid rgba(121,226,220,0.18)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', marginBottom: '6px' }}>
                    <b>Escala de Mudança Térmica (±1σ = ±{differenceStats.thresholdSigma.toFixed(2)}°C)</b>
                  </div>
                  <div className="legend-gradient" style={{ background: DIFFERENCE_GRADIENT_CSS, height: '10px', borderRadius: '5px', marginBottom: '8px' }} />
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px', textAlign: 'center', fontSize: '11px' }}>
                    <div style={{ padding: '6px', background: 'rgba(0, 150, 199, 0.18)', border: '1px solid #48cae4', borderRadius: '6px' }}>
                      <b style={{ color: '#48cae4', display: 'block' }}>↓ DIMINUIU</b>
                      <span>&lt; -{differenceStats.thresholdSigma.toFixed(2)}°C</span>
                      <strong style={{ display: 'block', fontSize: '13px', marginTop: '2px' }}>{differenceStats.pctDecreased.toFixed(1)}%</strong>
                    </div>
                    <div style={{ padding: '6px', background: 'rgba(148, 163, 184, 0.14)', border: '1px solid #94a3b8', borderRadius: '6px' }}>
                      <b style={{ color: '#cbd5e1', display: 'block' }}>＝ IGUAL</b>
                      <span>±{differenceStats.thresholdSigma.toFixed(2)}°C</span>
                      <strong style={{ display: 'block', fontSize: '13px', marginTop: '2px' }}>{differenceStats.pctEqual.toFixed(1)}%</strong>
                    </div>
                    <div style={{ padding: '6px', background: 'rgba(247, 127, 0, 0.18)', border: '1px solid #ff9e00', borderRadius: '6px' }}>
                      <b style={{ color: '#ff9e00', display: 'block' }}>↑ AUMENTOU</b>
                      <span>&gt; +{differenceStats.thresholdSigma.toFixed(2)}°C</span>
                      <strong style={{ display: 'block', fontSize: '13px', marginTop: '2px' }}>{differenceStats.pctIncreased.toFixed(1)}%</strong>
                    </div>
                  </div>
                </div>
              )}
              {differenceReady && differenceRender && comparisonPrimary && comparisonSecondary && (
                <div className="comparison-triptych">
                  <figure>
                    <img src={comparisonPrimary.lstUrl} alt="Antes LST" />
                    <figcaption>ANTES · {comparisonPrimary.dateLabel}</figcaption>
                  </figure>
                  <figure>
                    <img src={comparisonSecondary.lstUrl} alt="Depois LST" />
                    <figcaption>DEPOIS · {comparisonSecondary.dateLabel}</figcaption>
                  </figure>
                  <figure>
                    <img src={differenceRender.url} alt="Diferença LST" />
                    <figcaption>Δ LST (±1σ)</figcaption>
                  </figure>
                </div>
              )}
            </section>

            {raster && (
              <>
                <section className="rail-card">
                  <div className="card-heading">
                    <h3>{t.stats}</h3>
                    <span className="chip">°C</span>
                  </div>
                  <div className="metric-grid">
                    <Metric label={t.min} value={raster.stats.min.toFixed(1)} />
                    <Metric label={t.mean} value={raster.stats.mean.toFixed(1)} />
                    <Metric label={t.max} value={raster.stats.max.toFixed(1)} />
                    <Metric label={t.std} value={raster.stats.stdDev.toFixed(2)} />
                  </div>
                  <p className="microcopy">
                    {t.uhiText} {raster.stats.max >= uhiLevel ? `Hotspot threshold: ${uhiLevel.toFixed(1)}°C` : ''}
                  </p>
                </section>

                <section className="rail-card">
                  <div className="card-heading">
                    <h3>{t.indices}</h3>
                    <span className="chip">MS</span>
                  </div>
                  <div className="metric-grid index-grid">
                    <Metric label={t.ndvi} value={meanOf(raster.ndvi).toFixed(3)} />
                    <Metric label={t.ndbi} value={meanOf(raster.ndbi).toFixed(3)} />
                  </div>
                </section>

                <section className="rail-card">
                  <div className="card-heading">
                    <h3>{t.aoi}</h3>
                    <span className="chip">{aoi.length >= 3 ? `${aoi.length} pts ✓` : drawAoi ? `${aoi.length} pts…` : '—'}</span>
                  </div>
                  <p className="microcopy">
                    {aoi.length >= 3
                      ? aoiStats
                        ? `${lang === 'pt' ? 'Média AOI: ' : 'AOI Mean: '}${aoiStats.mean.toFixed(2)}°C · ${aoiStats.count.toLocaleString()} px · (${aoiStats.min.toFixed(1)}°C a ${aoiStats.max.toFixed(1)}°C)`
                        : lang === 'pt'
                          ? 'Polígono desenhado. Clique em Analisar AOI ou Concluir AOI.'
                          : 'Polygon drawn. Click Analyze AOI.'
                      : t.aoiHelp}
                  </p>
                  <div className="button-row">
                    <button className={drawAoi ? 'active' : ''} onClick={drawAoi ? finishAoi : toggleAoi}>
                      {drawAoi ? (lang === 'pt' ? '✓ Concluir AOI' : '✓ Finish AOI') : t.draw}
                    </button>
                    {aoi.length > 0 && (
                      <button onClick={clearAoi}>{t.clear}</button>
                    )}
                    <button disabled={aoi.length < 3} onClick={analyzeAoi}>{t.clip}</button>
                    <button disabled={aoi.length < 3} onClick={exportAoiPng}>AOI PNG</button>
                    <button disabled={aoi.length < 3} onClick={exportAoiTiff}>AOI GeoTIFF</button>
                  </div>
                </section>

                <section className="rail-card">
                  <div className="card-heading">
                    <h3>{t.export}</h3>
                  </div>
                  <div className="export-grid">
