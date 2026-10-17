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

const PALETTE_STOPS: Record<Exclude<PaletteType, 'custom' | 'uhi'>, string[]> = {
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
    report: 'Relatório rápido',
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
    report: 'Quick report',
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

function getPaletteStopList(palette: PaletteType, customColors: string[]): string[] {
  if (palette === 'custom') return customColors.length >= 2 ? customColors : DEFAULT_CUSTOM_COLORS;
  if (palette === 'uhi') return ['#103e8a', '#187a8c', '#3aae6c', '#bade76', '#f8d668', '#f47c30', '#d42026', '#fff4b8'];
  return PALETTE_STOPS[palette] || PALETTE_STOPS.ironbow;
}

function buildPaletteLut1024(palette: PaletteType, customColors: string[]): Uint8Array {
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

function sampleCssColorAt(t: number, palette: PaletteType, customColors: string[], isUhi: boolean): string {
  if (isUhi) {
    const z = -1.65 + Math.max(0, Math.min(1, t)) * 3.6;
    const [r, g, b] = sampleUhiColor(z);
    return `rgb(${Math.round(r)}, ${Math.round(g)},${Math.round(b)})`;
  }
  const stops = getPaletteStopList(palette, customColors).map(hexToRgbTuple);
  const maxSeg = stops.length - 1;
  const p = perceptualCoolExpansion(t) * maxSeg;
  const idx = Math.min(maxSeg - 1, Math.floor(p));
  const frac = p - idx;
  const [r0, g0, b0] = stops[idx];
  const [r1, g1, b1] = stops[idx + 1];
  return `rgb(${Math.round(r0 + (r1 - r0) * frac)}, ${Math.round(g0 + (g1 - g0) * frac)},${Math.round(b0 + (b1 - b0) * frac)})`;
}

function computeRasterStats(data: Float32Array): RasterStats | null {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let count = 0;
  const sample: number[] = [];
  const step = Math.max(1, Math.floor(data.length / 25000));

  for (let i = 0; i < data.length; i += 1) {
    const v = data[i];
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
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
  const q25 = sample[Math.floor(sample.length * 0.25)] ?? min;
  const q50 = sample[Math.floor(sample.length * 0.5)] ?? mean;
  const q75 = sample[Math.floor(sample.length * 0.75)] ?? max;

  return { min, max, mean, stdDev, q25, q50, q75 };
}

function renderPerceptualLstToCanvas(
  data: Float32Array,
  width: number,
  height: number,
  canvas: HTMLCanvasElement,
  palette: PaletteType,
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

/**
 * Transformação unificada de clustering UHI usada tanto pela imagem 1m (via LUT rápida)
 * quanto pelas Isotermas Vetoriais (para que os contornos mudem junto com o método e a potenciação).
 */
function computeClusteredZ(
  val: number,
  neighborMean: number,
  stats: RasterStats,
  method: UhiClusterMethod,
  power: number,
): number {
  const safeStd = Math.max(0.55, stats.stdDev);
  const iqr = Math.max(0.45, stats.q75 - stats.q25);
  const span = Math.max(0.8, stats.max - stats.min);

  let baseZ: number;
  if (method === 'quantiles') {
    // Quantis Adaptativos (IQR): expande o miolo urbano entre Q25 e Q75
    const diff = val - stats.q50;
    const asymScale = diff < 0 ? Math.max(0.3, stats.q50 - stats.q25) * 1.15 : Math.max(0.3, stats.q75 - stats.q50) * 1.05;
    baseZ = (diff / asymScale) * 0.72 + ((val - stats.mean) / iqr) * 0.28;
  } else if (method === 'natural') {
    // Quebras Naturais (Jenks-Otsu): S-Curve bimodal que separa vegetação, quadras e grandes telhados
    const norm = Math.max(0, Math.min(1, (val - stats.min) / span));
    const pivot = Math.max(0.25, Math.min(0.65, (stats.mean - stats.min) / span));
    const centered = (norm - pivot) * 3.4;
    baseZ = centered + 0.34 * Math.sin(centered * 1.85);
  } else if (method === 'kernel') {
    // Kernel Espacial (Gi* Hotspot): agrega vizinhança para destacar manchas térmicas contíguas
    const spatialVal = 0.35 * val + 0.65 * neighborMean;
    baseZ = ((spatialVal - stats.mean) / safeStd) * 1.24;
  } else {
    // Z-Score clássico
    baseZ = (val - stats.mean) / safeStd;
  }

  const sign = baseZ < 0 ? -1 : 1;
  return sign * Math.pow(Math.abs(baseZ), power);
}

/**
 * Pré-calcula uma LUT de 4096 níveis para o modo UHI:
 * Evita rodar Math.pow e Math.sin 17,2 milhões de vezes, tornando a troca de método instantânea!
 */
function buildUhiLut4096(
  stats: RasterStats,
  method: UhiClusterMethod,
  power: number,
): Uint8Array {
  const lut = new Uint8Array(4096 * 3);
  const span = Math.max(1e-5, stats.max - stats.min);

  for (let i = 0; i < 4096; i += 1) {
    const temp = stats.min + (i / 4095) * span;
    const z = computeClusteredZ(temp, temp, stats, method, power);
    const [r, g, b] = sampleUhiColor(z);
    lut[i * 3] = Math.max(0, Math.min(255, Math.round(r)));
    lut[i * 3 + 1] = Math.max(0, Math.min(255, Math.round(g)));
    lut[i * 3 + 2] = Math.max(0, Math.min(255, Math.round(b)));
  }
  return lut;
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

  const lut = buildUhiLut4096(stats, method, power);
  const minVal = stats.min;
  const invSpan = 4095 / Math.max(1e-5, stats.max - minVal);
  const invStdShade = 1 / Math.max(0.8, stats.stdDev);
  const isKernel = method === 'kernel';

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    const yPrev = (y > 0 ? y - 1 : 0) * width;
    const yNext = (y < height - 1 ? y + 1 : height - 1) * width;

    for (let x = 0; x < width; x += 1) {
      const i = row + x;
      const val = data[i];
      const px = i * 4;

      if (!Number.isFinite(val)) {
        out[px + 3] = 0;
        continue;
      }

      const xPrev = x > 0 ? x - 1 : 0;
      const xNext = x < width - 1 ? x + 1 : width - 1;

      const vE = data[row + xNext];
      const vW = data[row + xPrev];
      const vS = data[yNext + x];
      const vN = data[yPrev + x];

      const safeE = Number.isFinite(vE) ? vE : val;
      const safeW = Number.isFinite(vW) ? vW : val;
      const safeS = Number.isFinite(vS) ? vS : val;
      const safeN = Number.isFinite(vN) ? vN : val;

      const mean4 = 0.25 * (safeE + safeW + safeS + safeN);
      const effectiveTemp = isKernel ? 0.38 * val + 0.62 * mean4 : val;

      const lutIdx = Math.max(0, Math.min(4095, Math.round((effectiveTemp - minVal) * invSpan))) * 3;

      const slopeShade = (safeE - safeW - (safeS - safeN)) * 0.19 * invStdShade;
      const edgeLap = (val - mean4) * 0.36 * invStdShade;
      const relief = Math.max(-0.24, Math.min(0.24, slopeShade + edgeLap));
      const shadeMult = 1 + relief;

      out[px] = Math.max(0, Math.min(255, Math.round(lut[lutIdx] * shadeMult)));
      out[px + 1] = Math.max(0, Math.min(255, Math.round(lut[lutIdx + 1] * shadeMult)));
      out[px + 2] = Math.max(0, Math.min(255, Math.round(lut[lutIdx + 2] * shadeMult)));
      out[px + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
}

/**
 * Gera isotermas/clusters em meso-escala aplicando o MESMO método de clustering (zscore, quantiles, natural, kernel)
 * e a MESMA potenciação (power) sobre o campo agregado, para que os contornos se ajustem dinamicamente!
 */
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
  const gW = 108;
  const gH = Math.max(28, Math.round((height / Math.max(1, width)) * gW));
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

  let tempGrid = new Float32Array(gW * gH);
  for (let i = 0; i < tempGrid.length; i += 1) {
    tempGrid[i] = counts[i] > 0 ? rawGrid[i] / counts[i] : stats.mean;
  }

  // Número de passagens de suavização espacial varia conforme o método de clustering escolhido
  const smoothPasses = method === 'kernel' ? 5 : method === 'natural' ? 2 : 3;
  const kernel = [1, 2, 1, 2, 4, 2, 1, 2, 1];
  for (let pass = 0; pass < smoothPasses; pass += 1) {
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
            sum += tempGrid[ny * gW + nx] * kw;
            wSum += kw;
          }
        }
        next[y * gW + x] = sum / wSum;
      }
    }
    tempGrid = next;
  }

  // Converte a grade meso-escala de temperatura para o índice Z do método + potenciação selecionados
  const zGrid = new Float32Array(gW * gH);
  for (let y = 0; y < gH; y += 1) {
    for (let x = 0; x < gW; x += 1) {
      const idx = y * gW + x;
      const vC = tempGrid[idx];
      const vE = tempGrid[y * gW + Math.min(gW - 1, x + 1)];
      const vW = tempGrid[y * gW + Math.max(0, x - 1)];
      const vS = tempGrid[Math.min(gH - 1, y + 1) * gW + x];
      const vN = tempGrid[Math.max(0, y - 1) * gW + x];
      const neighMean = 0.25 * (vE + vW + vS + vN);
      zGrid[idx] = computeClusteredZ(vC, neighMean, stats, method, power);
    }
  }

  const levels = [
    { zCut: -0.95, label: 'Ilha de Frescor', color: '#38bdf8', kmlColor: 'fff8bd38' },
    { zCut: -0.35, label: 'Zona Amenizada', color: '#34d399', kmlColor: 'ff99d334' },
    { zCut: 0.20, label: 'Limiar UHI Leve', color: '#fde047', kmlColor: 'ff47e0fd' },
    { zCut: 0.75, label: 'Cluster UHI Forte', color: '#fb923c', kmlColor: 'ff3c92fb' },
    { zCut: 1.25, label: 'Hotspot Extremo', color: '#f43f5e', kmlColor: 'ff5e3ff4' },
  ];

  const toLng = (gx: number) => ext.west + ((gx + 0.5) / gW) * (ext.east - ext.west);
  const toLat = (gy: number) => ext.north - ((gy + 0.5) / gH) * (ext.north - ext.south);

  const features: IsothermFeature[] = [];

  levels.forEach((lvl, idx) => {
    const isoZ = lvl.zCut;
    const segments: [number, number][][] = [];
    let tempSum = 0;
    let tempCount = 0;

    for (let y = 0; y < gH - 1; y += 1) {
      for (let x = 0; x < gW - 1; x += 1) {
        const i0 = y * gW + x;
        const i1 = y * gW + (x + 1);
        const i2 = (y + 1) * gW + (x + 1);
        const i3 = (y + 1) * gW + x;

        const v0 = zGrid[i0];
        const v1 = zGrid[i1];
        const v2 = zGrid[i2];
        const v3 = zGrid[i3];

        const mask =
          (v0 >= isoZ ? 1 : 0) +
          (v1 >= isoZ ? 2 : 0) +
          (v2 >= isoZ ? 4 : 0) +
          (v3 >= isoZ ? 8 : 0);

        if (mask === 0 || mask === 15) continue;

        tempSum += 0.25 * (tempGrid[i0] + tempGrid[i1] + tempGrid[i2] + tempGrid[i3]);
        tempCount += 1;

        const interp = (a: number, b: number) => {
          const d = b - a;
          return Math.abs(d) < 1e-6 ? 0.5 : Math.max(0, Math.min(1, (isoZ - a) / d));
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
      const equivTemp = tempCount > 0 ? Number((tempSum / tempCount).toFixed(2)) : Number((stats.mean + isoZ * stats.stdDev).toFixed(2));
      features.push({
        type: 'Feature',
        properties: {
          level: idx + 1,
          tempCelsius: equivTemp,
          label: `${lvl.label} (${equivTemp.toFixed(1)}°C · ${method.toUpperCase()})`,
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
  onProgress?.(`Fusão concluída: ${result.model} ·${result.validCount} células coarse · coef. NDVI ${result.slope.toFixed(4)} · saída ${tiff.width.toLocaleString()}×${tiff.height.toLocaleString()} px · resolução ${resolutionLabel}`);
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

function renderDifferenceToCanvas(data: Float32Array, width: number, height: number, canvas: HTMLCanvasElement) {
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const image = ctx.createImageData(width, height);
  let min = Infinity;
  let max = -Infinity;
  let count = 0;
  for (const value of data) {
    if (Number.isFinite(value)) {
      min = Math.min(min, value);
      max = Math.max(max, value);
      count += 1;
    }
  }
  const maxAbs = Math.max(0.1, count ? Math.max(Math.abs(min), Math.abs(max)) : 0);
  const color = (value: number) => {
    const t = Math.min(1, Math.abs(value) / maxAbs);
    const start = value < 0 ? [33, 102, 172] : [255, 255, 255];
    const end = value < 0 ? [247, 247, 247] : [178, 24, 43];
    return {
      r: Math.round(start[0] + (end[0] - start[0]) * t),
      g: Math.round(start[1] + (end[1] - start[1]) * t),
      b: Math.round(start[2] + (end[2] - start[2]) * t),
    };
  };
  for (let i = 0; i < data.length; i += 1) {
    const value = data[i];
    const index = i * 4;
    if (!Number.isFinite(value)) {
      image.data[index + 3] = 0;
      continue;
    }
    const rgb = color(value);
    image.data[index] = rgb.r;
    image.data[index + 1] = rgb.g;
    image.data[index + 2] = rgb.b;
    image.data[index + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return { min: count ? min : 0, max: count ? max : 0, maxAbs };
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

function paletteGradient(palette: PaletteType, customColors: string[]) {
  const samplePoints = Array.from({ length: 13 }, (_, idx) => sampleCssColorAt(idx / 12, palette, customColors, false));
  return `linear-gradient(90deg, ${samplePoints.join(', ')})`;
}

function statsOf(data: Float32Array) {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let count = 0;
  for (const value of data) {
    if (Number.isFinite(value)) {
      min = Math.min(min, value);
      max = Math.max(max, value);
      sum += value;
      count += 1;
    }
  }
  return { min: count ? min : 0, max: count ? max : 0, mean: count ? sum / count : 0 };
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
  const [draftUhiPower, setDraftUhiPower] = useState(1.10);
  const [file, setFile] = useState<File | null>(null);
  const [bandCount, setBandCount] = useState(3);
  const [bandLabels, setBandLabels] = useState<string[]>([]);
  const [bands, setBands] = useState(['0', '1', '2']);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [processingLog, setProcessingLog] = useState<Array<{ time: string; message: string; level: 'info' | 'success' | 'error' }>>([]);
  const [sample, setSample] = useState<{ temp: number; lng: number; lat: number } | null>(null);
  const [hoverSample, setHoverSample] = useState<{ temp: number; lng: number; lat: number } | null>(null);
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
  const mapClickMode = useRef({
    drawAoi: false,
    raster: null as RasterState | null,
    extent: null as ReturnType<typeof boundsExtent> | null,
    identifyMode: false,
  });
  const lstCanvas = useRef<HTMLCanvasElement | null>(null);
  const opticalCanvas = useRef<HTMLCanvasElement | null>(null);

  const t = copy[lang];
  const extent = raster ? boundsExtent(raster.bounds) : null;
  const comparisonPrimary = comparisonImages[0] ?? null;
  const comparisonSecondary = comparisonImages[1] ?? null;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setCustomColors(draftCustomColors);
    }, 110);
    return () => window.clearTimeout(timer);
  }, [draftCustomColors]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setUhiPower(draftUhiPower);
    }, 90);
    return () => window.clearTimeout(timer);
  }, [draftUhiPower]);

  const differenceRender = useMemo(() => {
    if (!comparisonPrimary || !comparisonSecondary || !differenceReady) return null;
    const data = thermalDifference(comparisonPrimary, comparisonSecondary);
    const canvas = document.createElement('canvas');
    const stats = renderDifferenceToCanvas(data, comparisonPrimary.width, comparisonPrimary.height, canvas) ?? statsOf(data);
    return { url: canvas.toDataURL('image/png'), stats };
  }, [comparisonPrimary, comparisonSecondary, differenceReady]);

  const uhiGradient = 'linear-gradient(90deg, #103e8a, #187a8c, #3aae6c, #bade76, #f8d668, #f47c30, #d42026, #fff4b8)';
  const legendGradient = displayMode === 'uhi' ? uhiGradient : paletteGradient(palette, draftCustomColors);
  const differenceStats = differenceRender?.stats ?? null;
  const differenceExtent = differenceStats ? Math.max(Math.abs(differenceStats.min), Math.abs(differenceStats.max)) : 0;

  useEffect(() => {
    localStorage.setItem('lst-theme', theme);
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    mapClickMode.current = { drawAoi, raster, extent, identifyMode };
  }, [drawAoi, raster, extent, identifyMode]);

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
      if (!mode.raster || !mode.extent) return;
      const x = Math.floor(((event.lngLat.lng - mode.extent.west) / (mode.extent.east - mode.extent.west)) * mode.raster.width);
      const y = Math.floor(((mode.extent.north - event.lngLat.lat) / (mode.extent.north - mode.extent.south)) * mode.raster.height);
      if (x >= 0 && y >= 0 && x < mode.raster.width && y < mode.raster.height) {
        const temp = mode.raster.data[y * mode.raster.width + x];
        if (Number.isFinite(temp)) {
          const point = { temp, lng: event.lngLat.lng, lat: event.lngLat.lat };
          if (commit) setSample(point);
          else if (mapClickMode.current.identifyMode) setHoverSample(point);
        }
      }
    };

    map.on('click', (event) => {
      const mode = mapClickMode.current;
      if (mode.drawAoi) {
        event.preventDefault();
        setAoi((prev) => [...prev, [event.lngLat.lng, event.lngLat.lat]]);
        return;
      }
      inspectAt(event, true);
    });

    map.on('dblclick', (event) => {
      const mode = mapClickMode.current;
      if (!mode.drawAoi) return;
      event.preventDefault();
      setAoi((prev) => {
        const cleaned =
          prev.length > 1 &&
          Math.abs(prev[prev.length - 1][0] - event.lngLat.lng) < 1e-7 &&
          Math.abs(prev[prev.length - 1][1] - event.lngLat.lat) < 1e-7
            ? prev.slice(0, -1)
            : prev;
        if (cleaned.length >= 3) {
          setDrawAoi(false);
          setPanEnabled(true);
          map.dragPan.enable();
          map.doubleClickZoom.enable();
          map.scrollZoom.enable();
          map.touchZoomRotate.enable();
        }
        return cleaned;
      });
    });

    let hoverFrame = 0;
    map.on('mousemove', (event) => {
      if (!mapClickMode.current.drawAoi && mapClickMode.current.identifyMode && !hoverFrame) {
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

  const syncLayers = useCallback(() => {
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
      if (!map.getLayer('lst-layer')) {
        map.addLayer({ id: 'lst-layer', type: 'raster', source: 'lst-raster', paint: { 'raster-opacity': opacity, 'raster-contrast': contrast } });
      }
      if (!map.getLayer('optical-layer')) {
        map.addLayer({ id: 'optical-layer', type: 'raster', source: 'optical-raster', paint: { 'raster-opacity': 1 } });
      }
    }
    if (comparisonPrimary && comparisonSecondary && differenceReady) {
      addOrUpdate('comparison-primary-raster', comparisonPrimary.lstUrl, comparisonPrimary.bounds);
      addOrUpdate('comparison-lst-raster', comparisonSecondary.lstUrl, comparisonSecondary.bounds);
      if (!map.getLayer('comparison-primary-layer')) {
        map.addLayer({ id: 'comparison-primary-layer', type: 'raster', source: 'comparison-primary-raster', paint: { 'raster-opacity': 1 } });
      }
      if (!map.getLayer('comparison-lst-layer')) {
        map.addLayer({ id: 'comparison-lst-layer', type: 'raster', source: 'comparison-lst-raster', paint: { 'raster-opacity': 0.5 } });
      }
      if (differenceRender) addOrUpdate('comparison-difference-raster', differenceRender.url, comparisonPrimary.bounds);
      if (!map.getLayer('comparison-difference-layer')) {
        map.addLayer({ id: 'comparison-difference-layer', type: 'raster', source: 'comparison-difference-raster', paint: { 'raster-opacity': 0.9 } });
      }
      map.setLayoutProperty('comparison-primary-layer', 'visibility', swipeActive ? 'visible' : 'none');
      map.setLayoutProperty('comparison-lst-layer', 'visibility', !swipeActive && comparisonMode === 'secondary' ? 'visible' : 'none');
      map.setPaintProperty('comparison-lst-layer', 'raster-opacity', 0.9);
      map.setLayoutProperty('comparison-difference-layer', 'visibility', comparisonMode === 'difference' && !swipeActive ? 'visible' : 'none');
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
    const aoiSource = map.getSource('aoi-source') as any;
    if (aoi.length >= 2) {
      const coordinates = aoi.length >= 3 ? [...aoi, aoi[0]] : aoi;
      const geometry = aoi.length >= 3 ? { type: 'Polygon', coordinates: [coordinates] } : { type: 'LineString', coordinates };
      if (aoiSource) {
        aoiSource.setData({ type: 'Feature', geometry, properties: {} });
      } else {
        map.addSource('aoi-source', { type: 'geojson', data: { type: 'Feature', geometry, properties: {} } });
        map.addLayer({ id: 'aoi-fill', type: 'fill', source: 'aoi-source', filter: ['==', '$type', 'Polygon'], paint: { 'fill-color': '#ffb000', 'fill-opacity': 0.18 } });
        map.addLayer({ id: 'aoi-line', type: 'line', source: 'aoi-source', paint: { 'line-color': '#ffb000', 'line-width': 3, 'line-dasharray': [2, 1] } });
      }
    } else if (aoiSource) {
      aoiSource.setData({ type: 'FeatureCollection', features: [] });
    }
  }, [aoi, comparisonMode, comparisonPrimary, comparisonSecondary, contrast, differenceReady, differenceRender, lstUrl, opacity, opticalUrl, raster, swipeActive, visibleLst, visibleOptical]);

  useEffect(() => {
    const container = curtainContainerRef.current;
    const main = mapInstance.current;
    if (!container || !main || !swipeActive || !comparisonSecondary || !differenceReady) {
      curtainMapRef.current?.remove();
      curtainMapRef.current = null;
      return;
    }
    const curtainMap = new maplibregl.Map({
      container,
      style: { version: 8, sources: {}, layers: [] },
      center: main.getCenter(),
      zoom: main.getZoom(),
      bearing: main.getBearing(),
      pitch: main.getPitch(),
      interactive: false,
      attributionControl: false,
    });
    const syncCamera = () => curtainMap.jumpTo({ center: main.getCenter(), zoom: main.getZoom(), bearing: main.getBearing(), pitch: main.getPitch() });
    const addCurtainLayer = () => {
      curtainMap.addSource('curtain-secondary-raster', { type: 'image', url: comparisonSecondary.lstUrl, coordinates: comparisonSecondary.bounds });
      curtainMap.addLayer({ id: 'curtain-secondary-layer', type: 'raster', source: 'curtain-secondary-raster', paint: { 'raster-opacity': 1 } });
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

  useEffect(() => {
    const map = mapInstance.current;
    if (!map) return;
    const locked = drawAoi || identifyMode;
    if (locked) {
      map.dragPan.disable();
      map.scrollZoom.disable();
      map.boxZoom.disable();
      map.doubleClickZoom.disable();
      map.dragRotate.disable();
      map.keyboard.disable();
      map.touchZoomRotate.disable();
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
    if (map.isStyleLoaded()) syncLayers();
    else map.once('load', syncLayers);
    return () => {
      map.off('load', syncLayers);
    };
  }, [lstUrl, opticalUrl, raster, differenceReady, syncLayers]);

  useEffect(() => {
    const viewExtent = extent ?? (comparisonPrimary ? boundsExtent(comparisonPrimary.bounds) : null);
    if (mapInstance.current && viewExtent) {
      mapInstance.current.fitBounds(
        [[viewExtent.west, viewExtent.south], [viewExtent.east, viewExtent.north]],
        { padding: 70, duration: 850, maxZoom: 16 },
      );
    }
  }, [comparisonPrimary, extent, raster]);

  useEffect(() => {
    const map = mapInstance.current;
    if (!map || !map.isStyleLoaded()) return;
    const source = map.getSource('aoi-source') as maplibregl.GeoJSONSource | undefined;
    const coordinates = aoi.length >= 3 ? [...aoi, aoi[0]] : aoi.length ? [...aoi, aoi[0]] : [];
    const data = {
      type: 'FeatureCollection' as const,
      features: coordinates.length
        ? [{ type: 'Feature' as const, properties: {}, geometry: { type: 'Polygon' as const, coordinates: [coordinates] } }]
        : [],
    };
    if (source) {
      source.setData(data);
    } else {
      map.addSource('aoi-source', { type: 'geojson', data });
      map.addLayer({ id: 'aoi-fill', type: 'fill', source: 'aoi-source', paint: { 'fill-color': '#ffb000', 'fill-opacity': 0.15 } });
      map.addLayer({ id: 'aoi-line', type: 'line', source: 'aoi-source', paint: { 'line-color': '#ffb000', 'line-width': 3, 'line-dasharray': [2, 1] } });
    }
  }, [aoi]);

  // Calcula a grade UHI bruta apenas 1 vez quando o raster muda (evita lentidão ao trocar o método)
  useEffect(() => {
    if (raster) {
      setUhiSurface(buildUhiSurface({ data: raster.data, width: raster.width, height: raster.height, bounds: raster.bounds, mean: raster.stats.mean, stdDev: raster.stats.stdDev }));
    } else {
      setUhiSurface(null);
    }
  }, [raster]);

  // Atualiza as isotermas/clusters dinamicamente junto com o método e a potenciação
  useEffect(() => {
    if (raster) {
      setIsotherms(buildMesoIsothermsGeoJSON(raster.data, raster.width, raster.height, raster.bounds, raster.stats, uhiMethod, uhiPower));
    } else {
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
          paint: { 'line-color': ['get', 'color'], 'line-opacity': 0.96, 'line-width': 2.1 },
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
    const output = document.createElement('canvas');
    output.width = win.width;
    output.height = win.height + 200;
    const ctx = output.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(opticalCanvas.current, win.x0, win.y0, win.width, win.height, 0, 0, win.width, win.height);
    ctx.globalAlpha = opacity;
    ctx.drawImage(lstCanvas.current, win.x0, win.y0, win.width, win.height, 0, 0, win.width, win.height);
    ctx.globalAlpha = 1;
    drawLegend(ctx, 16, win.height + 10);
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
      link.download = `SR2D4-Isotermas-${uhiMethod}.geojson`;
      link.click();
      URL.revokeObjectURL(link.href);
    } else {
      const placemarks = isotherms.features
        .map((f) => {
          const linesXml = f.geometry.coordinates
            .map((seg) => `<LineString><coordinates>${seg.map((c) => `${c[0]},${c[1]},0`).join(' ')}</coordinates></LineString>`)
            .join('');
          return `<Placemark><name>${f.properties.label}</name><description>Isoterma Meso-escala (${uhiMethod.toUpperCase()}):${f.properties.tempCelsius}°C</description><Style><LineStyle><color>${f.properties.kmlColor}</color><width>2.5</width></LineStyle></Style><MultiGeometry>${linesXml}</MultiGeometry></Placemark>`;
        })
        .join('');
      const kml = `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>SR2D4 Isotermas e Clusters (${uhiMethod.toUpperCase()})</name>${placemarks}</Document></kml>`;
      const blob = new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `SR2D4-Isotermas-${uhiMethod}.kml`;
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
        fileName: `${selectedFile.name} ·${automatic.landsat.itemId}`,
        bands: automatic.tiff.rasters.length,
      };
      lstCanvas.current = lst;
      opticalCanvas.current = optical;
      setRaster(next);
      setAoi([]);
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

    const peak = Math.max(...bins, 1);
    return bins.map((count, i) => {
      const tNorm = (i + 0.5) / numBins;
      const tempStart = raster.stats.min + (span * i) / numBins;
      const tempEnd = raster.stats.min + (span * (i + 1)) / numBins;
      const pct = total > 0 ? ((count / total) * 100).toFixed(1) : '0.0';
      const midTemp = (tempStart + tempEnd) * 0.5;
      const barColor =
        displayMode === 'uhi'
          ? (() => {
              const z = computeClusteredZ(midTemp, midTemp, raster.stats, uhiMethod, draftUhiPower);
              const [r, g, b] = sampleUhiColor(z);
              return `rgb(${Math.round(r)}, ${Math.round(g)},${Math.round(b)})`;
            })()
          : sampleCssColorAt(tNorm, palette, draftCustomColors, false);

      return {
        count,
        pct,
        height: Math.max(6, Math.pow(count / peak, 0.78) * 100),
        tempLabel: `${tempStart.toFixed(1)}°C – ${tempEnd.toFixed(1)}°C (${pct}%)`,
        shortLabel: `${midTemp.toFixed(0)}°`,
        color: barColor,
      };
    });
  }, [displayMode, draftCustomColors, draftUhiPower, palette, raster, uhiMethod]);

  const legendStops = (selected: PaletteType) => getPaletteStopList(selected, draftCustomColors);

  const drawDifferenceLegend = (ctx: CanvasRenderingContext2D, x: number, y: number, width: number, stats: { min: number; max: number }) => {
    const height = 132;
    const extVal = Math.max(Math.abs(stats.min), Math.abs(stats.max));
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x, y, width, height);
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, width, height);
    ctx.fillStyle = '#202428';
    ctx.font = '700 22px Arial';
    ctx.fillText('DIFERENÇA (DATA 2 − DATA 1) · °C', x + 18, y + 30);
    const gradient = ctx.createLinearGradient(x + 18, y + 62, x + width - 18, y + 62);
    gradient.addColorStop(0, '#2166ac');
    gradient.addColorStop(0.5, '#f7f7f7');
    gradient.addColorStop(1, '#b2182b');
    ctx.fillStyle = gradient;
    ctx.fillRect(x + 18, y + 48, width - 36, 22);
    ctx.strokeStyle = '#777';
    ctx.strokeRect(x + 18, y + 48, width - 36, 22);
    ctx.fillStyle = '#2166ac';
    ctx.font = '600 16px Arial';
    ctx.fillText(`-${extVal.toFixed(1)} °C · resfriamento`, x + 18, y + 96);
    ctx.fillStyle = '#555';
    ctx.textAlign = 'center';
    ctx.fillText('0 °C · estável', x + width / 2, y + 96);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#b2182b';
    ctx.fillText(`+${extVal.toFixed(1)} °C · aquecimento`, x + width - 18, y + 96);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#202428';
    ctx.font = '14px Arial';
    ctx.fillText('Valores positivos: a imagem 2 está mais quente. Valores negativos: a imagem 2 está mais fria.', x + 18, y + 119);
  };

  const drawLegend = (ctx: CanvasRenderingContext2D, x: number, y: number) => {
    const height = 180;
    const width = Math.min(760, Math.max(360, ctx.canvas.width - x - 24));
    const pad = 26;
    ctx.fillStyle = 'rgba(7,19,23,.96)';
    ctx.fillRect(x, y, width, height);
    ctx.strokeStyle = 'rgba(121,226,220,.7)';
    ctx.lineWidth = 3;
    ctx.strokeRect(x, y, width, height);
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 29px Arial';
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
        ctx.font = '600 18px Arial';
        ctx.fillText(label, itemX + 30, y + 85);
      });
      ctx.fillStyle = '#b7c9cb';
      ctx.font = '16px Arial';
      ctx.fillText(`Método: ${uhiMethod.toUpperCase()} · Potenciação γ=${uhiPower.toFixed(2)}`, x + pad, y + 139);
    } else {
      const gradient = ctx.createLinearGradient(x + pad, y + 84, x + width - pad, y + 84);
      for (let s = 0; s <= 16; s += 1) {
        gradient.addColorStop(s / 16, sampleCssColorAt(s / 16, palette, draftCustomColors, false));
      }
      ctx.fillStyle = gradient;
      ctx.fillRect(x + pad, y + 67, width - pad * 2, 38);
      ctx.strokeStyle = 'rgba(255,255,255,.7)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + pad, y + 67, width - pad * 2, 38);
      ctx.fillStyle = '#ffffff';
      ctx.font = '600 20px Arial';
      ctx.fillText(`${raster?.stats.min.toFixed(1) ?? '—'} °C`, x + pad, y + 139);
      ctx.textAlign = 'right';
      ctx.fillText(`${raster?.stats.max.toFixed(1) ?? '—'} °C`, x + width - pad, y + 139);
      ctx.textAlign = 'left';
      ctx.fillStyle = '#b7c9cb';
      ctx.font = '16px Arial';
      ctx.fillText(`Paleta: ${palette === 'custom' ? 'Custom' : palette}`, x + pad, y + 164);
    }
  };

  const exportPng = () => {
    if (!lstCanvas.current || !opticalCanvas.current) return;
    const canvas = document.createElement('canvas');
    canvas.width = lstCanvas.current.width;
    canvas.height = lstCanvas.current.height + 200;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#071317';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(opticalCanvas.current, 0, 0);
    ctx.globalAlpha = opacity;
    ctx.drawImage(lstCanvas.current, 0, 0);
    ctx.globalAlpha = 1;
    drawLegend(ctx, 16, canvas.height - 190);
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = `SR2D4-${displayMode
