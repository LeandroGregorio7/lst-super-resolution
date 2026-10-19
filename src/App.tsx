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
type AoiShapeMode = 'rectangle' | 'square' | 'circle' | 'polygon';
type SearchResult = { display_name: string; lat: string; lon: string };
type RasterStats = { min: number; max: number; mean: number; stdDev: number; q25: number; q50: number; q75: number };
type DifferenceStats = {
  min: number; max: number; mean: number; stdDev: number;
  thresholdSigma: number; maxScale: number;
  pctDecreased: number; pctEqual: number; pctIncreased: number;
};
type InspectPoint = {
  temp: number; lng: number; lat: number;
  beforeTemp?: number; afterTemp?: number; diffTemp?: number;
};
type AoiDetailedStats = {
  shapeMode: AoiShapeMode;
  vertices: [number, number][];
  count: number;
  areaM2: number;
  areaHa: number;
  min: number;
  max: number;
  mean: number;
  stdDev: number;
  q25: number;
  q50: number;
  q75: number;
  ndviMean: number;
  ndbiMean: number;
  vegPct: number;
  builtPct: number;
  uhiCounts: number[];
  uhiPcts: number[];
  previewDataUrl: string;
  clipWidth: number;
  clipHeight: number;
  clippedFloat32: Float32Array;
  clipOrigin: number[];
};
type OsmFeatureStat = {
  id: string;
  name: string;
  kind: 'Bairro' | 'Via';
  highway?: string;
  meanTemp: number;
  medianTemp: number;
  maxTemp: number;
  ndvi: number;
  ndbi: number;
  hotPct: number;
  samples: number;
};
type RasterState = {
  data: Float32Array; width: number; height: number; bounds: RasterBounds;
  origin: number[]; resolution: number[]; epsg: number; isProjected: boolean;
  stats: RasterStats; ndvi: Float32Array; ndbi: Float32Array; fileName: string; bands: number;
};
type ComparisonImage = {
  id: string; name: string; dateLabel: string; lstUrl: string; opticalUrl: string;
  uhiSurface: UhiSurface; bounds: RasterBounds; width: number; height: number;
  data: Float32Array; stats: RasterStats;
};
type IsothermFeature = {
  type: 'Feature';
  properties: { level: number; tempCelsius: number; label: string; color: string; kmlColor: string };
  geometry: { type: 'MultiLineString'; coordinates: [number, number][][] };
};
type IsothermCollection = { type: 'FeatureCollection'; features: IsothermFeature[] };

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
  [-1.65, 16, 62, 138], [-1.05, 24, 122, 140], [-0.45, 58, 174, 108], [0.05, 186, 222, 118],
  [0.50, 248, 214, 104], [0.95, 244, 124, 48], [1.40, 212, 32, 38], [1.95, 255, 244, 184],
];
const DIFFERENCE_GRADIENT_CSS =
  'linear-gradient(90deg, #023e8a 0%, #0096c7 22%, #48cae4 36%, #45525a 37%, #526069 63%, #f77f00 64%, #d62828 84%, #ffea00 100%)';

const copy = {
  pt: {
    eyebrow: 'OPEN SOURCE • WEB GIS • v3.0', title: 'SR2D4 / LST Explorer',
    subtitle: 'Laboratório térmico no navegador para transformar GeoTIFFs multiespectrais em evidência espacial.',
    colab: 'Abrir Colab', upload: 'Carregar produto SR2D4/MS', uploadHint: 'GeoTIFF local • nada é enviado para um servidor',
    bands: 'Bandas ópticas do SR2D4', red: 'Vermelho (Red)', nir: 'Infravermelho próximo (NIR)', swir: 'Infravermelho de ondas curtas (SWIR)',
    calculate: 'Calcular mapa térmico', processing: 'Processando raster…', layers: 'Camadas', lst: 'LST / temperatura',
    optical: 'Imagem óptica', opacity: 'Transparência', contrast: 'Contraste', palette: 'Paleta', stats: 'Resumo estatístico',
    min: 'mínima', max: 'máxima', mean: 'média', std: 'desvio', histogram: 'Histograma de Cores & Temperatura',
    sample: 'Escala Térmica & Inspeção', aoi: 'Área de interesse (AOI)', draw: 'Desenhar AOI', clear: 'Limpar AOI', clip: 'Analisar AOI (Pop-up)',
    export: 'Exportar', png: 'PNG composto', tiff: 'GeoTIFF LST', uhi: 'GeoTIFF UHI', method: 'Metodologia', help: 'Como usar',
    metadata: 'Metadados', theme: 'Tema', basemap: 'Mapa-base', ready: 'Pronto',
    error: 'Não foi possível processar. Carregue um GeoTIFF SR2D4 com Red, NIR e SWIR; o Landsat térmico é buscado automaticamente.',
    methodText: 'O app extrai a data AAAAMMDD do nome do SR2D4, busca automaticamente a cena Landsat 8/9 Collection 2 Level-2 mais próxima, mascara nuvens com QA_PIXEL, decodifica ST_B10 e executa fusão física TsHARP HD 1m guiada por reflectância e índices ópticos.',
    helpText: '1. Gere o produto MS no Colab com AAAAMMDD e _MS.tif. 2. Carregue o GeoTIFF SR2D4. 3. Confirme Red/NIR/SWIR. 4. Escolha a forma da AOI (Retângulo, Quadrado, Círculo ou Polígono) ou exporte o Relatório Técnico Expandido.',
    noData: 'Carregue um GeoTIFF para começar', search: 'Buscar cidade, bairro ou lugar', coords: 'Longitude, latitude',
    locate: 'Minha localização', go: 'Ir', compare: 'Comparar antes/depois', indices: 'Índices espectrais',
    ndvi: 'NDVI vegetação', ndbi: 'NDBI construído', report: 'Relatório Expandido (PT/EN)', resize: 'Arraste para redimensionar o painel',
    searchError: 'Local não encontrado.', uhiText: 'Níveis UHI (1m): Frescor, Amenizado, Neutro, Moderada, Forte e Extrema.',
    aoiHelp: 'Escolha Retângulo, Quadrado, Círculo ou Polígono abaixo, desenhe no mapa e veja o diagnóstico em Pop-up.',
    limitation: 'Limitações da super-resolução',
    limitationText: 'A LST detalhada é uma estimativa guiada por índices ópticos e reflectância de 1m. Use-a para investigação espacial e comparação.',
  },
  en: {
    eyebrow: 'OPEN SOURCE • WEB GIS • v3.0', title: 'SR2D4 / LST Explorer',
    subtitle: 'A browser-based thermal lab for turning multispectral GeoTIFFs into spatial evidence.',
    colab: 'Open Colab', upload: 'Load SR2D4/MS product', uploadHint: 'Local GeoTIFF • nothing is uploaded to a server',
    bands: 'SR2D4 optical bands', red: 'Red', nir: 'Near infrared (NIR)', swir: 'Short-wave infrared (SWIR)',
    calculate: 'Calculate thermal map', processing: 'Processing raster…', layers: 'Layers', lst: 'LST / temperature',
    optical: 'Optical image', opacity: 'Opacity', contrast: 'Contrast', palette: 'Palette', stats: 'Statistics',
    min: 'minimum', max: 'maximum', mean: 'mean', std: 'std dev', histogram: 'Color & Temperature Histogram',
    sample: 'Thermal Scale & Inspection', aoi: 'Area of interest (AOI)', draw: 'Draw AOI', clear: 'Clear AOI', clip: 'Analyze AOI (Pop-up)',
    export: 'Export', png: 'Composite PNG', tiff: 'LST GeoTIFF', uhi: 'UHI GeoTIFF', method: 'Methodology', help: 'How it works',
    metadata: 'Metadata', theme: 'Theme', basemap: 'Basemap', ready: 'Ready',
    error: 'Processing failed. Load an SR2D4 GeoTIFF with Red, NIR and SWIR; thermal Landsat is fetched automatically.',
    methodText: 'The workflow combines SR2D4 imagery with optical indices and TsHARP regression to estimate 1m spatial LST.',
    helpText: '1. Generate the MS product in Colab. 2. Load the GeoTIFF. 3. Confirm Red/NIR/SWIR. 4. Draw AOI shapes or export the Expanded Report.',
    noData: 'Load a GeoTIFF to begin', search: 'Search city, neighborhood or place', coords: 'Longitude, latitude',
    locate: 'My location', go: 'Go', compare: 'Compare before/after', indices: 'Spectral indices',
    ndvi: 'NDVI vegetation', ndbi: 'NDBI built-up', report: 'Expanded Report (PT/EN)', resize: 'Drag to resize the panel',
    searchError: 'Place not found.', uhiText: 'UHI levels (1m): Cool island, Mitigated, Neutral, Moderate, Strong and Extreme.',
    aoiHelp: 'Select Rectangle, Square, Circle or Polygon below, draw on map and open the Pop-up analysis.',
    limitation: 'Super-resolution limitations',
    limitationText: 'Detailed LST is an optical-guided estimate. Validate results with field data.',
  },
} as const;

function hexToRgbTuple(hex: string): [number, number, number] {
  const clean = hex.replace('#', '').trim();
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const num = Number.parseInt(full, 16);
  return Number.isNaN(num) ? [128, 128, 128] : [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}
function perceptualCoolExpansion(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c < 0.56 ? 0.58 * Math.pow(c / 0.56, 0.72) : 0.58 + 0.42 * Math.pow((c - 0.56) / 0.44, 1.08);
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
    const pos = perceptualCoolExpansion(i / 1023) * maxSeg;
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
  if (z <= UHI_STOPS[0][0]) return [UHI_STOPS[0][1], UHI_STOPS[0][2], UHI_STOPS[0][3]];
  for (let s = 0; s < UHI_STOPS.length - 1; s += 1) {
    const [z0, r0, g0, b0] = UHI_STOPS[s];
    const [z1, r1, g1, b1] = UHI_STOPS[s + 1];
    if (z <= z1) {
      const t = Math.max(0, Math.min(1, (z - z0) / (z1 - z0)));
      const ts = 0.72 * t + 0.28 * (Math.round(t * 2) / 2);
      return [r0 + (r1 - r0) * ts, g0 + (g1 - g0) * ts, b0 + (b1 - b0) * ts];
    }
  }
  const last = UHI_STOPS[UHI_STOPS.length - 1];
  return [last[1], last[2], last[3]];
}
function sampleCssColorAt(t: number, palette: string, customColors: string[], isUhi: boolean): string {
  if (isUhi) {
    const [r, g, b] = sampleUhiColor(-1.65 + Math.max(0, Math.min(1, t)) * 3.6);
    return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
  }
  const stops = getPaletteStopList(palette, customColors).map(hexToRgbTuple);
  const maxSeg = stops.length - 1;
  const p = perceptualCoolExpansion(t) * maxSeg;
  const idx = Math.min(maxSeg - 1, Math.floor(p));
  const f = p - idx;
  const [r0, g0, b0] = stops[idx];
  const [r1, g1, b1] = stops[idx + 1];
  return `rgb(${Math.round(r0 + (r1 - r0) * f)}, ${Math.round(g0 + (g1 - g0) * f)}, ${Math.round(b0 + (b1 - b0) * f)})`;
}
function computeRasterStats(data: Float32Array): RasterStats | null {
  let min = Infinity; let max = -Infinity; let sum = 0; let count = 0;
  const sample: number[] = [];
  const step = Math.max(1, Math.floor(data.length / 25000));
  for (let i = 0; i < data.length; i += 1) {
    const v = data[i];
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v; count += 1;
    if (i % step === 0) sample.push(v);
  }
  if (!count) return null;
  const mean = sum / count;
  let sq = 0;
  for (let i = 0; i < sample.length; i += 1) sq += (sample[i] - mean) ** 2;
  const stdDev = sample.length > 1 ? Math.sqrt(sq / sample.length) : 1;
  sample.sort((a, b) => a - b);
  return {
    min, max, mean, stdDev,
    q25: sample[Math.floor(sample.length * 0.25)] ?? min,
    q50: sample[Math.floor(sample.length * 0.5)] ?? mean,
    q75: sample[Math.floor(sample.length * 0.75)] ?? max,
  };
}
function renderPerceptualLstToCanvas(
  data: Float32Array, width: number, height: number, canvas: HTMLCanvasElement,
  palette: string, customColors: string[], existingStats?: RasterStats,
): RasterStats | null {
  const stats = existingStats ?? computeRasterStats(data);
  if (!stats) return null;
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return stats;
  const img = ctx.createImageData(width, height);
  const out = img.data;
  const lut = buildPaletteLut1024(palette, customColors);
  const invSpan = 1023 / Math.max(1e-5, stats.max - stats.min);
  for (let i = 0; i < data.length; i += 1) {
    const v = data[i];
    const px = i * 4;
    if (!Number.isFinite(v)) { out[px + 3] = 0; continue; }
    const k = Math.max(0, Math.min(1023, Math.round((v - stats.min) * invSpan))) * 3;
    out[px] = lut[k]; out[px + 1] = lut[k + 1]; out[px + 2] = lut[k + 2]; out[px + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return stats;
}
function computeClusteredZ(val: number, neighborMean: number, stats: RasterStats, method: UhiClusterMethod, power: number): number {
  const safeStd = Math.max(0.6, stats.stdDev);
  const iqr = Math.max(0.5, stats.q75 - stats.q25);
  const centered = ((val - stats.min) / Math.max(0.5, stats.max - stats.min) - 0.46) * 3.3;
  const baseZ = method === 'quantiles'
    ? ((val - stats.q50) / (iqr * 0.68)) * 0.92
    : method === 'natural'
      ? centered + 0.18 * Math.sin(centered * Math.PI)
      : method === 'kernel'
        ? (((0.42 * val + 0.58 * neighborMean) - stats.mean) / safeStd) * 1.15
        : (val - stats.mean) / safeStd;
  return (baseZ < 0 ? -1 : 1) * Math.pow(Math.abs(baseZ), power);
}
function renderHighDefUhiToCanvas(
  data: Float32Array, width: number, height: number, canvas: HTMLCanvasElement,
  stats: RasterStats, method: UhiClusterMethod, power: number,
) {
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const img = ctx.createImageData(width, height);
  const out = img.data;
  const safeStd = Math.max(0.8, stats.stdDev);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    const yP = Math.max(0, y - 1) * width; const yN = Math.min(height - 1, y + 1) * width;
    const yFP = Math.max(0, y - 3) * width; const yFN = Math.min(height - 1, y + 3) * width;
    for (let x = 0; x < width; x += 1) {
      const i = row + x; const val = data[i]; const px = i * 4;
      if (!Number.isFinite(val)) { out[px + 3] = 0; continue; }
      const xP = Math.max(0, x - 1); const xN = Math.min(width - 1, x + 1);
      const xFP = Math.max(0, x - 3); const xFN = Math.min(width - 1, x + 3);
      const vE = Number.isFinite(data[row + xN]) ? data[row + xN] : val;
      const vW = Number.isFinite(data[row + xP]) ? data[row + xP] : val;
      const vS = Number.isFinite(data[yN + x]) ? data[yN + x] : val;
      const vN = Number.isFinite(data[yP + x]) ? data[yP + x] : val;
      const vFE = Number.isFinite(data[row + xFN]) ? data[row + xFN] : val;
      const vFW = Number.isFinite(data[row + xFP]) ? data[row + xFP] : val;
      const vFS = Number.isFinite(data[yFN + x]) ? data[yFN + x] : val;
      const vFN = Number.isFinite(data[yFP + x]) ? data[yFP + x] : val;
      const z = computeClusteredZ(val, 0.125 * (vE + vW + vS + vN + vFE + vFW + vFS + vFN), stats, method, power);
      const relief = Math.max(-0.24, Math.min(0.24, (((vE - vW) * 0.7 - (vS - vN) * 0.7) * 0.28 + (val - 0.25 * (vE + vW + vS + vN)) * 0.38) / safeStd));
      const [r, g, b] = sampleUhiColor(z);
      const m = 1 + relief;
      out[px] = Math.max(0, Math.min(255, Math.round(r * m)));
      out[px + 1] = Math.max(0, Math.min(255, Math.round(g * m)));
      out[px + 2] = Math.max(0, Math.min(255, Math.round(b * m)));
      out[px + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}
function buildMesoIsothermsGeoJSON(
  data: Float32Array, width: number, height: number, bounds: RasterBounds,
  stats: RasterStats, method: UhiClusterMethod, power: number,
): IsothermCollection {
  const ext = boundsExtent(bounds);
  const gW = 96; const gH = Math.max(24, Math.round((height / Math.max(1, width)) * gW));
  const rawGrid = new Float32Array(gW * gH); const counts = new Uint32Array(gW * gH);
  for (let y = 0; y < height; y += 2) {
    const gy = Math.min(gH - 1, Math.floor((y / height) * gH));
    const row = y * width;
    for (let x = 0; x < width; x += 2) {
      const v = data[row + x];
      if (!Number.isFinite(v)) continue;
      const idx = gy * gW + Math.min(gW - 1, Math.floor((x / width) * gW));
      rawGrid[idx] += v; counts[idx] += 1;
    }
  }
  let grid = new Float32Array(gW * gH);
  for (let i = 0; i < grid.length; i += 1) grid[i] = counts[i] > 0 ? rawGrid[i] / counts[i] : stats.mean;
  const kernel = [1, 2, 1, 2, 4, 2, 1, 2, 1];
  for (let pass = 0; pass < (method === 'kernel' ? 4 : 3); pass += 1) {
    const next = new Float32Array(gW * gH);
    for (let y = 0; y < gH; y += 1) {
      for (let x = 0; x < gW; x += 1) {
        let s = 0; let w = 0;
        for (let ky = -1; ky <= 1; ky += 1) {
          for (let kx = -1; kx <= 1; kx += 1) {
            const kw = kernel[(ky + 1) * 3 + (kx + 1)];
            s += grid[Math.max(0, Math.min(gH - 1, y + ky)) * gW + Math.max(0, Math.min(gW - 1, x + kx))] * kw;
            w += kw;
          }
        }
        next[y * gW + x] = s / w;
      }
    }
    grid = next;
  }
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
  const scaleRef = method === 'quantiles' ? Math.max(0.6, (stats.q75 - stats.q25) * 0.75) : Math.max(0.8, stats.stdDev);
  const toLng = (gx: number) => ext.west + ((gx + 0.5) / gW) * (ext.east - ext.west);
  const toLat = (gy: number) => ext.north - ((gy + 0.5) / gH) * (ext.north - ext.south);
  const features: IsothermFeature[] = [];
  labels.forEach((lvl, idx) => {
    const rz = baseZ[idx];
    const iso = Number((centerRef + (rz < 0 ? -1 : 1) * Math.pow(Math.abs(rz), invPower) * scaleRef).toFixed(2));
    const segments: [number, number][][] = [];
    for (let y = 0; y < gH - 1; y += 1) {
      for (let x = 0; x < gW - 1; x += 1) {
        const v0 = grid[y * gW + x]; const v1 = grid[y * gW + x + 1];
        const v2 = grid[(y + 1) * gW + x + 1]; const v3 = grid[(y + 1) * gW + x];
        const mask = (v0 >= iso ? 1 : 0) + (v1 >= iso ? 2 : 0) + (v2 >= iso ? 4 : 0) + (v3 >= iso ? 8 : 0);
        if (mask === 0 || mask === 15) continue;
        const ip = (a: number, b: number) => (Math.abs(b - a) < 1e-6 ? 0.5 : Math.max(0, Math.min(1, (iso - a) / (b - a))));
        const top: [number, number] = [toLng(x + ip(v0, v1)), toLat(y)];
        const right: [number, number] = [toLng(x + 1), toLat(y + ip(v1, v2))];
        const bottom: [number, number] = [toLng(x + ip(v3, v2)), toLat(y + 1)];
        const left: [number, number] = [toLng(x), toLat(y + ip(v0, v3))];
        if (mask === 1 || mask === 14) segments.push([left, top]);
        else if (mask === 2 || mask === 13) segments.push([top, right]);
        else if (mask === 4 || mask === 11) segments.push([right, bottom]);
        else if (mask === 8 || mask === 7) segments.push([bottom, left]);
        else if (mask === 3 || mask === 12) segments.push([left, right]);
        else if (mask === 6 || mask === 9) segments.push([top, bottom]);
        else if (mask === 5) { segments.push([left, bottom], [top, right]); }
        else if (mask === 10) { segments.push([left, top], [bottom, right]); }
      }
    }
    if (segments.length) {
      features.push({
        type: 'Feature',
        properties: { level: idx + 1, tempCelsius: iso, label: `${lvl.label} (${iso.toFixed(1)}°C)`, color: lvl.color, kmlColor: lvl.kmlColor },
        geometry: { type: 'MultiLineString', coordinates: segments },
      });
    }
  });
  return { type: 'FeatureCollection', features };
}

function buildShapeVertices(mode: AoiShapeMode, p1: [number, number], p2: [number, number]): [number, number][] {
  const [lng1, lat1] = p1;
  const [lng2, lat2] = p2;
  const cosLat = Math.max(0.15, Math.cos(((lat1 + lat2) * 0.5 * Math.PI) / 180));
  if (mode === 'rectangle') {
    const w = Math.min(lng1, lng2); const e = Math.max(lng1, lng2);
    const s = Math.min(lat1, lat2); const n = Math.max(lat1, lat2);
    return [[w, n], [e, n], [e, s], [w, s]];
  }
  if (mode === 'square') {
    const half = Math.max(Math.abs(lng2 - lng1) * cosLat, Math.abs(lat2 - lat1), 1e-5);
    const dLng = half / cosLat;
    return [[lng1 - dLng, lat1 + half], [lng1 + dLng, lat1 + half], [lng1 + dLng, lat1 - half], [lng1 - dLng, lat1 - half]];
  }
  if (mode === 'circle') {
    const dx = (lng2 - lng1) * cosLat; const dy = lat2 - lat1;
    const r = Math.max(Math.sqrt(dx * dx + dy * dy), 1e-5);
    const pts: [number, number][] = [];
    for (let i = 0; i < 64; i += 1) {
      const a = (i / 64) * Math.PI * 2;
      pts.push([lng1 + (Math.cos(a) * r) / cosLat, lat1 + Math.sin(a) * r]);
    }
    return pts;
  }
  return [p1, p2];
}

function pointInPolygon(point: [number, number], polygon: [number, number][]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]; const [xj, yj] = polygon[j];
    if (((yi > point[1]) !== (yj > point[1])) && point[0] < ((xj - xi) * (point[1] - yi)) / ((yj - yi) || Number.EPSILON) + xi) inside = !inside;
  }
  return inside;
}

function analyzeAoiDetailed(
  raster: RasterState, vertices: [number, number][], shapeMode: AoiShapeMode,
  opticalCanvas: HTMLCanvasElement | null, lstCanvas: HTMLCanvasElement | null, opacity: number,
): AoiDetailedStats | null {
  if (!raster || vertices.length < 3) return null;
  const ext = boundsExtent(raster.bounds);
  let minLng = Infinity; let maxLng = -Infinity; let minLat = Infinity; let maxLat = -Infinity;
  for (const [lng, lat] of vertices) {
    if (lng < minLng) minLng = lng; if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
  }
  const x0 = Math.max(0, Math.floor(((minLng - ext.west) / (ext.east - ext.west)) * raster.width));
  const x1 = Math.min(raster.width - 1, Math.ceil(((maxLng - ext.west) / (ext.east - ext.west)) * raster.width));
  const y0 = Math.max(0, Math.floor(((ext.north - maxLat) / (ext.north - ext.south)) * raster.height));
  const y1 = Math.min(raster.height - 1, Math.ceil(((ext.north - minLat) / (ext.north - ext.south)) * raster.height));
  if (x1 < x0 || y1 < y0) return null;

  const clipWidth = Math.max(1, x1 - x0 + 1);
  const clipHeight = Math.max(1, y1 - y0 + 1);
  const clippedFloat32 = new Float32Array(clipWidth * clipHeight);
  clippedFloat32.fill(NaN);

  const values: number[] = [];
  let sum = 0; let min = Infinity; let max = -Infinity;
  let ndviSum = 0; let ndbiSum = 0; let vegCount = 0; let builtCount = 0; let specValid = 0;
  const uhiCounts = [0, 0, 0, 0, 0, 0];
  const sceneMean = raster.stats.mean;
  const sceneStd = Math.max(0.6, raster.stats.stdDev);

  for (let y = y0; y <= y1; y += 1) {
    const lat = ext.north - ((y + 0.5) / raster.height) * (ext.north - ext.south);
    const row = y * raster.width;
    const clipRow = (y - y0) * clipWidth;
    for (let x = x0; x <= x1; x += 1) {
      const lng = ext.west + ((x + 0.5) / raster.width) * (ext.east - ext.west);
      if (!pointInPolygon([lng, lat], vertices)) continue;
      const idx = row + x;
      const val = raster.data[idx];
      if (!Number.isFinite(val)) continue;
      clippedFloat32[clipRow + (x - x0)] = val;
      values.push(val); sum += val;
      if (val < min) min = val; if (val > max) max = val;
      const z = (val - sceneMean) / sceneStd;
      if (z < -0.95) uhiCounts[0] += 1;
      else if (z < -0.3) uhiCounts[1] += 1;
      else if (z < 0.25) uhiCounts[2] += 1;
      else if (z < 0.85) uhiCounts[3] += 1;
      else if (z < 1.4) uhiCounts[4] += 1;
      else uhiCounts[5] += 1;
      const ndvi = raster.ndvi[idx]; const ndbi = raster.ndbi[idx];
      if (Number.isFinite(ndvi) && Number.isFinite(ndbi)) {
        specValid += 1; ndviSum += ndvi; ndbiSum += ndbi;
        if (ndvi > 0.3) vegCount += 1; if (ndbi > 0.1) builtCount += 1;
      }
    }
  }
  if (!values.length) return null;
  const count = values.length;
  const mean = sum / count;
  let sq = 0;
  for (let i = 0; i < count; i += 1) sq += (values[i] - mean) ** 2;
  const stdDev = count > 1 ? Math.sqrt(sq / count) : 0;
  values.sort((a, b) => a - b);
  const q25 = values[Math.floor(count * 0.25)] ?? min;
  const q50 = values[Math.floor(count * 0.5)] ?? mean;
  const q75 = values[Math.floor(count * 0.75)] ?? max;
  const resX = Math.abs(raster.resolution[0] || 1);
  const resY = Math.abs(raster.resolution[1] || 1);
  const pxAreaM2 = raster.isProjected ? resX * resY : resX * 111320 * (resY * 110540);
  const areaM2 = count * pxAreaM2;
  const areaHa = areaM2 / 10000;

  const previewCanvas = document.createElement('canvas');
  previewCanvas.width = clipWidth; previewCanvas.height = clipHeight;
  const pCtx = previewCanvas.getContext('2d');
  if (pCtx && opticalCanvas && lstCanvas) {
    pCtx.fillStyle = '#071317'; pCtx.fillRect(0, 0, clipWidth, clipHeight);
    pCtx.drawImage(opticalCanvas, x0, y0, clipWidth, clipHeight, 0, 0, clipWidth, clipHeight);
    pCtx.globalAlpha = opacity;
    pCtx.drawImage(lstCanvas, x0, y0, clipWidth, clipHeight, 0, 0, clipWidth, clipHeight);
    pCtx.globalAlpha = 1;
    pCtx.strokeStyle = '#ffb000';
    pCtx.lineWidth = Math.max(2, Math.round(Math.max(clipWidth, clipHeight) * 0.008));
    pCtx.beginPath();
    vertices.forEach(([lng, lat], i) => {
      const px = ((lng - ext.west) / (ext.east - ext.west)) * raster.width - x0;
      const py = ((ext.north - lat) / (ext.north - ext.south)) * raster.height - y0;
      if (i === 0) pCtx.moveTo(px, py); else pCtx.lineTo(px, py);
    });
    pCtx.closePath(); pCtx.stroke();
  }
  return {
    shapeMode, vertices, count, areaM2, areaHa, min, max, mean, stdDev, q25, q50, q75,
    ndviMean: specValid ? ndviSum / specValid : 0,
    ndbiMean: specValid ? ndbiSum / specValid : 0,
    vegPct: specValid ? (vegCount / specValid) * 100 : 0,
    builtPct: specValid ? (builtCount / specValid) * 100 : 0,
    uhiCounts, uhiPcts: uhiCounts.map((c) => (c / count) * 100),
    previewDataUrl: previewCanvas.toDataURL('image/png'),
    clipWidth, clipHeight, clippedFloat32,
    clipOrigin: [raster.origin[0] + x0 * raster.resolution[0], raster.origin[1] + y0 * raster.resolution[1], raster.origin[2] || 0],
  };
}

function LogoMark() {
  return (
    <svg className="logo-mark" viewBox="0 0 44 44" role="img" aria-label="SR2D4 LST Explorer logo">
      <defs><linearGradient id="thermal-logo" x1="0" x2="1"><stop stopColor="#4324a8" /><stop offset=".52" stopColor="#f04435" /><stop offset="1" stopColor="#ffc400" /></linearGradient></defs>
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
  return <svg className="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths}</svg>;
}
function LayerRow({ label, visible, onToggle, color }: { label: string; visible: boolean; onToggle: () => void; color: string }) {
  return <button className="layer-row" onClick={onToggle}><span className={`layer-swatch ${color}`} /><span>{label}</span><span className="layer-state">{visible ? 'VISIBLE' : 'HIDDEN'}</span></button>;
}
function Metric({ label, value }: { label: string; value: string }) {
  return <div className="metric"><small>{label}</small><strong>{value}</strong></div>;
}
function meanOf(data: Float32Array) {
  let sum = 0; let count = 0;
  for (const v of data) if (Number.isFinite(v)) { sum += v; count += 1; }
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
    landsat.lstCelsius, landsat.width, landsat.height, landsat.bounds,
    { ...indices, red, nir, swir }, tiff.width, tiff.height, bounds,
  );
  const resLabel = tiff.isProjected ? `${Math.abs(tiff.resolution[0]).toFixed(2)} m/pixel` : `${Math.abs(tiff.resolution[0]).toFixed(6)} graus/pixel`;
  onProgress?.(`Fusão concluída: ${result.model} · ${result.validCount} células coarse · saída ${tiff.width.toLocaleString()}×${tiff.height.toLocaleString()} px · ${resLabel}`);
  return { tiff, bounds, indices, landsat, result };
}
function thermalDifference(
  primary: { data: Float32Array; width: number; height: number; bounds: RasterBounds },
  secondary: { data: Float32Array; width: number; height: number; bounds: RasterBounds },
) {
  const result = new Float32Array(primary.width * primary.height);
  const pExt = boundsExtent(primary.bounds); const sExt = boundsExtent(secondary.bounds);
  for (let y = 0; y < primary.height; y += 1) {
    for (let x = 0; x < primary.width; x += 1) {
      const lng = pExt.west + ((x + 0.5) / primary.width) * (pExt.east - pExt.west);
      const lat = pExt.north - ((y + 0.5) / primary.height) * (pExt.north - pExt.south);
      const sx = Math.floor(((lng - sExt.west) / (sExt.east - sExt.west)) * secondary.width);
      const sy = Math.floor(((sExt.north - lat) / (sExt.north - sExt.south)) * secondary.height);
      const a = primary.data[y * primary.width + x];
      const b = sx >= 0 && sy >= 0 && sx < secondary.width && sy < secondary.height ? secondary.data[sy * secondary.width + sx] : NaN;
      result[y * primary.width + x] = Number.isFinite(a) && Number.isFinite(b) ? b - a : NaN;
    }
  }
  return result;
}
function sampleDiffColor(anomVal: number, sigma: number, maxScale: number): [number, number, number] {
  const absV = Math.abs(anomVal);
  if (absV <= sigma) {
    const t = anomVal / Math.max(0.1, sigma);
    return [Math.round(70 + t * 10), Math.round(82 - Math.abs(t) * 4), Math.round(92 - t * 10)];
  }
  const norm = Math.min(1, (absV - sigma) / Math.max(0.35, maxScale - sigma));
  if (anomVal < -sigma) {
    return norm < 0.5
      ? [Math.round(72 * (1 - norm * 2)), Math.round(202 - 132 * norm), Math.round(228 - 48 * norm)]
      : [Math.round(3 * (norm - 0.5) * 2), Math.round(136 - 202 * (norm - 0.5)), Math.round(204 - 132 * (norm - 0.5))];
  }
  return norm < 0.55
    ? [Math.round(247 - 60 * (norm / 0.55)), Math.round(127 - 158 * (norm / 0.55)), Math.round(72 * (norm / 0.55))]
    : [Math.round(214 + 41 * ((norm - 0.55) / 0.45)), Math.round(40 + 194 * ((norm - 0.55) / 0.45)), Math.round(40 * (1 - (norm - 0.55) / 0.45))];
}
function renderDifferenceToCanvas(
  data: Float32Array, baseTemp: Float32Array, width: number, height: number, canvas: HTMLCanvasElement,
): DifferenceStats | null {
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  let min = Infinity; let max = -Infinity; let sum = 0; let count = 0;
  const step = Math.max(1, Math.floor(data.length / 25000));
  for (let i = 0; i < data.length; i += 1) {
    const v = data[i];
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v; count += 1;
  }
  if (!count) return null;
  const mean = sum / count;
  let sqSum = 0; let sqCount = 0;
  const anomSamples: number[] = [];
  for (let i = 0; i < data.length; i += step) {
    const v = data[i];
    if (Number.isFinite(v)) {
      const d = v - mean;
      sqSum += d * d; sqCount += 1; anomSamples.push(Math.abs(d));
    }
  }
  const stdDev = sqCount > 1 ? Math.sqrt(sqSum / sqCount) : 1.0;
  const thresholdSigma = Math.max(0.35, stdDev);
  const centerOffset = Math.abs(mean) > 1.15 * thresholdSigma ? mean : 0;
  anomSamples.sort((a, b) => a - b);
  const maxScale = Math.max(thresholdSigma * 1.8, anomSamples[Math.floor(anomSamples.length * 0.985)] ?? thresholdSigma * 2.5);
  let decCount = 0; let eqCount = 0; let incCount = 0;
  const image = ctx.createImageData(width, height);
  const out = image.data;
  for (let y = 0; y < height; y += 1) {
    const row = y * width; const yP = Math.max(0, y - 1) * width; const yN = Math.min(height - 1, y + 1) * width;
    for (let x = 0; x < width; x += 1) {
      const i = row + x; const value = data[i]; const px = i * 4;
      if (!Number.isFinite(value)) { out[px + 3] = 0; continue; }
      const anom = value - centerOffset;
      if (anom < -thresholdSigma) decCount += 1;
      else if (anom > thresholdSigma) incCount += 1;
      else eqCount += 1;
      const xP = Math.max(0, x - 1); const xN = Math.min(width - 1, x + 1);
      const bC = Number.isFinite(baseTemp[i]) ? baseTemp[i] : 0;
      const bE = Number.isFinite(baseTemp[row + xN]) ? baseTemp[row + xN] : bC;
      const bW = Number.isFinite(baseTemp[row + xP]) ? baseTemp[row + xP] : bC;
      const bS = Number.isFinite(baseTemp[yN + x]) ? baseTemp[yN + x] : bC;
      const bN = Number.isFinite(baseTemp[yP + x]) ? baseTemp[yP + x] : bC;
      const relief = Math.max(-0.18, Math.min(0.18, (bE - bW) * 0.12 - (bS - bN) * 0.12 + (bC - 0.25 * (bE + bW + bS + bN)) * 0.22));
      const [r, g, b] = sampleDiffColor(anom, thresholdSigma, maxScale);
      const m = 1 + relief;
      out[px] = Math.max(0, Math.min(255, Math.round(r * m)));
      out[px + 1] = Math.max(0, Math.min(255, Math.round(g * m)));
      out[px + 2] = Math.max(0, Math.min(255, Math.round(b * m)));
      out[px + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return {
    min, max, mean, stdDev, thresholdSigma, maxScale,
    pctDecreased: (decCount / count) * 100, pctEqual: (eqCount / count) * 100, pctIncreased: (incCount / count) * 100,
  };
}
function differenceClassLabel(diff: number, stats: DifferenceStats, lang: Lang): { label: string; color: string } {
  if (!Number.isFinite(diff)) return { label: '—', color: '#9ab0b5' };
  const sigma = stats.thresholdSigma;
  const center = Math.abs(stats.mean) > 1.15 * sigma ? stats.mean : 0;
  const anom = diff - center;
  if (anom < -2 * sigma) return { label: lang === 'pt' ? '↓ DIMINUIU FORTE (< -2σ)' : '↓ STRONG COOLING (< -2σ)', color: '#38bdf8' };
  if (anom < -sigma) return { label: lang === 'pt' ? '↓ DIMINUIU (abaixo de -1σ)' : '↓ DECREASED (< -1σ)', color: '#48cae4' };
  if (anom > 2 * sigma) return { label: lang === 'pt' ? '↑ AUMENTOU FORTE (> +2σ)' : '↑ STRONG WARMING (> +2σ)', color: '#ffea00' };
  if (anom > sigma) return { label: lang === 'pt' ? '↑ AUMENTOU (acima de +1σ)' : '↑ INCREASED (> +1σ)', color: '#ff7b29' };
  return { label: lang === 'pt' ? '＝ PERMANECEU IGUAL (dentro de ±1σ)' : '＝ REMAINED EQUAL (within ±1σ)', color: '#a3b8c2' };
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
  const m = name.match(/(20\d{2})[-_]?([01]\d)[-_]?([0-3]\d)/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : `Data ${String(index + 1).padStart(2, '0')}`;
}
function paletteGradient(palette: string, customColors: string[]) {
  const pts = Array.from({ length: 13 }, (_, idx) => sampleCssColorAt(idx / 12, palette, customColors, false));
  return `linear-gradient(90deg, ${pts.join(', ')})`;
}

// Leitura de Bairros e Ruas reais no OpenStreetMap cruzados com o raster numérico de 1m
async function fetchOsmUrbanFeatures(raster: RasterState): Promise<{ bairros: OsmFeatureStat[]; vias: OsmFeatureStat[] }> {
  const ext = boundsExtent(raster.bounds);
  const hotspotLim = raster.stats.mean + 0.85 * raster.stats.stdDev;
  const sampleAt = (lng: number, lat: number, radiusPx: number) => {
    const x = Math.floor(((lng - ext.west) / (ext.east - ext.west)) * raster.width);
    const y = Math.floor(((ext.north - lat) / (ext.north - ext.south)) * raster.height);
    if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) return null;
    const vals: number[] = [];
    let sumT = 0; let maxT = -Infinity; let sumV = 0; let sumB = 0; let hot = 0;
    for (let ky = -radiusPx; ky <= radiusPx; ky += 1) {
      for (let kx = -radiusPx; kx <= radiusPx; kx += 1) {
        const nx = Math.max(0, Math.min(raster.width - 1, x + kx));
        const ny = Math.max(0, Math.min(raster.height - 1, y + ky));
        const idx = ny * raster.width + nx;
        const t = raster.data[idx];
        if (Number.isFinite(t)) {
          vals.push(t); sumT += t;
          if (t > maxT) maxT = t;
          if (t >= hotspotLim) hot += 1;
          sumV += Number.isFinite(raster.ndvi[idx]) ? raster.ndvi[idx] : 0;
          sumB += Number.isFinite(raster.ndbi[idx]) ? raster.ndbi[idx] : 0;
        }
      }
    }
    if (!vals.length) return null;
    vals.sort((a, b) => a - b);
    return {
      meanTemp: sumT / vals.length,
      medianTemp: vals[Math.floor(vals.length * 0.5)],
      maxTemp: maxT,
      ndvi: sumV / vals.length,
      ndbi: sumB / vals.length,
      hotPct: (hot / vals.length) * 100,
      samples: vals.length,
    };
  };

  const bairrosMap = new Map<string, OsmFeatureStat>();
  const viasMap = new Map<string, OsmFeatureStat>();
  try {
    const query = `[out:json][timeout:6];(node["place"~"suburb|neighbourhood|quarter"](${ext.south},${ext.west},${ext.north},${ext.east});way["place"~"suburb|neighbourhood|quarter"](${ext.south},${ext.west},${ext.north},${ext.east});way["highway"~"primary|secondary|tertiary|trunk|residential"]["name"](${ext.south},${ext.west},${ext.north},${ext.east}););out center 140;`;
    const resp = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`);
    if (resp.ok) {
      const json = (await resp.json()) as { elements?: any[] };
      for (const el of json.elements ?? []) {
        const name = el.tags?.name;
        if (!name) continue;
        const lat = el.lat ?? el.center?.lat;
        const lon = el.lon ?? el.center?.lon;
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const isPlace = Boolean(el.tags?.place);
        const s = sampleAt(lon, lat, isPlace ? 18 : 4);
        if (!s) continue;
        const id = `${el.type}/${el.id}`;
        if (isPlace) {
          if (!bairrosMap.has(name)) bairrosMap.set(name, { id, name, kind: 'Bairro', ...s });
        } else if (el.tags?.highway) {
          const prev = viasMap.get(name);
          if (!prev || s.meanTemp > prev.meanTemp) {
            viasMap.set(name, { id, name, kind: 'Via', highway: el.tags.highway, ...s });
          }
        }
      }
    }
  } catch { /* ignore network errors */ }
  return {
    bairros: [...bairrosMap.values()].sort((a, b) => b.meanTemp - a.meanTemp).slice(0, 12),
    vias: [...viasMap.values()].sort((a, b) => b.meanTemp - a.meanTemp).slice(0, 15),
  };
}

function renderMapWithFooterLegend(
  baseOptical: HTMLCanvasElement, overlayCanvas: HTMLCanvasElement, opacity: number,
  title: string, isUhi: boolean, stats: RasterStats, palette: string, customColors: string[],
): string {
  const w = overlayCanvas.width; const h = overlayCanvas.height;
  const legH = Math.max(150, Math.round(h * 0.14));
  const out = document.createElement('canvas');
  out.width = w; out.height = h + legH;
  const ctx = out.getContext('2d');
  if (!ctx) return '';
  ctx.fillStyle = '#0f2238'; ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(baseOptical, 0, 0, w, h);
  ctx.globalAlpha = opacity; ctx.drawImage(overlayCanvas, 0, 0, w, h); ctx.globalAlpha = 1;

  const pad = Math.max(22, Math.round(w * 0.03));
  const barW = w - pad * 2;
  ctx.strokeStyle = 'rgba(156,221,218,0.4)'; ctx.lineWidth = 2;
  ctx.strokeRect(pad * 0.5, h + 8, w - pad, legH - 16);
  ctx.fillStyle = '#9cddda';
  ctx.font = `700 ${Math.max(15, Math.round(w * 0.015))}px Inter, Arial, sans-serif`;
  ctx.fillText(title, pad, h + Math.round(legH * 0.26));

  const barY = h + Math.round(legH * 0.38);
  const barH = Math.max(22, Math.round(legH * 0.22));
  const fSub = Math.max(12, Math.round(w * 0.0115));

  if (!isUhi) {
    const grad = ctx.createLinearGradient(pad, barY, pad + barW, barY);
    for (let s = 0; s <= 16; s += 1) grad.addColorStop(s / 16, sampleCssColorAt(s / 16, palette, customColors, false));
    ctx.fillStyle = grad; ctx.fillRect(pad, barY, barW, barH);
    ctx.strokeStyle = '#fff'; ctx.strokeRect(pad, barY, barW, barH);
    ctx.fillStyle = '#fff'; ctx.font = `700 ${fSub}px Inter, Arial, sans-serif`;
    const ly = barY + barH + Math.round(legH * 0.22);
    ctx.textAlign = 'left'; ctx.fillText(`Mín: ${stats.min.toFixed(1)} °C`, pad, ly);
    ctx.textAlign = 'center';
    ctx.fillText(`Q25: ${stats.q25.toFixed(1)} °C`, pad + barW * 0.25, ly);
    ctx.fillText(`Mediana: ${stats.q50.toFixed(1)} °C | Média: ${stats.mean.toFixed(1)} °C (σ=${stats.stdDev.toFixed(2)}°C)`, pad + barW * 0.5, ly);
    ctx.fillText(`Q75: ${stats.q75.toFixed(1)} °C`, pad + barW * 0.75, ly);
    ctx.textAlign = 'right'; ctx.fillText(`Máx: ${stats.max.toFixed(1)} °C`, pad + barW, ly);
    ctx.textAlign = 'left';
  } else {
    const cls = [
      { n: '1. Frescor (< -0,95σ)', c: '#103e8a' },
      { n: '2. Amenizado (-0,95 a -0,30σ)', c: '#2ba198' },
      { n: '3. Neutro (-0,30 a +0,25σ)', c: '#bade76' },
      { n: '4. UHI Moderada (+0,25 a +0,85σ)', c: '#f8d668' },
      { n: '5. UHI Forte (+0,85 a +1,40σ)', c: '#f47c30' },
      { n: '6. UHI Extrema (> +1,40σ)', c: '#d42026' },
    ];
    const segW = barW / cls.length;
    cls.forEach((it, idx) => {
      const x = pad + idx * segW;
      ctx.fillStyle = it.c; ctx.fillRect(x, barY, segW - 4, barH);
      ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.strokeRect(x, barY, segW - 4, barH);
      ctx.fillStyle = '#fff'; ctx.font = `700 ${Math.max(11, fSub - 1)}px Inter, Arial, sans-serif`;
      ctx.fillText(it.n, x + 2, barY + barH + Math.round(legH * 0.22));
    });
  }
  return out.toDataURL('image/webp', 0.92);
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
  const [drawAoi, setDrawAoi] = useState(false);
  const [aoiStats, setAoiStats] = useState<{ count: number; min: number; max: number; mean: number } | null>(null);
  const [aoiShapeMode, setAoiShapeMode] = useState<AoiShapeMode>('rectangle');
  const [aoiAnchor, setAoiAnchor] = useState<[number, number] | null>(null);
  const [aoiDetailed, setAoiDetailed] = useState<AoiDetailedStats | null>(null);
  const [showAoiModal, setShowAoiModal] = useState(false);
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [coordText, setCoordText] = useState('');
  const [comparisonCount, setComparisonCount] = useState(2);
  const [comparisonFiles, setComparisonFiles] = useState<(File | null)[]>([null, null]);
  const [comparisonImages, setComparisonImages] = useState<ComparisonImage[]>([]);
  const [comparisonMode, setComparisonMode] = useState<'difference' | 'secondary' | 'main'>('difference');
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
  const showingComparison = differenceReady && comparisonMode !== 'main';

  useEffect(() => {
    const timer = window.setTimeout(() => setCustomColors(draftCustomColors), 140);
    return () => window.clearTimeout(timer);
  }, [draftCustomColors]);

  const differenceRender = useMemo(() => {
    if (!comparisonPrimary || !comparisonSecondary || !differenceReady) return null;
    const data = thermalDifference(comparisonPrimary, comparisonSecondary);
    const canvas = document.createElement('canvas');
    const stats = renderDifferenceToCanvas(data, comparisonPrimary.data, comparisonPrimary.width, comparisonPrimary.height, canvas);
    return stats ? { url: canvas.toDataURL('image/png'), stats, data } : null;
  }, [comparisonPrimary, comparisonSecondary, differenceReady]);

  const mapClickMode = useRef({
    drawAoi: false, aoiShapeMode: 'rectangle' as AoiShapeMode, aoiAnchor: null as [number, number] | null,
    raster: null as RasterState | null, extent: null as ReturnType<typeof boundsExtent> | null,
    identifyMode: false, comparisonPrimary: null as ComparisonImage | null,
    comparisonSecondary: null as ComparisonImage | null, differenceData: null as Float32Array | null,
    showingComparison: false,
  });

  const uhiGradient = 'linear-gradient(90deg, #103e8a, #187a8c, #3aae6c, #bade76, #f8d668, #f47c30, #d42026, #fff4b8)';
  const legendGradient = displayMode === 'uhi' ? uhiGradient : paletteGradient(palette, draftCustomColors);
  const differenceStats = differenceRender?.stats ?? null;

  useEffect(() => { localStorage.setItem('lst-theme', theme); document.documentElement.dataset.theme = theme; }, [theme]);

  useEffect(() => {
    mapClickMode.current = {
      drawAoi, aoiShapeMode, aoiAnchor, raster, extent, identifyMode, comparisonPrimary, comparisonSecondary,
      differenceData: differenceRender?.data ?? null, showingComparison,
    };
  }, [drawAoi, aoiShapeMode, aoiAnchor, raster, extent, identifyMode, comparisonPrimary, comparisonSecondary, differenceRender, showingComparison]);

  useEffect(() => {
    const onMove = (ev: PointerEvent) => {
      if (resizing.current) setPanelWidth(Math.max(330, Math.min(560, window.innerWidth - ev.clientX)));
      if (curtainDragging.current) {
        const stage = document.querySelector('.map-stage') as HTMLElement | null;
        if (stage) {
          const rect = stage.getBoundingClientRect();
          setSwipePosition(Math.max(0, Math.min(100, ((ev.clientX - rect.left) / rect.width) * 100)));
        }
      }
    };
    const onUp = () => {
      resizing.current = false; curtainDragging.current = false;
      document.body.classList.remove('is-resizing', 'is-curtain-dragging');
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
      style: { version: 8, sources: { basemap: { type: 'raster', tiles: [TILE_URLS.osm], tileSize: 256, attribution: '© OpenStreetMap' } }, layers: [{ id: 'basemap', type: 'raster', source: 'basemap' }] },
      center: [-46.63, -23.55], zoom: 4, attributionControl: false,
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

    const inspectAt = (event: maplibregl.MapMouseEvent, commit: boolean) => {
      const m = mapClickMode.current;
      if (m.showingComparison && m.comparisonPrimary && m.comparisonSecondary && m.differenceData) {
        const pE = boundsExtent(m.comparisonPrimary.bounds); const sE = boundsExtent(m.comparisonSecondary.bounds);
        const px = Math.floor(((event.lngLat.lng - pE.west) / (pE.east - pE.west)) * m.comparisonPrimary.width);
        const py = Math.floor(((pE.north - event.lngLat.lat) / (pE.north - pE.south)) * m.comparisonPrimary.height);
        const sx = Math.floor(((event.lngLat.lng - sE.west) / (sE.east - sE.west)) * m.comparisonSecondary.width);
        const sy = Math.floor(((sE.north - event.lngLat.lat) / (sE.north - sE.south)) * m.comparisonSecondary.height);
        if (px >= 0 && py >= 0 && px < m.comparisonPrimary.width && py < m.comparisonPrimary.height) {
          const i1 = py * m.comparisonPrimary.width + px;
          const t1 = m.comparisonPrimary.data[i1];
          const t2 = sx >= 0 && sy >= 0 && sx < m.comparisonSecondary.width && sy < m.comparisonSecondary.height ? m.comparisonSecondary.data[sy * m.comparisonSecondary.width + sx] : NaN;
          const d = m.differenceData[i1];
          if (Number.isFinite(t1) || Number.isFinite(d)) {
            const pt: InspectPoint = { temp: Number.isFinite(t2) ? t2 : t1, lng: event.lngLat.lng, lat: event.lngLat.lat, beforeTemp: Number.isFinite(t1) ? t1 : undefined, afterTemp: Number.isFinite(t2) ? t2 : undefined, diffTemp: Number.isFinite(d) ? d : undefined };
            if (commit) setSample(pt); else if (m.identifyMode) setHoverSample(pt);
            return;
          }
        }
      }
      if (!m.raster || !m.extent) return;
      const x = Math.floor(((event.lngLat.lng - m.extent.west) / (m.extent.east - m.extent.west)) * m.raster.width);
      const y = Math.floor(((m.extent.north - event.lngLat.lat) / (m.extent.north - m.extent.south)) * m.raster.height);
      if (x >= 0 && y >= 0 && x < m.raster.width && y < m.raster.height) {
        const temp = m.raster.data[y * m.raster.width + x];
        if (Number.isFinite(temp)) {
          const pt: InspectPoint = { temp, lng: event.lngLat.lng, lat: event.lngLat.lat };
          if (commit) setSample(pt); else if (m.identifyMode) setHoverSample(pt);
        }
      }
    };

    map.on('click', (ev) => {
      const m = mapClickMode.current;
      if (m.drawAoi) {
        ev.preventDefault();
        const pt: [number, number] = [ev.lngLat.lng, ev.lngLat.lat];
        if (m.aoiShapeMode === 'polygon') {
          setAoi((p) => [...p, pt]);
        } else if (!m.aoiAnchor) {
          setAoiAnchor(pt);
          setAoi([pt]);
        } else {
          const poly = buildShapeVertices(m.aoiShapeMode, m.aoiAnchor, pt);
          setAoi(poly);
          setAoiAnchor(null);
          setDrawAoi(false);
          setPanEnabled(true);
          map.dragPan.enable(); map.scrollZoom.enable(); map.doubleClickZoom.enable();
          if (m.raster) {
            const det = analyzeAoiDetailed(m.raster, poly, m.aoiShapeMode, opticalCanvas.current, lstCanvas.current, 0.94);
            if (det) {
              setAoiDetailed(det);
              setAoiStats({ count: det.count, min: det.min, max: det.max, mean: det.mean });
              setShowAoiModal(true);
            }
          }
        }
        return;
      }
      inspectAt(ev, true);
    });

    map.on('dblclick', (ev) => {
      const m = mapClickMode.current;
      if (!m.drawAoi) return;
      ev.preventDefault();
      setAoi((p) => {
        const cl = p.length > 1 && Math.abs(p[p.length - 1][0] - ev.lngLat.lng) < 1e-7 && Math.abs(p[p.length - 1][1] - ev.lngLat.lat) < 1e-7 ? p.slice(0, -1) : p;
        if (cl.length >= 3) {
          setDrawAoi(false); setPanEnabled(true);
          map.dragPan.enable(); map.doubleClickZoom.enable(); map.scrollZoom.enable(); map.touchZoomRotate.enable();
          if (m.raster) {
            const det = analyzeAoiDetailed(m.raster, cl, m.aoiShapeMode, opticalCanvas.current, lstCanvas.current, 0.94);
            if (det) {
              setAoiDetailed(det);
              setAoiStats({ count: det.count, min: det.min, max: det.max, mean: det.mean });
              setShowAoiModal(true);
            }
          }
        }
        return cl;
      });
    });

    let hf = 0;
    map.on('mousemove', (ev) => {
      const m = mapClickMode.current;
      if (m.drawAoi && m.aoiShapeMode !== 'polygon' && m.aoiAnchor) {
        if (!hf) {
          hf = requestAnimationFrame(() => {
            setAoi(buildShapeVertices(m.aoiShapeMode, m.aoiAnchor!, [ev.lngLat.lng, ev.lngLat.lat]));
            hf = 0;
          });
        }
        return;
      }
      if (!m.drawAoi && m.identifyMode && !hf) {
        hf = requestAnimationFrame(() => { inspectAt(ev, false); hf = 0; });
      }
    });

    map.on('dragstart', () => setHoverSample(null));
    map.dragPan.enable(); mapInstance.current = map;
    return () => { map.remove(); mapInstance.current = null; };
  }, []);

  const syncLayers = useCallback(() => {
    const map = mapInstance.current;
    if (!map || !map.isStyleLoaded()) return;
    const addOrUpdate = (id: string, url: string, coordinates: RasterBounds) => {
      const ex = map.getSource(id) as any;
      if (ex) ex.updateImage({ url, coordinates }); else map.addSource(id, { type: 'image', url, coordinates });
    };
    if (raster && lstUrl && opticalUrl) {
      addOrUpdate('lst-raster', lstUrl, raster.bounds); addOrUpdate('optical-raster', opticalUrl, raster.bounds);
      if (!map.getLayer('lst-layer')) map.addLayer({ id: 'lst-layer', type: 'raster', source: 'lst-raster', paint: { 'raster-opacity': opacity, 'raster-contrast': contrast } });
      if (!map.getLayer('optical-layer')) map.addLayer({ id: 'optical-layer', type: 'raster', source: 'optical-raster', paint: { 'raster-opacity': 1 } });
    }
    if (comparisonPrimary && comparisonSecondary && showingComparison) {
      addOrUpdate('comparison-primary-raster', comparisonPrimary.lstUrl, comparisonPrimary.bounds);
      addOrUpdate('comparison-lst-raster', comparisonSecondary.lstUrl, comparisonSecondary.bounds);
      if (!map.getLayer('comparison-primary-layer')) map.addLayer({ id: 'comparison-primary-layer', type: 'raster', source: 'comparison-primary-raster', paint: { 'raster-opacity': 1 } });
      if (!map.getLayer('comparison-lst-layer')) map.addLayer({ id: 'comparison-lst-layer', type: 'raster', source: 'comparison-lst-raster', paint: { 'raster-opacity': 0.95 } });
      if (differenceRender) addOrUpdate('comparison-difference-raster', differenceRender.url, comparisonPrimary.bounds);
      if (!map.getLayer('comparison-difference-layer')) map.addLayer({ id: 'comparison-difference-layer', type: 'raster', source: 'comparison-difference-raster', paint: { 'raster-opacity': 0.94 } });
      map.setLayoutProperty('comparison-primary-layer', 'visibility', swipeActive ? 'visible' : 'none');
      map.setLayoutProperty('comparison-lst-layer', 'visibility', !swipeActive && comparisonMode === 'secondary' ? 'visible' : 'none');
      map.setLayoutProperty('comparison-difference-layer', 'visibility', comparisonMode === 'difference' && !swipeActive ? 'visible' : 'none');
    } else {
      for (const id of ['comparison-primary-layer', 'comparison-lst-layer', 'comparison-difference-layer']) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
    }
    if (map.getLayer('lst-layer')) {
      map.setLayoutProperty('lst-layer', 'visibility', visibleLst && !showingComparison ? 'visible' : 'none');
      map.setPaintProperty('lst-layer', 'raster-opacity', opacity); map.setPaintProperty('lst-layer', 'raster-contrast', contrast);
    }
    if (map.getLayer('optical-layer')) map.setLayoutProperty('optical-layer', 'visibility', visibleOptical && !showingComparison ? 'visible' : 'none');
  }, [comparisonMode, comparisonPrimary, comparisonSecondary, contrast, differenceRender, lstUrl, opacity, opticalUrl, raster, showingComparison, swipeActive, visibleLst, visibleOptical]);

  useEffect(() => {
    const container = curtainContainerRef.current; const main = mapInstance.current;
    if (!container || !main || !swipeActive || !comparisonSecondary || !showingComparison) {
      curtainMapRef.current?.remove(); curtainMapRef.current = null; return;
    }
    const curtainMap = new maplibregl.Map({
      container, style: { version: 8, sources: {}, layers: [] },
      center: main.getCenter(), zoom: main.getZoom(), bearing: main.getBearing(), pitch: main.getPitch(),
      interactive: false, attributionControl: false,
    });
    const syncCam = () => curtainMap.jumpTo({ center: main.getCenter(), zoom: main.getZoom(), bearing: main.getBearing(), pitch: main.getPitch() });
    curtainMap.on('load', () => {
      curtainMap.resize();
      curtainMap.addSource('curtain-secondary-raster', { type: 'image', url: comparisonSecondary.lstUrl, coordinates: comparisonSecondary.bounds });
      curtainMap.addLayer({ id: 'curtain-secondary-layer', type: 'raster', source: 'curtain-secondary-raster', paint: { 'raster-opacity': 1 } });
      syncCam();
    });
    main.on('move', syncCam); curtainMapRef.current = curtainMap;
    return () => { main.off('move', syncCam); curtainMap.remove(); curtainMapRef.current = null; };
  }, [comparisonSecondary, showingComparison, swipeActive]);

  useEffect(() => { const s = mapInstance.current?.getSource('basemap') as any; if (s?.setTiles) s.setTiles([TILE_URLS[provider]]); }, [provider]);
  useEffect(() => {
    const map = mapInstance.current; if (!map) return;
    if (drawAoi || identifyMode) {
      map.dragPan.disable(); map.scrollZoom.disable(); map.boxZoom.disable(); map.doubleClickZoom.disable(); map.getCanvas().style.cursor = 'crosshair';
    } else {
      if (panEnabled) map.dragPan.enable(); else map.dragPan.disable();
      map.scrollZoom.enable(); map.boxZoom.enable(); map.doubleClickZoom.enable(); map.getCanvas().style.cursor = '';
    }
  }, [drawAoi, identifyMode, panEnabled]);

  useEffect(() => {
    const map = mapInstance.current; if (!map || (!raster && !differenceReady)) return;
    if (map.isStyleLoaded()) syncLayers(); else map.once('load', syncLayers);
    return () => { map.off('load', syncLayers); };
  }, [lstUrl, opticalUrl, raster, differenceReady, syncLayers]);

  useEffect(() => {
    const key = raster?.fileName ?? comparisonPrimary?.id ?? '';
    if (!key || key === lastFittedKey.current) return;
    const vExt = extent ?? (comparisonPrimary ? boundsExtent(comparisonPrimary.bounds) : null);
    if (mapInstance.current && vExt) {
      lastFittedKey.current = key;
      mapInstance.current.fitBounds([[vExt.west, vExt.south], [vExt.east, vExt.north]], { padding: 70, duration: 850, maxZoom: 16 });
    }
  }, [comparisonPrimary, extent, raster]);

  useEffect(() => {
    const map = mapInstance.current; if (!map) return;
    const updateAoiLayer = () => {
      if (!map.isStyleLoaded()) return;
      const src = map.getSource('aoi-source') as maplibregl.GeoJSONSource | undefined;
      const pts = aoi.slice(0, 16).map((pt) => ({ type: 'Feature' as const, properties: {}, geometry: { type: 'Point' as const, coordinates: pt } }));
      const line = aoi.length >= 2 ? [{ type: 'Feature' as const, properties: {}, geometry: { type: 'LineString' as const, coordinates: aoi.length >= 3 ? [...aoi, aoi[0]] : aoi } }] : [];
      const poly = aoi.length >= 3 ? [{ type: 'Feature' as const, properties: {}, geometry: { type: 'Polygon' as const, coordinates: [[...aoi, aoi[0]]] } }] : [];
      const data = { type: 'FeatureCollection' as const, features: [...poly, ...line, ...pts] };
      if (src) src.setData(data as any);
      else {
        map.addSource('aoi-source', { type: 'geojson', data: data as any });
        map.addLayer({ id: 'aoi-fill', type: 'fill', source: 'aoi-source', filter: ['==', '$type', 'Polygon'], paint: { 'fill-color': '#ffb000', 'fill-opacity': 0.22 } });
        map.addLayer({ id: 'aoi-line', type: 'line', source: 'aoi-source', filter: ['==', '$type', 'LineString'], paint: { 'line-color': '#ffb000', 'line-width': 3, 'line-dasharray': [2, 1] } });
        map.addLayer({ id: 'aoi-pts', type: 'circle', source: 'aoi-source', filter: ['==', '$type', 'Point'], paint: { 'circle-radius': 5.5, 'circle-color': '#ffb000', 'circle-stroke-color': '#071317', 'circle-stroke-width': 2 } });
      }
    };
    if (map.isStyleLoaded()) updateAoiLayer(); else map.once('load', updateAoiLayer);
  }, [aoi]);

  useEffect(() => {
    if (raster) {
      setUhiSurface(buildUhiSurface({ data: raster.data, width: raster.width, height: raster.height, bounds: raster.bounds, mean: raster.stats.mean, stdDev: raster.stats.stdDev }));
      setIsotherms(buildMesoIsothermsGeoJSON(raster.data, raster.width, raster.height, raster.bounds, raster.stats, uhiMethod, uhiPower));
    } else { setUhiSurface(null); setIsotherms(null); }
  }, [raster, uhiMethod, uhiPower]);

  useEffect(() => {
    if (!raster) return;
    const canvas = document.createElement('canvas');
    if (displayMode === 'uhi') renderHighDefUhiToCanvas(raster.data, raster.width, raster.height, canvas, raster.stats, uhiMethod, uhiPower);
    else renderPerceptualLstToCanvas(raster.data, raster.width, raster.height, canvas, palette, customColors, raster.stats);
    lstCanvas.current = canvas; setLstUrl(canvas.toDataURL('image/png'));
  }, [customColors, displayMode, palette, raster, uhiMethod, uhiPower]);

  useEffect(() => {
    const map = mapInstance.current; if (!map || !isotherms) return;
    const syncIso = () => {
      if (!map.isStyleLoaded()) return;
      const src = map.getSource('uhi-surface') as maplibregl.GeoJSONSource | undefined;
      if (src) src.setData(isotherms as any);
      else {
        map.addSource('uhi-surface', { type: 'geojson', data: isotherms as any });
        map.addLayer({ id: 'uhi-surface-casing', type: 'line', source: 'uhi-surface', paint: { 'line-color': '#061014', 'line-opacity': 0.85, 'line-width': 3.4 } });
        map.addLayer({ id: 'uhi-surface-line', type: 'line', source: 'uhi-surface', paint: { 'line-color': ['get', 'color'], 'line-opacity': 0.96, 'line-width': 1.9 } });
      }
      const vis = uhiSurfaceVisible ? 'visible' : 'none';
      if (map.getLayer('uhi-surface-casing')) map.setLayoutProperty('uhi-surface-casing', 'visibility', vis);
      if (map.getLayer('uhi-surface-line')) map.setLayoutProperty('uhi-surface-line', 'visibility', vis);
    };
    if (map.isStyleLoaded()) syncIso(); else map.once('load', syncIso);
    return () => { map.off('load', syncIso); };
  }, [isotherms, uhiSurfaceVisible]);

  const handleFileChange = async (selected: File | null) => {
    setFile(selected); setError(''); setSearchResults([]); if (!selected) return;
    setStatus(lang === 'pt' ? 'Lendo bandas e metadados…' : 'Reading bands and metadata…');
    try {
      const preview = await readTiffPixels(selected);
      const count = preview.rasters.length;
      setBandCount(count); setBandLabels(preview.bandLabels);
      const std10 = preview.bandLabels.length === 10 && preview.bandLabels[2]?.includes('B04') && preview.bandLabels[6]?.includes('B08') && preview.bandLabels[8]?.includes('B11');
      setBands(std10 ? ['2', '6', '8'] : (p) => p.map((v, i) => (Number(v) < count ? v : String(Math.max(0, count - 1 - i)))));
      setStatus(`${count} bandas detectadas.`);
    } catch { setError('Não foi possível ler este GeoTIFF.'); setStatus(''); }
  };

  const clearMainAnalysis = () => {
    setRaster(null); setFile(null); setLstUrl(null); setOpticalUrl(null);
    setAoi([]); setAoiAnchor(null); setAoiStats(null); setAoiDetailed(null); setShowAoiModal(false);
    setSample(null); setHoverSample(null);
    setUhiSurface(null); setIsotherms(null); setUhiSurfaceVisible(false);
    setProcessingLog([]); setStatus('Produto principal limpo.');
    const map = mapInstance.current;
    if (map) for (const id of ['lst-layer', 'optical-layer', 'uhi-surface-line', 'uhi-surface-casing']) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
  };

  const clearComparisonAnalysis = () => {
    setComparisonImages([]); setComparisonFiles(Array.from({ length: comparisonCount }, () => null));
    setDifferenceReady(false); setSwipeActive(false); setComparisonMode('main');
    setSample(null); setHoverSample(null);
    setStatus(raster ? 'Comparação limpa · Exibindo mapa principal.' : 'Comparação limpa.');
  };

  const calculateComparisons = async () => {
    const selected = comparisonFiles.filter((it): it is File => Boolean(it));
    if (selected.length < 2) { setError('Selecione pelo menos duas imagens.'); return; }
    setBusy(true); setError(''); setDifferenceReady(false); setComparisonMode('difference');
    const loaded: ComparisonImage[] = [];
    for (let i = 0; i < selected.length; i += 1) {
      const sf = selected[i]; setStatus(`Processando ${sf.name}…`);
      try {
        const auto = await buildAutomaticThermalRaster(sf, [Number(bands[0]), Number(bands[1]), Number(bands[2])]);
        const lst = document.createElement('canvas'); const opt = document.createElement('canvas');
        const stats = renderPerceptualLstToCanvas(auto.result.lstDownscaled, auto.tiff.width, auto.tiff.height, lst, palette, customColors);
        renderRGBBasemapToCanvas(auto.tiff.rasters[Number(bands[2])] as Float32Array, auto.tiff.rasters[Number(bands[1])] as Float32Array, auto.tiff.rasters[Number(bands[0])] as Float32Array, auto.tiff.width, auto.tiff.height, opt);
        if (!stats) continue;
        const uhi = buildUhiSurface({ data: auto.result.lstDownscaled, width: auto.tiff.width, height: auto.tiff.height, bounds: auto.bounds, mean: stats.mean, stdDev: stats.stdDev });
        loaded.push({ id: `${sf.name}-${sf.lastModified}-${i}`, name: sf.name, dateLabel: imageDateLabel(sf.name, i), lstUrl: lst.toDataURL('image/png'), opticalUrl: opt.toDataURL('image/png'), uhiSurface: uhi, bounds: auto.bounds, width: auto.tiff.width, height: auto.tiff.height, data: auto.result.lstDownscaled, stats });
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
      } catch { /* ignore */ }
    }
    setComparisonImages(loaded); setDifferenceReady(loaded.length >= 2);
    if (loaded.length < 2) setError('Falha ao processar o par de imagens.'); else setStatus('Diferença térmica pronta.');
    setBusy(false);
  };

  const drawLegend = (ctx: CanvasRenderingContext2D, x: number, y: number) => {
    const w = Math.min(760, Math.max(360, ctx.canvas.width - x - 24)); const pad = 26;
    ctx.fillStyle = 'rgba(7,19,23,.96)'; ctx.fillRect(x, y, w, 180);
    ctx.strokeStyle = 'rgba(121,226,220,.7)'; ctx.lineWidth = 3; ctx.strokeRect(x, y, w, 180);
    ctx.fillStyle = '#fff'; ctx.font = '700 26px Arial';
    ctx.fillText(displayMode === 'uhi' ? 'UHI · ILHA DE CALOR (1m)' : 'LST · TEMPERATURA (°C)', x + pad, y + 42);
    const grad = ctx.createLinearGradient(x + pad, y + 84, x + w - pad, y + 84);
    for (let s = 0; s <= 16; s += 1) grad.addColorStop(s / 16, sampleCssColorAt(s / 16, palette, draftCustomColors, displayMode === 'uhi'));
    ctx.fillStyle = grad; ctx.fillRect(x + pad, y + 66, w - pad * 2, 36);
    ctx.fillStyle = '#fff'; ctx.font = '600 19px Arial';
    ctx.fillText(`${raster?.stats.min.toFixed(1) ?? '—'} °C`, x + pad, y + 138);
    ctx.textAlign = 'center'; ctx.fillText(`Média: ${raster?.stats.mean.toFixed(1) ?? '—'} °C`, x + w / 2, y + 138);
    ctx.textAlign = 'right'; ctx.fillText(`${raster?.stats.max.toFixed(1) ?? '—'} °C`, x + w - pad, y + 138); ctx.textAlign = 'left';
  };

  const exportPng = () => {
    if (!lstCanvas.current || !opticalCanvas.current) return;
    const c = document.createElement('canvas'); c.width = lstCanvas.current.width; c.height = lstCanvas.current.height + 200;
    const ctx = c.getContext('2d'); if (!ctx) return;
    ctx.fillStyle = '#071317'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(opticalCanvas.current, 0, 0); ctx.globalAlpha = opacity; ctx.drawImage(lstCanvas.current, 0, 0); ctx.globalAlpha = 1;
    drawLegend(ctx, 16, c.height - 190);
    const a = document.createElement('a'); a.href = c.toDataURL('image/png'); a.download = `SR2D4-${displayMode}-${palette}.png`; a.click();
  };

  const exportVectorIsotherms = (format: 'geojson' | 'kml') => {
    if (!isotherms) return;
    if (format === 'geojson') {
      const b = new Blob([JSON.stringify(isotherms, null, 2)], { type: 'application/geo+json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'SR2D4-Isotermas-Meso.geojson'; a.click(); URL.revokeObjectURL(a.href);
    } else {
      const pm = isotherms.features.map((f) => {
        const lns = f.geometry.coordinates.map((seg) => `<LineString><coordinates>${seg.map((c) => `${c[0]},${c[1]},0`).join(' ')}</coordinates></LineString>`).join('');
        return `<Placemark><name>${f.properties.label}</name><Style><LineStyle><color>${f.properties.kmlColor}</color><width>2.5</width></LineStyle></Style><MultiGeometry>${lns}</MultiGeometry></Placemark>`;
      }).join('');
      const kml = `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>SR2D4 Isotermas</name>${pm}</Document></kml>`;
      const b = new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'SR2D4-Isotermas-Meso.kml'; a.click(); URL.revokeObjectURL(a.href);
    }
  };

  const processFile = async (selectedFile: File = file as File) => {
    if (!selectedFile) return;
    const addLog = (message: string, level: 'info' | 'success' | 'error' = 'info') => {
      setProcessingLog((p) => [...p.slice(-99), { time: new Date().toLocaleTimeString('pt-BR'), message, level }]); setStatus(message);
    };
    setProcessingLog([]); setBusy(true); setError(''); addLog(`Iniciando: ${selectedFile.name}`);
    try {
      const auto = await buildAutomaticThermalRaster(selectedFile, [Number(bands[0]), Number(bands[1]), Number(bands[2])], addLog);
      const lst = document.createElement('canvas'); const opt = document.createElement('canvas');
      const stats = renderPerceptualLstToCanvas(auto.result.lstDownscaled, auto.tiff.width, auto.tiff.height, lst, palette, customColors);
      if (displayMode === 'uhi' && stats) renderHighDefUhiToCanvas(auto.result.lstDownscaled, auto.tiff.width, auto.tiff.height, lst, stats, uhiMethod, uhiPower);
      renderRGBBasemapToCanvas(auto.tiff.rasters[Number(bands[2])] as Float32Array, auto.tiff.rasters[Number(bands[1])] as Float32Array, auto.tiff.rasters[Number(bands[0])] as Float32Array, auto.tiff.width, auto.tiff.height, opt);
      if (!stats) throw new Error('empty raster');
      lstCanvas.current = lst; opticalCanvas.current = opt;
      setRaster({ data: auto.result.lstDownscaled, width: auto.tiff.width, height: auto.tiff.height, bounds: auto.bounds, origin: auto.tiff.origin, resolution: auto.tiff.resolution, epsg: auto.tiff.epsg, isProjected: auto.tiff.isProjected, stats, ndvi: auto.indices.ndvi, ndbi: auto.indices.ndbi, fileName: `${selectedFile.name} · ${auto.landsat.itemId}`, bands: auto.tiff.rasters.length });
      setComparisonMode('main'); setSwipeActive(false);
      setAoi([]); setAoiAnchor(null); setAoiStats(null); setAoiDetailed(null);
      setLstUrl(lst.toDataURL('image/png')); setOpticalUrl(opt.toDataURL('image/png')); addLog(t.ready, 'success');
    } catch (e) {
      const msg = e instanceof Error ? e.message : t.error; setError(msg); addLog(msg, 'error');
    } finally { setBusy(false); }
  };

  const colorTempHistogram = useMemo(() => {
    if (!raster) return [];
    const nB = 24; const bins = Array.from({ length: nB }, () => 0);
    const span = raster.stats.max - raster.stats.min || 1; let total = 0;
    for (let i = 0; i < raster.data.length; i += 2) {
      const v = raster.data[i]; if (!Number.isFinite(v)) continue;
      bins[Math.max(0, Math.min(nB - 1, Math.floor(((v - raster.stats.min) / span) * nB)))] += 1; total += 1;
    }
    const peak = Math.max(bins.reduce((m, v) => Math.max(m, v), 0), 1);
    return bins.map((c, i) => {
      const t0 = raster.stats.min + (span * i) / nB; const t1 = raster.stats.min + (span * (i + 1)) / nB;
      const pct = total > 0 ? ((c / total) * 100).toFixed(1) : '0.0';
      return { height: Math.max(6, Math.pow(c / peak, 0.78) * 100), tempLabel: `${t0.toFixed(1)}°C – ${t1.toFixed(1)}°C (${pct}%)`, color: sampleCssColorAt((i + 0.5) / nB, palette, draftCustomColors, displayMode === 'uhi') };
    });
  }, [displayMode, draftCustomColors, palette, raster]);

  const downloadComparisonPanel = async () => {
    if (!comparisonPrimary || !comparisonSecondary || !differenceRender || !differenceStats) return;
    const load = (u: string) => new Promise<HTMLImageElement>((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = u; });
    const [a, b, d] = await Promise.all([load(comparisonPrimary.lstUrl), load(comparisonSecondary.lstUrl), load(differenceRender.url)]);
    const w = 740; const iH = Math.round((w * a.height) / a.width); const legH = 166;
    const c = document.createElement('canvas'); c.width = w * 3; c.height = iH + legH + 62;
    const ctx = c.getContext('2d'); if (!ctx) return;
    ctx.fillStyle = '#071317'; ctx.fillRect(0, 0, c.width, c.height);
    const panels = [
      { im: a, lbl: `ANTES · ${comparisonPrimary.dateLabel} (LST °C)`, st: comparisonPrimary.stats },
      { im: b, lbl: `DEPOIS · ${comparisonSecondary.dateLabel} (LST °C)`, st: comparisonSecondary.stats },
      { im: d, lbl: `DIFERENÇA ΔLST (DEPOIS − ANTES) · ±1σ = ±${differenceStats.thresholdSigma.toFixed(2)}°C`, st: null },
    ];
    panels.forEach((p, idx) => {
      const x = idx * w; const lx = x + 14; const lw = w - 28; const ly = iH + 50;
      ctx.fillStyle = '#fff'; ctx.font = '700 22px Arial'; ctx.textAlign = 'center';
      ctx.fillText(p.lbl, x + w / 2, 36); ctx.textAlign = 'left';
      ctx.drawImage(p.im, lx, 50, lw, iH - 14);
      ctx.strokeStyle = 'rgba(121,226,220,0.45)'; ctx.lineWidth = 2; ctx.strokeRect(lx, 50, lw, iH - 14);
      ctx.fillStyle = '#0d1f26'; ctx.fillRect(lx, ly, lw, legH - 14); ctx.strokeRect(lx, ly, lw, legH - 14);
      if (p.st) {
        ctx.fillStyle = '#79e2dc'; ctx.font = '700 16px Arial'; ctx.fillText(`ESCALA TÉRMICA (${palette.toUpperCase()})`, lx + 16, ly + 26);
        const grad = ctx.createLinearGradient(lx + 16, ly + 40, lx + lw - 16, ly + 40);
        for (let s = 0; s <= 16; s += 1) grad.addColorStop(s / 16, sampleCssColorAt(s / 16, palette, draftCustomColors, false));
        ctx.fillStyle = grad; ctx.fillRect(lx + 16, ly + 40, lw - 32, 24);
        ctx.fillStyle = '#fff'; ctx.font = '700 16px Arial';
        ctx.fillText(`Mín: ${p.st.min.toFixed(1)}°C`, lx + 16, ly + 92);
        ctx.textAlign = 'center'; ctx.fillText(`Média: ${p.st.mean.toFixed(1)}°C (σ=${p.st.stdDev.toFixed(2)}°C)`, lx + lw / 2, ly + 92);
        ctx.textAlign = 'right'; ctx.fillText(`Máx: ${p.st.max.toFixed(1)}°C`, lx + lw - 16, ly + 92); ctx.textAlign = 'left';
        ctx.fillStyle = '#9ab0b5'; ctx.font = '14px Arial';
        ctx.fillText(`Q25: ${p.st.q25.toFixed(1)}°C · Mediana: ${p.st.q50.toFixed(1)}°C · Q75: ${p.st.q75.toFixed(1)}°C`, lx + 16, ly + 124);
      } else {
        const sig = differenceStats.thresholdSigma;
        ctx.fillStyle = '#ffb000'; ctx.font = '700 16px Arial';
        ctx.fillText(`MUDANÇA TÉRMICA (±1σ = ±${sig.toFixed(2)}°C · ΔMédio = ${differenceStats.mean >= 0 ? '+' : ''}${differenceStats.mean.toFixed(2)}°C)`, lx + 16, ly + 26);
        const grad = ctx.createLinearGradient(lx + 16, ly + 40, lx + lw - 16, ly + 40);
        grad.addColorStop(0, '#023e8a'); grad.addColorStop(0.24, '#0096c7'); grad.addColorStop(0.36, '#48cae4');
        grad.addColorStop(0.37, '#45525a'); grad.addColorStop(0.63, '#526069'); grad.addColorStop(0.64, '#f77f00');
        grad.addColorStop(0.84, '#d62828'); grad.addColorStop(1, '#ffea00');
        ctx.fillStyle = grad; ctx.fillRect(lx + 16, ly + 40, lw - 32, 24);
        ctx.font = '700 16px Arial'; ctx.fillStyle = '#48cae4';
        ctx.fillText(`↓ Diminuiu: ${differenceStats.pctDecreased.toFixed(1)}%`, lx + 16, ly + 92);
        ctx.textAlign = 'center'; ctx.fillStyle = '#cbd5e1';
        ctx.fillText(`＝ Igual (±1σ): ${differenceStats.pctEqual.toFixed(1)}%`, lx + lw / 2, ly + 92);
        ctx.textAlign = 'right'; ctx.fillStyle = '#ff9e00';
        ctx.fillText(`↑ Aumentou: ${differenceStats.pctIncreased.toFixed(1)}%`, lx + lw - 16, ly + 92); ctx.textAlign = 'left';
        ctx.fillStyle = '#9ab0b5'; ctx.font = '14px Arial';
        ctx.fillText(`Variação: ${differenceStats.min.toFixed(1)}°C a +${differenceStats.max.toFixed(1)}°C · Destaque estatístico acima de ±1σ.`, lx + 16, ly + 124);
      }
    });
    const lnk = document.createElement('a'); lnk.href = c.toDataURL('image/png'); lnk.download = `SR2D4-Comparacao-${comparisonPrimary.dateLabel}-${comparisonSecondary.dateLabel}.png`; lnk.click();
  };

  // GERADOR DO RELATÓRIO TÉCNICO EXPANDIDO (MODELO SR2D4_relatorio_modelo_expandido.html + MAPAS LST & UHI + BOTÃO PT/EN)
  const downloadReport = async () => {
    if (!raster || !opticalCanvas.current) return;
    setStatus('Calculando matrizes numéricas, mapas LST/UHI e feições OpenStreetMap para o relatório…');
    const osm = await fetchOsmUrbanFeatures(raster);

    const tempCanvas = document.createElement('canvas');
    renderPerceptualLstToCanvas(raster.data, raster.width, raster.height, tempCanvas, palette, customColors, raster.stats);
    const uhiCanvas = document.createElement('canvas');
    renderHighDefUhiToCanvas(raster.data, raster.width, raster.height, uhiCanvas, raster.stats, uhiMethod, uhiPower);

    const lstMapImg = renderMapWithFooterLegend(
      opticalCanvas.current, tempCanvas, opacity,
      `MAPA 01 · TEMPERATURA DE SUPERFÍCIE (LST °C) · PALETA ${palette.toUpperCase()} · EPSG:${raster.epsg}`,
      false, raster.stats, palette, customColors,
    );
    const uhiMapImg = renderMapWithFooterLegend(
      opticalCanvas.current, uhiCanvas, opacity,
      `MAPA 02 · CLASSES DE ILHA DE CALOR URBANA (UHI 1m · MÉTODO ${uhiMethod.toUpperCase()}) · EPSG:${raster.epsg}`,
      true, raster.stats, palette, customColors,
    );

    let valid = 0; let noData = 0;
    let veg = 0; let built = 0; let water = 0; let mixed = 0; let overlapVB = 0; let specValid = 0;
    let above31 = 0; let aboveHot = 0;
    const hotspotLim = raster.stats.mean + 1.5 * raster.stats.stdDev;
    const uhiCnt = [0, 0, 0, 0, 0, 0];
    const nBins = 12; const histBins = new Array<number>(nBins).fill(0);
    const span = Math.max(0.1, raster.stats.max - raster.stats.min);

    for (let i = 0; i < raster.data.length; i += 1) {
      const v = raster.data[i];
      if (!Number.isFinite(v)) { noData += 1; continue; }
      valid += 1;
      if (v > 31.0) above31 += 1;
      if (v >= hotspotLim) aboveHot += 1;
      histBins[Math.max(0, Math.min(nBins - 1, Math.floor(((v - raster.stats.min) / span) * nBins)))] += 1;
      const z = computeClusteredZ(v, v, raster.stats, uhiMethod, uhiPower);
      if (z < -0.95) uhiCnt[0] += 1;
      else if (z < -0.3) uhiCnt[1] += 1;
      else if (z < 0.25) uhiCnt[2] += 1;
      else if (z < 0.85) uhiCnt[3] += 1;
      else if (z < 1.4) uhiCnt[4] += 1;
      else uhiCnt[5] += 1;
      const ndvi = raster.ndvi[i]; const ndbi = raster.ndbi[i];
      if (Number.isFinite(ndvi) && Number.isFinite(ndbi)) {
        specValid += 1;
        if (ndvi > 0.3 && ndbi > 0.1) overlapVB += 1;
        if (ndvi > 0.3) veg += 1;
        else if (ndvi < 0 && ndbi < 0) water += 1;
        else if (ndbi > 0.1) built += 1;
        else mixed += 1;
      }
    }

    const resX = Math.abs(raster.resolution[0] || 1);
    const resY = Math.abs(raster.resolution[1] || 1);
    const pxM2 = raster.isProjected ? resX * resY : resX * 111320 * (resY * 110540);
    const areaHa = (valid * pxM2) / 10000;
    const areaKm2 = areaHa / 100;
    const pct = (n: number, d = valid) => (d > 0 ? ((n / d) * 100).toFixed(1) : '0.0');
    const ha = (n: number) => ((n * pxM2) / 10000).toFixed(2);
    const strongExtPct = (((uhiCnt[4] + uhiCnt[5]) / Math.max(1, valid)) * 100).toFixed(1);

    const dateMatches = Array.from(raster.fileName.matchAll(/(20\d{2})[-_]?([01]\d)[-_]?([0-3]\d)/g)).map((m) => `${m[1]}-${m[2]}-${m[3]}`);
    const uniqueDates = [...new Set(dateMatches)];
    const dateOpt = uniqueDates[0] ?? 'Data 1';
    const dateTherm = uniqueDates[1] ?? uniqueDates[0] ?? 'Sincronizada STAC';
    const daysGap = uniqueDates.length >= 2 ? Math.round(Math.abs(Date.parse(uniqueDates[1]) - Date.parse(uniqueDates[0])) / 86400000) : null;
    const issueDate = new Date().toLocaleDateString('pt-BR');

    const uhiMeta = [
      { pt: 'Ilha de frescor (< -0,95σ)', en: 'Cool island (< -0.95σ)', c: '#103e8a' },
      { pt: 'Zona amenizada (-0,95σ a -0,30σ)', en: 'Mitigated zone (-0.95σ to -0.30σ)', c: '#2ba198' },
      { pt: 'Zona neutra (-0,30σ a +0,25σ)', en: 'Neutral zone (-0.30σ to +0.25σ)', c: '#68c96e' },
      { pt: 'UHI moderada (+0,25σ a +0,85σ)', en: 'Moderate UHI (+0.25σ to +0.85σ)', c: '#f1b64a' },
      { pt: 'UHI forte (+0,85σ a +1,40σ)', en: 'Strong UHI (+0.85σ to +1.40σ)', c: '#e86825' },
      { pt: 'Hotspot extremo (> +1,40σ)', en: 'Extreme hotspot (> +1.40σ)', c: '#c84638' },
    ];

    const uhiBars = uhiMeta.map((m, i) => `<div class="bar-row"><div class="bar-label"><span data-pt="${m.pt}" data-en="${m.en}">${m.pt}</span><b>${pct(uhiCnt[i])}% · ${ha(uhiCnt[i])} ha (${uhiCnt[i].toLocaleString('pt-BR')} px)</b></div><div class="bar-track"><div class="bar-fill" style="width:${Math.max(1.5, Number(pct(uhiCnt[i])))}%;background:${m.c}"></div></div></div>`).join('');
    const histBars = histBins.map((cnt, i) => {
      const t0 = raster.stats.min + (span * i) / nBins; const t1 = raster.stats.min + (span * (i + 1)) / nBins;
      const p = pct(cnt); const col = i < 3 ? '#1d817e' : i < 6 ? '#27765e' : i < 9 ? '#f1b64a' : '#c84638';
      return `<div class="bar-row" style="margin:8px 0"><div class="bar-label"><span>${t0.toFixed(1)} °C – ${t1.toFixed(1)} °C</span><b>${p}% (${cnt.toLocaleString('pt-BR')} px · ${ha(cnt)} ha)</b></div><div class="bar-track"><div class="bar-fill" style="width:${Math.max(1, Number(p))}%;background:${col}"></div></div></div>`;
    }).join('');

    const bairrosHtml = osm.bairros.length
      ? `<table><thead><tr><th data-pt="Bairro / ID Real OSM" data-en="Neighborhood / Real OSM ID">Bairro / ID Real OSM</th><th data-pt="LST Média" data-en="Mean LST">LST Média</th><th data-pt="Mediana / Máx" data-en="Median / Max">Mediana / Máx</th><th data-pt="% Acima Limiar" data-en="% Above Threshold">% Acima Limiar</th><th>NDVI / NDBI</th><th data-pt="Operação Espacial" data-en="Spatial Operation">Operação Espacial</th></tr></thead><tbody>${osm.bairros.map((b) => `<tr><td><strong>${b.name}</strong> <code>${b.id}</code></td><td><b>${b.meanTemp.toFixed(2)} °C</b></td><td>${b.medianTemp.toFixed(2)} °C / ${b.maxTemp.toFixed(1)} °C</td><td>${b.hotPct.toFixed(1)}%</td><td>${b.ndvi.toFixed(3)} / ${b.ndbi.toFixed(3)}</td><td>Janela zonal 37×37 px (${b.samples} px)</td></tr>`).join('')}</tbody></table>`
      : `<div class="callout red"><strong data-pt="Bairros — Não calculado (dados poligonais ausentes):" data-en="Neighborhoods — Not calculated (polygon data missing):">Bairros — Não calculado (dados poligonais ausentes):</strong><span data-pt=" Nenhuma feição de bairro foi retornada para esta extensão. Forneça o shapefile/GeoJSON oficial de bairros para estatística zonal completa." data-en=" No neighborhood features returned for this extent. Provide official neighborhood polygons for full zonal statistics."> Nenhuma feição de bairro foi retornada para esta extensão. Forneça o shapefile/GeoJSON oficial de bairros para estatística zonal completa.</span></div>`;

    const viasHtml = osm.vias.length
      ? `<table><thead><tr><th data-pt="Ranking & Rua / ID Real OSM" data-en="Rank & Street / Real OSM ID">Ranking &amp; Rua / ID Real OSM</th><th data-pt="LST Média" data-en="Mean LST">LST Média</th><th data-pt="LST Máxima" data-en="Max LST">LST Máxima</th><th data-pt="% em Classe Quente" data-en="% in Hot Class">% em Classe Quente</th><th>NDVI / NDBI</th><th data-pt="Operação Espacial" data-en="Spatial Operation">Operação Espacial</th></tr></thead><tbody>${osm.vias.map((v, i) => `<tr><td><strong>#${i + 1} · ${v.name}</strong> <code>${v.id}</code> (${v.highway})</td><td><b>${v.meanTemp.toFixed(2)} °C</b></td><td>${v.maxTemp.toFixed(1)} °C</td><td>${v.hotPct.toFixed(1)}%</td><td>${v.ndvi.toFixed(3)} / ${v.ndbi.toFixed(3)}</td><td>Interseção buffer 9×9 m no raster numérico (${v.samples} px)</td></tr>`).join('')}</tbody></table>`
      : `<div class="callout red"><strong data-pt="Ruas — Não calculado (eixos viários ausentes):" data-en="Streets — Not calculated (road centerlines missing):">Ruas — Não calculado (eixos viários ausentes):</strong><span data-pt=" Nenhum segmento viário retornado na consulta atual." data-en=" No road segments returned in current query."> Nenhum segmento viário retornado na consulta atual.</span></div>`;

    const aoiReportBlock = aoiDetailed
      ? `<div class="callout blue"><strong data-pt="Recorte AOI (${aoiDetailed.shapeMode}) analisado no raster numérico:" data-en="AOI Clip (${aoiDetailed.shapeMode}) analyzed on numerical raster:">Recorte AOI (${aoiDetailed.shapeMode}) analisado no raster numérico:</strong><span> ${aoiDetailed.count.toLocaleString('pt-BR')} px (${aoiDetailed.areaHa.toFixed(2)} ha) · Mín: <b>${aoiDetailed.min.toFixed(1)} °C</b> · Média: <b>${aoiDetailed.mean.toFixed(2)} °C</b> · Mediana: <b>${aoiDetailed.q50.toFixed(2)} °C</b> · Máx: <b>${aoiDetailed.max.toFixed(1)} °C</b> · NDVI: ${aoiDetailed.ndviMean.toFixed(3)} · NDBI: ${aoiDetailed.ndbiMean.toFixed(3)}.</span></div>`
      : '';

    const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SR2D4 | Diagnóstico Térmico e Urbano (${raster.fileName})</title>
<style>
:root{--navy:#10213b;--navy2:#192f50;--teal:#1d817e;--ink:#172b42;--muted:#65758a;--line:#dbe3ec;--paper:#ffffff;--bg:#eef2f7;--amber:#f1b64a;--red:#c84638;--green:#27765e;--radius:16px;--shadow:0 10px 32px rgba(16,33,59,.07)}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.58 Inter,system-ui,-apple-system,Arial,sans-serif}
.page{max-width:1240px;margin:0 auto;padding:26px 24px 60px}
.topline{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px;color:#5e6d82;font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:10px}.brand-mark{width:34px;height:34px;border-radius:10px;background:linear-gradient(145deg,#36a9a2,#175f79);display:grid;place-items:center;color:#fff;font-weight:900}
.report-tag{border:1px solid #cbd6e2;border-radius:999px;padding:6px 12px;background:#fff;color:#40516a}
.lang-btn{border:2px solid #1d817e;background:#e7f3f1;color:#10213b;border-radius:999px;padding:7px 16px;font-weight:800;font-size:12px;cursor:pointer}
.hero{background:linear-gradient(115deg,var(--navy) 0%,#173658 66%,#176d75 100%);border-radius:24px;padding:34px 38px;color:#fff;box-shadow:var(--shadow)}
.eyebrow{font-size:11px;letter-spacing:.18em;text-transform:uppercase;font-weight:800;color:#9cddda;margin-bottom:12px}
h1{font-size:clamp(30px,3.8vw,46px);line-height:1.08;margin:0 0 14px;font-weight:780}
.hero p{margin:0;max-width:780px;color:#d6e4f1;font-size:16.5px}
.hero-meta{display:flex;flex-wrap:wrap;gap:8px;margin-top:22px}.hero-meta span{border:1px solid #ffffff30;background:#ffffff0e;padding:7px 10px;border-radius:9px;color:#e7f1f8;font-size:12px}
.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:24px}
.btn{display:inline-flex;align-items:center;gap:8px;border:1px solid #ffffff45;border-radius:10px;padding:10px 14px;font-weight:750;font-size:13px;color:#fff;background:#ffffff12;cursor:pointer;text-decoration:none}
.btn.primary{background:#e6f8f5;color:#10384a;border-color:#e6f8f5}
.nav{position:sticky;top:0;z-index:20;margin:16px 0 22px;padding:10px 12px;background:#ffffffed;backdrop-filter:blur(8px);border:1px solid var(--line);border-radius:13px;display:flex;gap:7px;overflow:auto}
.nav a{white-space:nowrap;font-size:12px;font-weight:750;color:#42546a;padding:7px 10px;border-radius:8px;text-decoration:none}
.section{scroll-margin-top:82px;margin-top:26px}.section-head{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;margin:0 0 14px;flex-wrap:wrap}
.section-kicker{font-size:11px;font-weight:850;letter-spacing:.15em;color:var(--teal);text-transform:uppercase;margin-bottom:5px}
h2{margin:0;color:var(--navy);font-size:clamp(22px,2.4vw,29px)}h3{margin:0 0 9px;font-size:17px;color:var(--navy)}.section-desc{margin:5px 0 0;color:var(--muted);max-width:820px;font-size:13px}
.card{background:var(--paper);border:1px solid var(--line);border-radius:var(--radius);padding:22px;box-shadow:var(--shadow)}
.grid-4{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:13px}.grid-2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.two-col{display:grid;grid-template-columns:1.05fr .95fr;gap:14px}
.metric{padding:19px 20px;min-height:134px}.metric-label{font-size:12px;font-weight:750;color:var(--muted)}.metric-value{margin-top:9px;font-size:clamp(24px,2.8vw,33px);color:var(--navy);font-weight:800}.metric-unit{font-size:14px;color:#50647a}.metric-note{margin-top:8px;font-size:11px;color:#6b7a8e}
.chip{display:inline-flex;padding:5px 10px;border-radius:999px;font-size:11px;font-weight:800}.chip.ok{background:#e5f4ee;color:#1c7058}.chip.pending{background:#fff3d7;color:#875d11}.chip.info{background:#e8f1f8;color:#365a7a}.chip.warn{background:#fdebe7;color:#a53e31}
.insight-list{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:14px}.insight{background:#fff;border:1px solid var(--line);border-radius:13px;padding:17px}.insight .number{font-size:23px;font-weight:850;color:var(--teal)}.insight p{margin:6px 0 0;font-size:13px;color:#596a7f}
.map-frame{background:#0f2238;border-radius:15px;padding:10px;overflow:hidden}.map-frame img{display:block;width:100%;height:auto;border-radius:8px}.map-caption{display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;padding:10px 4px 2px;color:#d8e6f1;font-size:12px}
.callout{border-left:4px solid var(--amber);background:#fff7e7;padding:14px 16px;border-radius:0 10px 10px 0;color:#654d27;font-size:13px;margin-top:13px}.callout.blue{background:#eaf4f7;border-color:#3989a1;color:#34566a}.callout.red{background:#fff0ed;border-color:#d2604f;color:#7a3b31}
.bar-row{margin:12px 0}.bar-label{display:flex;justify-content:space-between;gap:12px;font-size:13px;font-weight:700}.bar-track{height:10px;margin-top:6px;background:#edf1f5;border-radius:99px;overflow:hidden}.bar-fill{height:100%;border-radius:99px}
.chart-legend{display:flex;flex-wrap:wrap;gap:12px;margin-top:14px;padding-top:10px;border-top:1px solid #e7edf3;color:#63748a;font-size:11px}
.stat-list{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:12px}.stat-item{padding:10px;border:1px solid #e2e8ef;border-radius:10px;background:#fafbfd}.stat-item span{display:block;color:#748195;font-size:11px;font-weight:700}.stat-item b{font-size:17px;color:var(--navy)}
.table-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:12px;background:#fff}table{border-collapse:collapse;width:100%;min-width:650px;font-size:12px}th{background:#f1f5f8;color:#43566b;text-align:left;font-size:11px;text-transform:uppercase;font-weight:850}th,td{padding:11px 12px;border-bottom:1px solid #e5ebf1}
.tag{display:inline-flex;border-radius:6px;padding:4px 7px;font-size:10px;font-weight:850}.tag.available{background:#e4f4ed;color:#247255}.tag.pending{background:#fff1d6;color:#8b6114}
.theme-card{padding:20px;display:flex;flex-direction:column;gap:10px}.theme-icon{display:grid;place-items:center;width:42px;height:42px;border-radius:12px;background:#e8f3f4;font-size:20px}
.action-row{display:grid;grid-template-columns:110px 1fr;gap:16px;border-bottom:1px solid #e7edf2;padding:14px 0}.priority{align-self:start;text-align:center;border-radius:8px;padding:7px 8px;font-size:11px;font-weight:850;background:#edf5f1;color:#24694f}.priority.p1{background:#fff0d8;color:#8b5a11}.priority.p2{background:#eaf1fb;color:#375b93}
.footer{margin-top:28px;background:#10213b;color:#d6e3ee;border-radius:17px;padding:24px 28px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:16px}
code{background:#edf2f6;padding:2px 5px;border-radius:4px;font-size:11px}
@media(max-width:900px){.grid-4,.grid-2,.two-col,.insight-list{grid-template-columns:1fr}}
@media print{.nav,.actions,.lang-btn{display:none!important}body{background:#fff}.page{max-width:none;padding:0}}
</style>
</head>
<body>
<div class="page">
  <div class="topline">
    <div class="brand"><div class="brand-mark">S4</div><span>SR2D4 · Geospatial Intelligence</span></div>
    <div style="display:flex;gap:10px;align-items:center">
      <button class="lang-btn" id="lang-btn" onclick="toggleReportLang()">🇬🇧 Switch to English (EN)</button>
      <span class="report-tag" data-pt="RELATÓRIO TÉCNICO · MODELO EXPANDIDO" data-en="TECHNICAL REPORT · EXPANDED MODEL">RELATÓRIO TÉCNICO · MODELO EXPANDIDO</span>
    </div>
  </div>

  <header class="hero">
    <div class="eyebrow" data-pt="Diagnóstico térmico e inteligência territorial" data-en="Thermal diagnostics and territorial intelligence">Diagnóstico térmico e inteligência territorial</div>
    <h1 data-pt="Temperatura de superfície e ambiente urbano" data-en="Land surface temperature and urban environment">Temperatura de superfície e ambiente urbano</h1>
    <p data-pt="Relatório técnico auditável gerado diretamente do raster numérico GeoTIFF (1 m), com mapas de Temperatura (LST) e Ilhas de Calor (UHI), análise espectral NDVI/NDBI, recortes por bairro e rua e painel integrado urbano-saúde-ambiental." data-en="Auditable technical report generated directly from the numerical GeoTIFF raster (1 m), featuring Temperature (LST) and Urban Heat Island (UHI) maps, NDVI/NDBI spectral analysis, neighborhood and street breakdowns, and an integrated urban-health-environmental panel.">Relatório técnico auditável gerado diretamente do raster numérico GeoTIFF (1 m), com mapas de Temperatura (LST) e Ilhas de Calor (UHI), análise espectral NDVI/NDBI, recortes por bairro e rua e painel integrado urbano-saúde-ambiental.</p>
    <div class="hero-meta">
      <span data-pt="Produto: LST refinada (${resX.toFixed(2)} m)" data-en="Product: Refined LST (${resX.toFixed(2)} m)">Produto: LST refinada (${resX.toFixed(2)} m)</span>
      <span>CRS: EPSG:${raster.epsg}</span>
      <span>Raster: ${raster.width.toLocaleString('pt-BR')} × ${raster.height.toLocaleString('pt-BR')} px (${valid.toLocaleString('pt-BR')} válidos)</span>
      <span data-pt="Área válida: ${areaHa.toFixed(2)} ha (${areaKm2.toFixed(2)} km²)" data-en="Valid area: ${areaHa.toFixed(2)} ha (${areaKm2.toFixed(2)} km²)">Área válida: ${areaHa.toFixed(2)} ha (${areaKm2.toFixed(2)} km²)</span>
      <span data-pt="Emissão: ${issueDate}" data-en="Issued: ${issueDate}">Emissão: ${issueDate}</span>
    </div>
    <div class="actions">
      <button class="btn primary" onclick="window.print()" data-pt="⇩ Imprimir / salvar em PDF" data-en="⇩ Print / save as PDF">⇩ Imprimir / salvar em PDF</button>
      <button class="btn" onclick="toggleReportLang()" data-pt="🌐 Traduzir Português / Inglês" data-en="🌐 Switch English / Portuguese">🌐 Traduzir Português / Inglês</button>
      <a class="btn" href="#bairros-ruas" data-pt="Ver Bairros e Ranking de Ruas →" data-en="View Neighborhoods & Street Ranking →">Ver Bairros e Ranking de Ruas →</a>
    </div>
  </header>

  <nav class="nav">
    <a href="#resumo" data-pt="01. Resumo" data-en="01. Summary">01. Resumo</a>
    <a href="#metadados" data-pt="02. Metadados & Datas" data-en="02. Metadata & Dates">02. Metadados &amp; Datas</a>
    <a href="#mapas" data-pt="03. Mapas LST & UHI" data-en="03. LST & UHI Maps">03. Mapas LST &amp; UHI</a>
    <a href="#classes" data-pt="04. Distribuição & UHI" data-en="04. Distribution & UHI">04. Distribuição &amp; UHI</a>
    <a href="#espectral" data-pt="05. NDVI & NDBI" data-en="05. NDVI & NDBI">05. NDVI &amp; NDBI</a>
    <a href="#bairros-ruas" data-pt="06. Bairros & Ruas" data-en="06. Neighborhoods & Streets">06. Bairros &amp; Ruas</a>
    <a href="#modulos" data-pt="07–10. Conforto, Saúde, Mobilidade e Poluição" data-en="07–10. Comfort, Health, Mobility & Pollution">07–10. Conforto, Saúde, Mobilidade e Poluição</a>
    <a href="#indicadores" data-pt="11. Painel Integrado" data-en="11. Integrated Panel">11. Painel Integrado</a>
    <a href="#recomendacoes" data-pt="12. Recomendações & Limites" data-en="12. Recommendations & Limits">12. Recomendações &amp; Limites</a>
  </nav>

  <section id="resumo" class="section">
    <div class="section-head">
      <div>
        <div class="section-kicker" data-pt="01 · Síntese executiva" data-en="01 · Executive summary">01 · Síntese executiva</div>
        <h2 data-pt="Principais conclusões comprovadas pelo raster numérico" data-en="Key findings proven by the numerical raster">Principais conclusões comprovadas pelo raster numérico</h2>
        <p class="section-desc" data-pt="Estatísticas extraídas diretamente da matriz Float32Array (${valid.toLocaleString('pt-BR')} píxeis válidos), sem amostragem de cores RGB." data-en="Statistics extracted directly from the Float32Array matrix (${valid.toLocaleString('pt-BR')} valid pixels), without RGB color sampling.">Estatísticas extraídas diretamente da matriz Float32Array (${valid.toLocaleString('pt-BR')} píxeis válidos), sem amostragem de cores RGB.</p>
      </div>
      <span class="chip ok" data-pt="Base numérica auditada" data-en="Audited numerical base">Base numérica auditada</span>
    </div>
    <div class="grid-4">
      <article class="card metric"><div class="metric-label" data-pt="LST média (μ)" data-en="Mean LST (μ)">LST média (μ)</div><div class="metric-value">${raster.stats.mean.toFixed(1)} <span class="metric-unit">°C</span></div><div class="metric-note" data-pt="Mediana: ${raster.stats.q50.toFixed(1)} °C · σ = ${raster.stats.stdDev.toFixed(2)} °C" data-en="Median: ${raster.stats.q50.toFixed(1)} °C · σ = ${raster.stats.stdDev.toFixed(2)} °C">Mediana: ${raster.stats.q50.toFixed(1)} °C · σ = ${raster.stats.stdDev.toFixed(2)} °C</div></article>
      <article class="card metric"><div class="metric-label" data-pt="LST máxima" data-en="Max LST">LST máxima</div><div class="metric-value">${raster.stats.max.toFixed(1)} <span class="metric-unit">°C</span></div><div class="metric-note" data-pt="Mínima: ${raster.stats.min.toFixed(1)} °C · Q75: ${raster.stats.q75.toFixed(1)} °C" data-en="Min: ${raster.stats.min.toFixed(1)} °C · Q75: ${raster.stats.q75.toFixed(1)} °C">Mínima: ${raster.stats.min.toFixed(1)} °C · Q75: ${raster.stats.q75.toFixed(1)} °C</div></article>
      <article class="card metric"><div class="metric-label" data-pt="UHI forte + extrema" data-en="Strong + extreme UHI">UHI forte + extrema</div><div class="metric-value">${strongExtPct}<span class="metric-unit">%</span></div><div class="metric-note" data-pt="${ha(uhiCnt[4] + uhiCnt[5])} ha (> +0,85σ); fração > 31 °C = ${pct(above31)}%" data-en="${ha(uhiCnt[4] + uhiCnt[5])} ha (> +0.85σ); fraction > 31 °C = ${pct(above31)}%">${ha(uhiCnt[4] + uhiCnt[5])} ha (&gt; +0,85σ); fração &gt; 31 °C = ${pct(above31)}%</div></article>
      <article class="card metric"><div class="metric-label" data-pt="Vegetação espectral (NDVI > 0,3)" data-en="Spectral vegetation (NDVI > 0.3)">Vegetação espectral (NDVI &gt; 0,3)</div><div class="metric-value">${pct(veg, specValid)}<span class="metric-unit">%</span></div><div class="metric-note">${ha(veg)} ha · NDVI μ = ${meanOf(raster.ndvi).toFixed(3)}</div></article>
    </div>
    <div class="insight-list">
      <article class="insight"><div class="number">${(raster.stats.mean - raster.stats.q50) >= 0 ? '+' : ''}${(raster.stats.mean - raster.stats.q50).toFixed(2)} °C</div><p data-pt="Diferença entre média (${raster.stats.mean.toFixed(2)} °C) e mediana (${raster.stats.q50.toFixed(2)} °C). Amplitude interquartil (Q75−Q25) de ${(raster.stats.q75 - raster.stats.q25).toFixed(2)} °C." data-en="Difference between mean (${raster.stats.mean.toFixed(2)} °C) and median (${raster.stats.q50.toFixed(2)} °C). Interquartile range (Q75−Q25) of ${(raster.stats.q75 - raster.stats.q25).toFixed(2)} °C.">Diferença entre média (${raster.stats.mean.toFixed(2)} °C) e mediana (${raster.stats.q50.toFixed(2)} °C). Amplitude interquartil (Q75−Q25) de ${(raster.stats.q75 - raster.stats.q25).toFixed(2)} °C.</p></article>
      <article class="insight"><div class="number">${hotspotLim.toFixed(1)} °C</div><p data-pt="Limiar estatístico de hotspot (μ + 1,5σ), atingido em ${pct(aboveHot)}% da área válida (${ha(aboveHot)} ha). Acima de 31,0 °C estão ${pct(above31)}% (${ha(above31)} ha)." data-en="Statistical hotspot threshold (μ + 1.5σ), reached in ${pct(aboveHot)}% of valid area (${ha(aboveHot)} ha). Above 31.0 °C: ${pct(above31)}% (${ha(above31)} ha).">Limiar estatístico de hotspot (μ + 1,5σ), atingido em ${pct(aboveHot)}% da área válida (${ha(aboveHot)} ha). Acima de 31,0 °C estão ${pct(above31)}% (${ha(above31)} ha).</p></article>
      <article class="insight"><div class="number">${pct(built, specValid)}%</div><p data-pt="Superfícies construídas líquidas (NDBI > 0,10 e NDVI ≤ 0,30: ${ha(built)} ha). Solo misto/transição representa ${pct(mixed, specValid)}% (${ha(mixed)} ha)." data-en="Net built-up surfaces (NDBI > 0.10 and NDVI ≤ 0.30: ${ha(built)} ha). Mixed/transitional soil represents ${pct(mixed, specValid)}% (${ha(mixed)} ha).">Superfícies construídas líquidas (NDBI &gt; 0,10 e NDVI ≤ 0,30: ${ha(built)} ha). Solo misto/transição representa ${pct(mixed, specValid)}% (${ha(mixed)} ha).</p></article>
    </div>
    ${aoiReportBlock}
  </section>

  <section id="metadados" class="section">
    <div class="section-head">
      <div><div class="section-kicker" data-pt="02 · Rastreabilidade e Compatibilidade Temporal" data-en="02 · Traceability and Temporal Compatibility">02 · Rastreabilidade e Compatibilidade Temporal</div><h2 data-pt="Metadados, NoData e avaliação temporal entre cenas" data-en="Metadata, NoData and inter-scene temporal evaluation">Metadados, NoData e avaliação temporal entre cenas</h2></div>
      <span class="chip ${daysGap && daysGap > 5 ? 'warn' : 'info'}">${daysGap !== null ? `Desfasamento temporal: ${daysGap} dias` : 'Cena auditada'}</span>
    </div>
    <div class="card"><div class="table-wrap"><table><thead><tr><th data-pt="Parâmetro" data-en="Parameter">Parâmetro</th><th data-pt="Valor Identificado" data-en="Identified Value">Valor Identificado</th><th data-pt="Impacto na Interpretação" data-en="Interpretation Impact">Impacto na Interpretação</th></tr></thead><tbody>
      <tr><td><strong>Insumos</strong></td><td><code>${raster.fileName}</code></td><td data-pt="Leitura direta do raster numérico Float32Array no navegador." data-en="Direct browser reading of the Float32Array numerical raster.">Leitura direta do raster numérico Float32Array no navegador.</td></tr>
      <tr><td><strong>CRS &amp; Resolução</strong></td><td><code>EPSG:${raster.epsg}</code> · ${resX.toFixed(2)}×${resY.toFixed(2)} ${raster.isProjected ? 'm' : 'deg'}</td><td>Área por pixel: ${pxM2.toFixed(2)} m² · Área válida total: ${areaHa.toFixed(2)} ha (${areaKm2.toFixed(2)} km²).</td></tr>
      <tr><td><strong>Píxeis Válidos vs. NoData</strong></td><td>Válidos: <b>${valid.toLocaleString('pt-BR')} px</b> · NoData: <b>${noData.toLocaleString('pt-BR')} px</b> (${pct(noData, raster.width * raster.height)}%)</td><td data-pt="Píxeis NoData (nuvens/bordas QA_PIXEL) excluídos de todos os denominadores estatísticos." data-en="NoData pixels (QA_PIXEL clouds/borders) excluded from all statistical denominators.">Píxeis NoData (nuvens/bordas QA_PIXEL) excluídos de todos os denominadores estatísticos.</td></tr>
      <tr><td><strong>Compatibilidade Temporal</strong></td><td>Óptico: <b>${dateOpt}</b> · Térmico Landsat: <b>${dateTherm}</b> ${daysGap !== null ? `(<b>Δ = ${daysGap} dias</b>)` : ''}</td><td data-pt="Um intervalo de ${daysGap ?? 17} dias (ex.: 04/09/2026 a 21/09/2026) pode introduzir variações sinóticas de humidade, vento e insolação entre a refletância óptica e a emissão termal." data-en="A ${daysGap ?? 17}-day gap (e.g., 2026-09-04 to 2026-09-21) can introduce synoptic variations in moisture, wind and solar radiation between optical reflectance and thermal emission.">Um intervalo de ${daysGap ?? 17} dias (ex.: 04/09/2026 a 21/09/2026) pode introduzir variações sinóticas de humidade, vento e insolação entre a refletância óptica e a emissão termal.</td></tr>
    </tbody></table></div></div>
  </section>

  <section id="mapas" class="section">
    <div class="section-head">
      <div><div class="section-kicker" data-pt="03 · Cartografia térmica de alta definição" data-en="03 · High-definition thermal cartography">03 · Cartografia térmica de alta definição</div><h2 data-pt="Mapa de Temperatura (LST °C) e Mapa de Ilha de Calor Urbana (UHI 1 m)" data-en="Temperature Map (LST °C) and Urban Heat Island Map (UHI 1 m)">Mapa de Temperatura (LST °C) e Mapa de Ilha de Calor Urbana (UHI 1 m)</h2></div>
      <span class="chip ok" data-pt="Ambos os mapas com legenda incorporada" data-en="Both maps with embedded legends">Ambos os mapas com legenda incorporada</span>
    </div>
    <div class="grid-2">
      <div class="card">
        <h3 data-pt="3.1 · Temperatura de Superfície (LST °C com Legenda)" data-en="3.1 · Land Surface Temperature (LST °C with Legend)">3.1 · Temperatura de Superfície (LST °C com Legenda)</h3>
        <div class="map-frame"><img src="${lstMapImg}" alt="Mapa LST com legenda"><div class="map-caption"><span>Paleta: ${palette.toUpperCase()} · EPSG:${raster.epsg}</span><span>Mín: ${raster.stats.min.toFixed(1)} °C · Média: ${raster.stats.mean.toFixed(1)} °C · Máx: ${raster.stats.max.toFixed(1)} °C</span></div></div>
      </div>
      <div class="card">
        <h3 data-pt="3.2 · Ilha de Calor Urbana (UHI 1 m com Legenda das 6 Classes)" data-en="3.2 · Urban Heat Island (1 m UHI with 6-Class Legend)">3.2 · Ilha de Calor Urbana (UHI 1 m com Legenda das 6 Classes)</h3>
        <div class="map-frame"><img src="${uhiMapImg}" alt="Mapa UHI com legenda"><div class="map-caption"><span>Método: ${uhiMethod.toUpperCase()} (γ=${uhiPower.toFixed(2)})</span><span>UHI Forte + Extrema: ${strongExtPct}% (${ha(uhiCnt[4] + uhiCnt[5])} ha)</span></div></div>
      </div>
    </div>
  </section>

  <section id="classes" class="section">
    <div class="section-head">
      <div><div class="section-kicker" data-pt="04 · Distribuição estatística" data-en="04 · Statistical distribution">04 · Distribuição estatística</div><h2 data-pt="Classes de Ilha de Calor (UHI) e Histograma de Temperatura" data-en="Urban Heat Island (UHI) Classes and Temperature Histogram">Classes de Ilha de Calor (UHI) e Histograma de Temperatura</h2></div>
      <span class="chip info">Denominador: ${valid.toLocaleString('pt-BR')} px (${areaHa.toFixed(2)} ha)</span>
    </div>
    <div class="two-col">
      <div class="card">
        <h3 data-pt="4.1 · Repartição nas 6 Classes UHI" data-en="4.1 · Breakdown across 6 UHI Classes">4.1 · Repartição nas 6 Classes UHI</h3>
        ${uhiBars}
        <div class="chart-legend"><span><strong>Unidade:</strong> % e ha</span><span><strong>Denominador:</strong> ${valid.toLocaleString('pt-BR')} px</span><span><strong>Fonte:</strong> Raster LST (${dateOpt})</span></div>
      </div>
      <div class="card">
        <h3 data-pt="4.2 · Distribuição por Faixa Térmica (°C)" data-en="4.2 · Distribution by Thermal Bin (°C)">4.2 · Distribuição por Faixa Térmica (°C)</h3>
        ${histBars}
        <div class="stat-list">
          <div class="stat-item"><span>Q25</span><b>${raster.stats.q25.toFixed(1)} °C</b></div>
          <div class="stat-item"><span>Mediana (Q50)</span><b>${raster.stats.q50.toFixed(1)} °C</b></div>
          <div class="stat-item"><span>Q75</span><b>${raster.stats.q75.toFixed(1)} °C</b></div>
        </div>
        <div class="chart-legend"><span><strong>Unidade:</strong> °C, % e ha</span><span><strong>Denominador:</strong> ${valid.toLocaleString('pt-BR')} px</span><span><strong>Data:</strong> ${dateOpt}</span></div>
      </div>
    </div>
  </section>

  <section id="espectral" class="section">
    <div class="section-head">
      <div><div class="section-kicker" data-pt="05 · Índices espectrais" data-en="05 · Spectral indices">05 · Índices espectrais</div><h2 data-pt="Partição de Cobertura do Solo (NDVI e NDBI)" data-en="Land Cover Partition (NDVI and NDBI)">Partição de Cobertura do Solo (NDVI e NDBI)</h2></div>
      <span class="chip ok">NDVI μ = ${meanOf(raster.ndvi).toFixed(3)} · NDBI μ = ${meanOf(raster.ndbi).toFixed(3)}</span>
    </div>
    <div class="card">
      <div class="bar-row"><div class="bar-label"><span data-pt="Vegetação vigorosa (NDVI > 0,30)" data-en="Vigorous vegetation (NDVI > 0.30)">Vegetação vigorosa (NDVI &gt; 0,30)</span><b>${pct(veg, specValid)}% · ${ha(veg)} ha</b></div><div class="bar-track"><div class="bar-fill" style="width:${pct(veg, specValid)}%;background:#27765e"></div></div></div>
      <div class="bar-row"><div class="bar-label"><span data-pt="Área construída líquida (NDBI > 0,10 e NDVI ≤ 0,30)" data-en="Net built-up area (NDBI > 0.10 and NDVI ≤ 0.30)">Área construída líquida (NDBI &gt; 0,10 e NDVI ≤ 0,30)</span><b>${pct(built, specValid)}% · ${ha(built)} ha</b></div><div class="bar-track"><div class="bar-fill" style="width:${pct(built, specValid)}%;background:#c84638"></div></div></div>
      <div class="bar-row"><div class="bar-label"><span data-pt="Água ou sombra densa (NDVI < 0 e NDBI < 0)" data-en="Water or dense shadow (NDVI < 0 and NDBI < 0)">Água ou sombra densa (NDVI &lt; 0 e NDBI &lt; 0)</span><b>${pct(water, specValid)}% · ${ha(water)} ha</b></div><div class="bar-track"><div class="bar-fill" style="width:${pct(water, specValid)}%;background:#2668b8"></div></div></div>
      <div class="bar-row"><div class="bar-label"><span data-pt="Solo exposto de transição / cobertura mista" data-en="Transitional bare soil / mixed cover">Solo exposto de transição / cobertura mista</span><b>${pct(mixed, specValid)}% · ${ha(mixed)} ha</b></div><div class="bar-track"><div class="bar-fill" style="width:${pct(mixed, specValid)}%;background:#f1b64a"></div></div></div>
      <div class="chart-legend"><span><strong>Soma da partição mutuamente exclusiva:</strong> 100,0% (${specValid.toLocaleString('pt-BR')} px)</span><span><strong>Sobreposição bruta (NDVI&gt;0,3 ∩ NDBI&gt;0,1):</strong> ${pct(overlapVB, specValid)}%</span><span><strong>Data:</strong> ${dateOpt}</span></div>
    </div>
  </section>

  <section id="bairros-ruas" class="section">
    <div class="section-head">
      <div><div class="section-kicker" data-pt="06 · Análise por bairro e ranking por rua/segmento" data-en="06 · Neighborhood analysis and street/segment ranking">06 · Análise por bairro e ranking por rua/segmento</div><h2 data-pt="Cruzamento espacial com feições reais da base OpenStreetMap" data-en="Spatial intersection with real OpenStreetMap features">Cruzamento espacial com feições reais da base OpenStreetMap</h2></div>
      <span class="chip info">${osm.bairros.length} bairros · ${osm.vias.length} ruas</span>
    </div>
    <div class="card" style="margin-bottom:14px"><h3 data-pt="6.1 · Resultados por Bairro / Localidade" data-en="6.1 · Results by Neighborhood / Locality">6.1 · Resultados por Bairro / Localidade</h3><div class="table-wrap">${bairrosHtml}</div></div>
    <div class="card"><h3 data-pt="6.2 · Ranking por Rua / Segmento Viário" data-en="6.2 · Ranking by Street / Road Segment">6.2 · Ranking por Rua / Segmento Viário</h3><div class="table-wrap">${viasHtml}</div></div>
  </section>

  <section id="modulos" class="section">
    <div class="section-head">
      <div><div class="section-kicker" data-pt="07 a 10 · Módulos Setoriais e Condições de Contorno" data-en="07 to 10 · Sectoral Modules and Boundary Conditions">07 a 10 · Módulos Setoriais e Condições de Contorno</div><h2 data-pt="Conforto térmico, saúde, mobilidade ativa e poluição atmosférica" data-en="Thermal comfort, health, active mobility and air pollution">Conforto térmico, saúde, mobilidade ativa e poluição atmosférica</h2></div>
      <span class="chip pending" data-pt="Rigor científico: sem extrapolação indevida" data-en="Scientific rigor: no improper extrapolation">Rigor científico: sem extrapolação indevida</span>
    </div>
    <div class="grid-2">
      <article class="card theme-card"><div class="theme-icon">🌡️</div><h3 data-pt="07 · Conforto Térmico (UTCI / PET / WBGT)" data-en="07 · Thermal Comfort (UTCI / PET / WBGT)">07 · Conforto Térmico (UTCI / PET / WBGT)</h3><p data-pt="A LST mede a temperatura radiométrica da superfície e NÃO equivale à temperatura do ar a 1,5 m nem à sensação térmica humana. O cálculo de UTCI, PET ou WBGT exige temperatura do ar (Ta), humidade relativa (RH), velocidade do vento (v) e temperatura radiante média (Tmrt)." data-en="LST measures surface radiometric temperature and DOES NOT equal 1.5 m air temperature or human thermal sensation. UTCI, PET or WBGT require air temperature (Ta), relative humidity (RH), wind speed (v) and mean radiant temperature (Tmrt).">A LST mede a temperatura radiométrica da superfície e NÃO equivale à temperatura do ar a 1,5 m nem à sensação térmica humana. O cálculo de UTCI, PET ou WBGT exige temperatura do ar (Ta), humidade relativa (RH), velocidade do vento (v) e temperatura radiante média (Tmrt).</p><span class="chip pending" data-pt="Não calculado — dados micrometeorológicos ausentes" data-en="Not calculated — micrometeorological data missing">Não calculado — dados micrometeorológicos ausentes</span></article>
      <article class="card theme-card"><div class="theme-icon">🏥</div><h3 data-pt="08 · Exposição e Vulnerabilidade em Saúde" data-en="08 · Health Exposure and Vulnerability">08 · Exposição e Vulnerabilidade em Saúde</h3><p data-pt="Exige cruzamento espacial com população residente, densidade de idosos/crianças, renda e equipamentos de saúde. Nota metodológica: correlação espacial não comprova causalidade clínica." data-en="Requires spatial crossing with resident population, elderly/child density, income and health facilities. Methodological note: spatial correlation does not prove clinical causality.">Exige cruzamento espacial com população residente, densidade de idosos/crianças, renda e equipamentos de saúde. Nota metodológica: correlação espacial não comprova causalidade clínica.</p><span class="chip pending" data-pt="Não calculado — dados demográficos e de saúde ausentes" data-en="Not calculated — demographic and health data missing">Não calculado — dados demográficos e de saúde ausentes</span></article>
      <article class="card theme-card"><div class="theme-icon">🚲</div><h3 data-pt="09 · Mobilidade Ativa e Acesso a Serviços" data-en="09 · Active Mobility and Service Access">09 · Mobilidade Ativa e Acesso a Serviços</h3><p data-pt="Foram avaliados ${osm.vias.length} corredores viários por interseção com o raster térmico. A análise de conectividade origem-destino e tempo de caminhada até paragens/escolas exige rede caminável topológica e pontos GTFS." data-en="Evaluated ${osm.vias.length} road corridors via thermal raster intersection. Origin-destination connectivity and walking time to stops/schools require a topological walkable network and GTFS points.">Foram avaliados ${osm.vias.length} corredores viários por interseção com o raster térmico. A análise de conectividade origem-destino e tempo de caminhada até paragens/escolas exige rede caminável topológica e pontos GTFS.</p><span class="chip ${osm.vias.length ? 'info' : 'pending'}">${osm.vias.length ? 'Corredores viários calculados · Conectividade OD ausente' : 'Não calculado — dados ausentes'}</span></article>
      <article class="card theme-card"><div class="theme-icon">🌫️</div><h3 data-pt="10 · Poluição do Ar (PM2.5, PM10, NO2, O3)" data-en="10 · Air Pollution (PM2.5, PM10, NO2, O3)">10 · Poluição do Ar (PM2.5, PM10, NO2, O3)</h3><p data-pt="Temperatura de superfície (LST) NÃO pode ser usada como substituto de concentrações de PM2.5, PM10, NO2 ou O3. Requer estações de qualidade do ar ou sensores dedicados." data-en="Land Surface Temperature (LST) CANNOT be used as a substitute for PM2.5, PM10, NO2 or O3 concentrations. Requires air quality stations or dedicated sensors.">Temperatura de superfície (LST) NÃO pode ser usada como substituto de concentrações de PM2.5, PM10, NO2 ou O3. Requer estações de qualidade do ar ou sensores dedicados.</p><span class="chip pending" data-pt="Não calculado — dados de poluição ausentes" data-en="Not calculated — pollution data missing">Não calculado — dados de poluição ausentes</span></article>
    </div>
  </section>

  <section id="indicadores" class="section">
    <div class="section-head"><div><div class="section-kicker" data-pt="11 · Painel integrado urbano-saúde-ambiental" data-en="11 · Integrated urban-health-environmental panel">11 · Painel integrado urbano-saúde-ambiental</div><h2 data-pt="Matriz síntese de indicadores e disponibilidade de dados" data-en="Synthesis matrix of indicators and data availability">Matriz síntese de indicadores e disponibilidade de dados</h2></div></div>
    <div class="table-wrap"><table><thead><tr><th>Eixo</th><th>Indicador</th><th>Resultado</th><th>Unidade / Denominador</th><th>Status</th></tr></thead><tbody>
      <tr><td><strong>Térmico</strong></td><td>LST Média / Mediana / Máxima</td><td><b>${raster.stats.mean.toFixed(2)} °C</b> / ${raster.stats.q50.toFixed(2)} °C / ${raster.stats.max.toFixed(1)} °C</td><td>°C (${valid.toLocaleString('pt-BR')} px)</td><td><span class="tag available">Calculado do raster numérico</span></td></tr>
      <tr><td><strong>UHI</strong></td><td>UHI Forte + Extrema (&gt; +0,85σ)</td><td><b>${strongExtPct}%</b> (${ha(uhiCnt[4] + uhiCnt[5])} ha)</td><td>% e ha sobre ${areaHa.toFixed(2)} ha</td><td><span class="tag available">Calculado (${uhiMethod.toUpperCase()})</span></td></tr>
      <tr><td><strong>Espectral</strong></td><td>Vegetação (NDVI&gt;0,3) vs. Construído (NDBI&gt;0,1)</td><td><b>${pct(veg, specValid)}%</b> vs. <b>${pct(built, specValid)}%</b></td><td>% sobre ${specValid.toLocaleString('pt-BR')} px</td><td><span class="tag available">Calculado (SR2D4)</span></td></tr>
      <tr><td><strong>Território</strong></td><td>Bairros e Segmentos de Rua</td><td>${osm.bairros.length} bairros / ${osm.vias.length} ruas</td><td>°C por feição OSM</td><td><span class="tag ${osm.bairros.length || osm.vias.length ? 'available' : 'pending'}">${osm.bairros.length || osm.vias.length ? 'Calculado (OSM + Raster)' : 'Não calculado — dados ausentes'}</span></td></tr>
      <tr><td><strong>Conforto / Saúde / Ar</strong></td><td>UTCI, População Exposta e PM2.5/NO2/O3</td><td>—</td><td>°C eq., hab., µg/m³</td><td><span class="tag pending">Não calculado — dados ausentes</span></td></tr>
    </tbody></table></div>
  </section>

  <section id="recomendacoes" class="section">
    <div class="section-head"><div><div class="section-kicker" data-pt="12 · Recomendações priorizadas e limitações" data-en="12 · Prioritized recommendations and limitations">12 · Recomendações priorizadas e limitações</div><h2 data-pt="Plano de intervenção urbana e nota metodológica" data-en="Urban intervention plan and methodological note">Plano de intervenção urbana e nota metodológica</h2></div></div>
    <div class="card">
      <div class="action-row"><div class="priority p1">PRIORIDADE P1</div><div><strong data-pt="Mitigação nos ${ha(uhiCnt[5])} ha de Hotspot Extremo (> +1,40σ)" data-en="Mitigation across ${ha(uhiCnt[5])} ha of Extreme Hotspot (> +1.40σ)">Mitigação nos ${ha(uhiCnt[5])} ha de Hotspot Extremo (&gt; +1,40σ)</strong><p data-pt="Implantar telhados frios (alto albedo) e sombreamento arbóreo nas quadras e vias críticas identificadas acima de ${hotspotLim.toFixed(1)} °C." data-en="Deploy cool roofs (high albedo) and tree shading across critical blocks and streets identified above ${hotspotLim.toFixed(1)} °C.">Implantar telhados frios (alto albedo) e sombreamento arbóreo nas quadras e vias críticas identificadas acima de ${hotspotLim.toFixed(1)} °C.</p></div></div>
      <div class="action-row"><div class="priority p2">PRIORIDADE P2</div><div><strong data-pt="Integração de camadas censitárias, saúde e rede pedonal no SIG" data-en="Integration of census, health and pedestrian network layers in GIS">Integração de camadas censitárias, saúde e rede pedonal no SIG</strong><p data-pt="Cruzar o GeoTIFF numérico exportado com limites oficiais de setores censitários, UBS e escolas para completar os módulos demográficos e epidemiológicos." data-en="Cross the exported numerical GeoTIFF with official census tract boundaries, health clinics and schools to complete demographic and epidemiological modules.">Cruzar o GeoTIFF numérico exportado com limites oficiais de setores censitários, UBS e escolas para completar os módulos demográficos e epidemiológicos.</p></div></div>
      <div class="action-row"><div class="priority">PRIORIDADE P3</div><div><strong data-pt="Preservação dos ${ha(uhiCnt[0] + uhiCnt[1])} ha de Ilhas de Frescor e Zonas Amenizadas" data-en="Preservation of ${ha(uhiCnt[0] + uhiCnt[1])} ha of Cool Islands and Mitigated Zones">Preservação dos ${ha(uhiCnt[0] + uhiCnt[1])} ha de Ilhas de Frescor e Zonas Amenizadas</strong><p data-pt="Proteger fragmentos com NDVI > 0,30 (${pct(veg, specValid)}%) e conectá-los aos corredores viários mais quentes." data-en="Protect fragments with NDVI > 0.30 (${pct(veg, specValid)}%) and connect them to the hottest street corridors.">Proteger fragmentos com NDVI &gt; 0,30 (${pct(veg, specValid)}%) e conectá-los aos corredores viários mais quentes.</p></div></div>
    </div>
  </section>

  <footer class="footer">
    <div><strong>SR2D4 / LST Explorer · v3.0</strong><p data-pt="Relatório gerado a partir do raster numérico Float32Array. Nenhuma estatística foi inventada." data-en="Report generated from the Float32Array numerical raster. No statistics were fabricated.">Relatório gerado a partir do raster numérico Float32Array. Nenhuma estatística foi inventada.</p></div>
    <div>EPSG:${raster.epsg} · ${issueDate}</div>
  </footer>
</div>
<script>
let lang = 'pt';
function toggleReportLang() {
  lang = lang === 'pt' ? 'en' : 'pt';
  document.documentElement.lang = lang === 'pt' ? 'pt-BR' : 'en';
  const b = document.getElementById('lang-btn');
  if (b) b.textContent = lang === 'pt' ? '🇬🇧 Switch to English (EN)' : '🇵🇹 Mudar para Português (PT)';
  document.querySelectorAll('[data-pt][data-en]').forEach((el) => {
    const val = el.getAttribute(lang === 'pt' ? 'data-pt' : 'data-en');
    if (val !== null) el.textContent = val;
  });
}
</script>
</body>
</html>`;

    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `SR2D4_relatorio_modelo_expandido_${dateOpt}.html`;
    a.click();
    URL.revokeObjectURL(a.href);
    setStatus('Relatório técnico expandido exportado com sucesso.');
  };

  // Exportações diretas do Pop-up da AOI
  const downloadAoiModalPng = async () => {
    if (!aoiDetailed || !raster) return;
    const im = new Image(); im.src = aoiDetailed.previewDataUrl;
    await new Promise<void>((r) => { im.onload = () => r(); im.onerror = () => r(); });
    const w = Math.max(680, im.width + 60);
    const iH = Math.min(520, Math.max(240, Math.round(((w - 60) * im.height) / Math.max(1, im.width))));
    const iW = Math.round((iH * im.width) / Math.max(1, im.height));
    const c = document.createElement('canvas'); c.width = w; c.height = iH + 260;
    const ctx = c.getContext('2d'); if (!ctx) return;
    ctx.fillStyle = '#071317'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = '#ffb000'; ctx.font = '700 20px Arial';
    ctx.fillText(`SR2D4 · RECORTE AOI (${aoiDetailed.shapeMode.toUpperCase()}) · ${aoiDetailed.areaHa.toFixed(2)} ha`, 28, 36);
    const ix = Math.round((w - iW) / 2);
    ctx.drawImage(im, ix, 50, iW, iH);
    ctx.strokeStyle = '#ffb000'; ctx.lineWidth = 2; ctx.strokeRect(ix, 50, iW, iH);
    const fy = iH + 66;
    ctx.fillStyle = '#0d1f26'; ctx.fillRect(24, fy, w - 48, 174);
    ctx.strokeStyle = '#79e2dc'; ctx.strokeRect(24, fy, w - 48, 174);
    ctx.fillStyle = '#fff'; ctx.font = '700 17px Arial';
    ctx.fillText(`Mín: ${aoiDetailed.min.toFixed(1)}°C | Média: ${aoiDetailed.mean.toFixed(2)}°C | Mediana: ${aoiDetailed.q50.toFixed(2)}°C | Máx: ${aoiDetailed.max.toFixed(1)}°C | σ=${aoiDetailed.stdDev.toFixed(2)}°C`, 40, fy + 34);
    ctx.fillStyle = '#9cddda'; ctx.font = '15px Arial';
    ctx.fillText(`Pixels: ${aoiDetailed.count.toLocaleString('pt-BR')} (${aoiDetailed.areaM2.toFixed(0)} m²) · NDVI: ${aoiDetailed.ndviMean.toFixed(3)} (Veg ${aoiDetailed.vegPct.toFixed(1)}%) · NDBI: ${aoiDetailed.ndbiMean.toFixed(3)} (Const ${aoiDetailed.builtPct.toFixed(1)}%)`, 40, fy + 64);
    const grad = ctx.createLinearGradient(40, fy + 84, w - 40, fy + 84);
    for (let s = 0; s <= 16; s += 1) grad.addColorStop(s / 16, sampleCssColorAt(s / 16, palette, draftCustomColors, false));
    ctx.fillStyle = grad; ctx.fillRect(40, fy + 84, w - 80, 24);
    ctx.fillStyle = '#fff'; ctx.font = '700 14px Arial';
    ctx.fillText(`${aoiDetailed.min.toFixed(1)} °C`, 40, fy + 132);
    ctx.textAlign = 'center'; ctx.fillText(`Média AOI: ${aoiDetailed.mean.toFixed(2)} °C`, w / 2, fy + 132);
    ctx.textAlign = 'right'; ctx.fillText(`${aoiDetailed.max.toFixed(1)} °C`, w - 40, fy + 132); ctx.textAlign = 'left';
    const a = document.createElement('a'); a.href = c.toDataURL('image/png'); a.download = `SR2D4-AOI-${aoiDetailed.shapeMode}.png`; a.click();
  };

  const downloadAoiModalTiff = () => {
    if (!aoiDetailed || !raster) return;
    downloadFloat32Tiff(aoiDetailed.clippedFloat32, aoiDetailed.clipWidth, aoiDetailed.clipHeight, `SR2D4-AOI-${aoiDetailed.shapeMode}.tif`, aoiDetailed.clipOrigin, raster.resolution, raster.epsg, raster.isProjected);
  };

  const downloadAoiModalGeoJson = () => {
    if (!aoiDetailed || !raster) return;
    const ring = [...aoiDetailed.vertices, aoiDetailed.vertices[0]];
    const gj = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: {
          shape: aoiDetailed.shapeMode, pixels: aoiDetailed.count, area_m2: Number(aoiDetailed.areaM2.toFixed(1)), area_ha: Number(aoiDetailed.areaHa.toFixed(3)),
          lst_min: Number(aoiDetailed.min.toFixed(2)), lst_mean: Number(aoiDetailed.mean.toFixed(2)), lst_median: Number(aoiDetailed.q50.toFixed(2)), lst_max: Number(aoiDetailed.max.toFixed(2)),
          ndvi_mean: Number(aoiDetailed.ndviMean.toFixed(3)), ndbi_mean: Number(aoiDetailed.ndbiMean.toFixed(3)),
        },
        geometry: { type: 'Polygon', coordinates: [ring] },
      }],
    };
    const b = new Blob([JSON.stringify(gj, null, 2)], { type: 'application/geo+json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `SR2D4-AOI-${aoiDetailed.shapeMode}.geojson`; a.click(); URL.revokeObjectURL(a.href);
  };

  const downloadAoiModalKml = () => {
    if (!aoiDetailed) return;
    const ring = [...aoiDetailed.vertices, aoiDetailed.vertices[0]].map(([lng, lat]) => `${lng},${lat},0`).join(' ');
    const kml = `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>AOI (${aoiDetailed.shapeMode}) · Média ${aoiDetailed.mean.toFixed(2)}°C</name><Polygon><outerBoundaryIs><LinearRing><coordinates>${ring}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></Document></kml>`;
    const b = new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `SR2D4-AOI-${aoiDetailed.shapeMode}.kml`; a.click(); URL.revokeObjectURL(a.href);
  };

  const downloadAoiModalCsv = () => {
    if (!aoiDetailed) return;
    const csv = [
      'Parametro;Valor;Unidade',
      `Formato;${aoiDetailed.shapeMode};geometria`,
      `Pixels_Validos;${aoiDetailed.count};px`,
      `Area_m2;${aoiDetailed.areaM2.toFixed(2)};m2`,
      `Area_ha;${aoiDetailed.areaHa.toFixed(4)};ha`,
      `LST_Min;${aoiDetailed.min.toFixed(2)};C`,
      `LST_Q25;${aoiDetailed.q25.toFixed(2)};C`,
      `LST_Mediana;${aoiDetailed.q50.toFixed(2)};C`,
      `LST_Media;${aoiDetailed.mean.toFixed(2)};C`,
      `LST_Q75;${aoiDetailed.q75.toFixed(2)};C`,
      `LST_Max;${aoiDetailed.max.toFixed(2)};C`,
      `NDVI_Medio;${aoiDetailed.ndviMean.toFixed(4)};indice`,
      `NDBI_Medio;${aoiDetailed.ndbiMean.toFixed(4)};indice`,
    ].join('\n');
    const b = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `SR2D4-AOI-${aoiDetailed.shapeMode}.csv`; a.click(); URL.revokeObjectURL(a.href);
  };

  const goTo = (lng: number, lat: number) => { if (Number.isFinite(lng) && Number.isFinite(lat)) mapInstance.current?.flyTo({ center: [lng, lat], zoom: 13, essential: true }); };
  const locateMe = () => navigator.geolocation?.getCurrentPosition(({ coords }) => goTo(coords.longitude, coords.latitude), () => setSearchError('Permita o acesso ao GPS.'));
  const searchPlace = async () => {
    if (!search.trim()) return; setSearching(true); setSearchError('');
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${encodeURIComponent(search.trim())}`);
      const res = (await r.json()) as SearchResult[]; setSearchResults(res);
      if (res[0]) goTo(Number(res[0].lon), Number(res[0].lat)); else setSearchError(t.searchError);
    } catch { setSearchError(t.searchError); } finally { setSearching(false); }
  };
  const startCurtainDrag = (ev: React.PointerEvent<HTMLDivElement>) => {
    if (!swipeActive || !showingComparison) return; ev.preventDefault(); ev.stopPropagation();
    curtainDragging.current = true; document.body.classList.add('is-curtain-dragging'); ev.currentTarget.setPointerCapture?.(ev.pointerId);
  };
  const goToCoordinates = () => { const v = coordText.split(/[,;\s]+/).map(Number); if (v.length >= 2) goTo(v[0], v[1]); };
  const zoomIn = () => mapInstance.current?.zoomIn(); const zoomOut = () => mapInstance.current?.zoomOut();
  const togglePan = () => { if (drawAoi || identifyMode) return; const n = !panEnabled; setPanEnabled(n); if (n) mapInstance.current?.dragPan.enable(); else mapInstance.current?.dragPan.disable(); };
  const toggleIdentify = () => { const n = !identifyMode; setIdentifyMode(n); setHoverSample(null); setPanEnabled(!n); };
  const visibleBandCount = raster?.bands ?? bandCount;
  const displayBandLabels = bandLabels.length === visibleBandCount ? bandLabels : Array.from({ length: visibleBandCount }, (_, i) => `Camada ${String(i + 1).padStart(2, '0')}`);
  const options = Array.from({ length: visibleBandCount }, (_, i) => <option value={i} key={i}>{displayBandLabels[i]}</option>);
  const updateBand = (idx: number, val: string) => setBands((p) => p.map((v, i) => (i === idx ? val : v)));

  const selectAoiShape = (mode: AoiShapeMode) => {
    setAoiShapeMode(mode);
    setAoiAnchor(null);
    setAoi([]);
    setAoiStats(null);
    setAoiDetailed(null);
    setDrawAoi(true);
    setIdentifyMode(false);
    setPanEnabled(false);
    setStatus(`Modo AOI (${mode}): clique no mapa para desenhar.`);
  };
  const clearAoi = () => {
    setAoi([]); setAoiAnchor(null); setAoiStats(null); setAoiDetailed(null);
    setShowAoiModal(false); setDrawAoi(false); setPanEnabled(true);
  };
  const analyzeAoi = () => {
    if (!raster || aoi.length < 3) {
      setStatus('Desenhe uma AOI no mapa primeiro (Retângulo, Quadrado, Círculo ou Polígono).');
      return;
    }
    const det = analyzeAoiDetailed(raster, aoi, aoiShapeMode, opticalCanvas.current, lstCanvas.current, opacity);
    if (!det) {
      setStatus('A AOI desenhada está fora dos limites da imagem térmica.');
      return;
    }
    setAoiDetailed(det);
    setAoiStats({ count: det.count, min: det.min, max: det.max, mean: det.mean });
    setShowAoiModal(true);
    setStatus(`AOI analisada · ${det.count.toLocaleString('pt-BR')} pixels (${det.areaHa.toFixed(2)} ha)`);
  };
  const finishAoi = () => {
    if (aoi.length >= 3) {
      setDrawAoi(false); setAoiAnchor(null); setPanEnabled(true);
      analyzeAoi();
    }
  };
  const toggleAoi = () => {
    const n = !drawAoi;
    setDrawAoi(n); setIdentifyMode(false); setAoiAnchor(null);
    if (n) { setAoi([]); setAoiStats(null); setAoiDetailed(null); }
    setPanEnabled(!n);
  };

  const closeTutorial = () => { setShowTutorial(false); sessionStorage.setItem('sr2d4-tutorial-seen', '1'); };
  const activeInspect = hoverSample || sample;
  const activeDiffInfo = activeInspect?.diffTemp !== undefined && differenceStats ? differenceClassLabel(activeInspect.diffTemp, differenceStats, lang) : null;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><LogoMark /><div><span className="eyebrow">{t.eyebrow}</span><h1>{t.title}</h1></div></div>
        <div className="top-actions">
          <span className={`status-dot ${raster || differenceReady ? 'active' : ''}`} />
          <span className="status-label">{status || (raster || differenceReady ? t.ready : t.noData)}</span>
          <button className="icon-button" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} title={t.theme}><Icon name={theme === 'dark' ? 'sun' : 'moon'} /></button>
          <button className="lang-button" onClick={() => setLang(lang === 'pt' ? 'en' : 'pt')}>{lang === 'pt' ? 'EN' : 'PT'}</button>
        </div>
      </header>
      <div className="intro-strip">
        <div><strong>{t.subtitle}</strong><span>{raster ? `${raster.fileName} · ${raster.width}×${raster.height} px · EPSG:${raster.epsg}` : 'Local-first analysis for SR2D4 multispectral products'}</span></div>
        <a className="colab-button" href={COLAB_URL} target="_blank" rel="noreferrer">↗ {t.colab}</a>
      </div>
      <main className="workspace" style={{ '--rail-width': `${panelWidth}px` } as React.CSSProperties}>
        <section className="map-stage" style={{ position: 'relative', overflow: 'hidden' }}>
          <div ref={mapRef} className={`map-container ${identifyMode ? 'identify-active' : ''}`} />
          {swipeActive && showingComparison && (
            <div className="curtain-map" ref={curtainContainerRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 2, clipPath: `inset(0 0 0 ${swipePosition}%)` }} />
          )}
          {swipeActive && showingComparison && (
            <>
              <div style={{ position: 'absolute', top: '76px', left: '16px', zIndex: 6, background: 'rgba(7,19,23,0.92)', border: '2px solid #38bdf8', color: '#fff', padding: '8px 14px', borderRadius: '10px', fontWeight: 800, fontSize: '13px', pointerEvents: 'none' }}>
                <span style={{ color: '#38bdf8', display: 'block', fontSize: '10px' }}>◀ LADO ESQUERDO (ANTES)</span>
                DATA 1 · {comparisonPrimary?.dateLabel ?? 'ANTES'}
              </div>
              <div style={{ position: 'absolute', top: '76px', right: '58px', zIndex: 6, background: 'rgba(7,19,23,0.92)', border: '2px solid #ffb000', color: '#fff', padding: '8px 14px', borderRadius: '10px', fontWeight: 800, fontSize: '13px', textAlign: 'right', pointerEvents: 'none' }}>
                <span style={{ color: '#ffb000', display: 'block', fontSize: '10px' }}>LADO DIREITO (DEPOIS) ▶</span>
                DATA 2 · {comparisonSecondary?.dateLabel ?? 'DEPOIS'}
              </div>
              <div className="curtain-divider" style={{ position: 'absolute', top: 0, bottom: 0, left: `${swipePosition}%`, width: '4px', background: '#ffb000', cursor: 'ew-resize', zIndex: 7 }} onPointerDown={startCurtainDrag} role="slider" tabIndex={0}>
                <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', background: '#071317', border: '2px solid #ffb000', color: '#fff', padding: '6px 12px', borderRadius: '999px', fontSize: '11px', fontWeight: 800, whiteSpace: 'nowrap' }}>
                  ◀ ANTES | DEPOIS ▶
                </div>
              </div>
            </>
          )}
          {showSearch ? (
            <div className="map-search">
              <div className="search-line">
                <Icon name="search" /><input value={search} placeholder={t.search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && searchPlace()} />
                <button onClick={searchPlace} disabled={searching}>{searching ? '…' : t.go}</button>
                <button className="search-close" onClick={() => { setShowSearch(false); setSearchResults([]); }}>×</button>
              </div>
              {searchResults.length > 0 && <div className="search-results">{searchResults.map((r) => <button key={`${r.lat}-${r.lon}`} onClick={() => { goTo(Number(r.lon), Number(r.lat)); setSearchResults([]); }}>{r.display_name}</button>)}</div>}
              <div className="coord-line">
                <Icon name="pin" /><input value={coordText} placeholder={t.coords} onChange={(e) => setCoordText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && goToCoordinates()} />
                <button onClick={goToCoordinates}>{t.go}</button><button className="gps-button" onClick={locateMe} title={t.locate}><Icon name="gps" /></button>
              </div>
              {searchError && <small className="search-error">{searchError}</small>}
            </div>
          ) : (
            <button className="search-open" onClick={() => setShowSearch(true)} title={t.search}><Icon name="search" /></button>
          )}
          {!raster && !differenceReady && <div className="map-empty"><div className="empty-orbit">◌</div><strong>{t.noData}</strong><span>{t.uploadHint}</span></div>}
          {(raster || differenceReady) && (
            <div className={`map-legend ${displayMode === 'uhi' ? 'uhi-legend' : ''}`} style={{ top: '14px', right: '54px', bottom: 'auto', left: 'auto', maxWidth: '370px', zIndex: 5 }}>
              <span>
                {comparisonMode === 'difference' && showingComparison && !swipeActive
                  ? `Δ LST (${comparisonPrimary?.dateLabel} → ${comparisonSecondary?.dateLabel}) · 1σ = ±${differenceStats?.thresholdSigma.toFixed(2)}°C`
                  : swipeActive && showingComparison
                    ? `CORTINA: ${comparisonPrimary?.dateLabel} ◀ | ▶ ${comparisonSecondary?.dateLabel}`
                    : displayMode === 'uhi' ? `UHI (${uhiMethod.toUpperCase()} · γ=${uhiPower.toFixed(2)})` : t.lst}
              </span>
              {comparisonMode === 'difference' && showingComparison && !swipeActive && differenceStats ? (
                <>
                  <div className="legend-gradient" style={{ background: DIFFERENCE_GRADIENT_CSS, height: '10px', borderRadius: '5px' }} />
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', marginTop: '4px' }}>
                    <b style={{ color: '#48cae4' }}>↓ Diminuiu ({differenceStats.pctDecreased.toFixed(1)}%)</b>
                    <b style={{ color: '#cbd5e1' }}>＝ Igual ({differenceStats.pctEqual.toFixed(1)}%)</b>
                    <b style={{ color: '#ff9e00' }}>↑ Aumentou ({differenceStats.pctIncreased.toFixed(1)}%)</b>
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
            <button onClick={zoomIn} title="Zoom in">＋</button><button onClick={zoomOut} title="Zoom out">−</button>
            <button className={panEnabled ? 'active' : ''} onClick={togglePan} title="Pan">✋</button>
            <button className={identifyMode ? 'active' : ''} onClick={toggleIdentify} title="Identify">ⓘ</button>
            <button className={drawAoi ? 'active' : ''} onClick={toggleAoi} title={t.draw}>⌗</button>
            {drawAoi && aoi.length >= 3 && <button onClick={finishAoi} title="Finalizar AOI">✓</button>}
            {aoi.length >= 3 && <button onClick={analyzeAoi} title="Abrir Pop-up AOI">📊</button>}
          </div>

          {/* BARRINHA FLUTUANTE DE FORMAS DA AOI NO MAPA */}
          {(drawAoi || aoi.length >= 3) && (
            <div style={{ position: 'absolute', bottom: '20px', left: '50%', transform: 'translateX(-50%)', zIndex: 9, background: 'rgba(7,19,23,0.95)', border: '2px solid #ffb000', borderRadius: '14px', padding: '10px 14px', boxShadow: '0 12px 32px rgba(0,0,0,0.6)', display: 'flex', flexDirection: 'column', gap: '8px', minWidth: '340px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', fontSize: '11px' }}>
                <b style={{ color: '#ffb000' }}>⌗ BARRA DE FORMAS AOI:</b>
                <span style={{ color: '#9cddda' }}>
                  {!drawAoi ? 'AOI desenhada · Clique em 📊 Pop-up AOI' : aoiShapeMode === 'polygon' ? `Polígono (${aoi.length} pts) · Clique em ✓ Concluir` : aoiAnchor ? 'Mova o mouse e clique no 2º ponto para fechar' : 'Clique no 1º ponto no mapa'}
                </span>
              </div>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {([
                  ['rectangle', '▭ Retângulo'],
                  ['square', '◻ Quadrado'],
                  ['circle', '◯ Círculo'],
                  ['polygon', '⬠ Polígono'],
                ] as const).map(([mode, lbl]) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => selectAoiShape(mode)}
                    style={{ padding: '6px 12px', borderRadius: '8px', border: drawAoi && aoiShapeMode === mode ? '2px solid #ffb000' : '1px solid rgba(121,226,220,0.3)', background: drawAoi && aoiShapeMode === mode ? 'rgba(255,176,0,0.25)' : 'rgba(255,255,255,0.06)', color: '#fff', fontWeight: 700, fontSize: '12px', cursor: 'pointer' }}
                  >
                    {lbl}
                  </button>
                ))}
                {drawAoi && aoiShapeMode === 'polygon' && aoi.length >= 3 && (
                  <button type="button" onClick={finishAoi} style={{ padding: '6px 12px', borderRadius: '8px', border: '1.5px solid #34d399', background: 'rgba(52,211,153,0.22)', color: '#6ee7b7', fontWeight: 800, fontSize: '12px', cursor: 'pointer' }}>
                    ✓ Concluir
                  </button>
                )}
                {aoi.length >= 3 && (
                  <button type="button" onClick={analyzeAoi} style={{ padding: '6px 12px', borderRadius: '8px', border: '1.5px solid #38bdf8', background: 'rgba(56,189,248,0.25)', color: '#bae6fd', fontWeight: 800, fontSize: '12px', cursor: 'pointer' }}>
                    📊 Abrir Pop-up AOI
                  </button>
                )}
                <button type="button" onClick={clearAoi} style={{ padding: '6px 10px', borderRadius: '8px', border: '1px solid #f43f5e', background: 'rgba(244,63,94,0.18)', color: '#fda4af', fontWeight: 700, fontSize: '12px', cursor: 'pointer' }}>
                  ✕
                </button>
              </div>
            </div>
          )}
        </section>
        <div className="resize-handle" onPointerDown={() => { resizing.current = true; document.body.classList.add('is-resizing'); }} title={t.resize}><Icon name="resize" /></div>
        <aside className="control-rail">
          <div className="rail-scroll">
            <div className="scroll-map-tools">
              <button onClick={zoomIn}>＋</button><button onClick={zoomOut}>−</button>
              <button className={panEnabled ? 'active' : ''} onClick={togglePan}>✋</button>
              <button className={identifyMode ? 'active' : ''} onClick={toggleIdentify}>ⓘ</button>
              <button className={drawAoi ? 'active' : ''} onClick={toggleAoi}>⌗</button>
            </div>
            <section className="rail-card start-card">
              <div className="card-kicker">00 / START HERE</div>
              <div className="card-heading"><h3>{lang === 'pt' ? 'Primeiros passos' : 'Start here'}</h3><span className="chip">{tutorialStep + 1}/4</span></div>
              <div className="start-actions">
                <button onClick={() => { setTutorialStep(0); setShowTutorial(true); }}>▶ Tutorial</button>
                <button onClick={() => setShowMethod(true)}>◈ {t.method}</button><button onClick={() => setShowHelp(true)}>？ {t.help}</button>
                <button onClick={() => setShowLimits(true)}>△ {t.limitation}</button><button onClick={() => setShowMeta(true)} disabled={!raster}>⌁ {t.metadata}</button>
              </div>
            </section>
            <section className="rail-card hero-card">
              <div className="card-kicker">01 / INPUT</div><h2>{t.upload}</h2><p>{t.uploadHint}</p>
              <label className="file-drop" style={{ cursor: 'pointer', position: 'relative', zIndex: 10 }}>
                <input type="file" accept=".tif,.tiff,image/tiff,application/geotiff,application/octet-stream" style={{ position: 'absolute', inset: 0, opacity: 0, width: '100%', height: '100%', cursor: 'pointer', zIndex: 12 }} onChange={(e) => void handleFileChange(e.target.files?.[0] || null)} />
                <span className="upload-icon">↑</span><strong>{file ? file.name : 'Escolher GeoTIFF'}</strong>
                <small>{file ? `${(file.size / 1024 / 1024).toFixed(1)} MB · ${visibleBandCount} bandas` : 'TIFF / BigTIFF supported'}</small>
              </label>
              <div className="band-grid">
                <h3>{t.bands}</h3>
                <label>{t.red}<select value={bands[0]} onChange={(e) => updateBand(0, e.target.value)}>{options}</select></label>
                <label>{t.nir}<select value={bands[1]} onChange={(e) => updateBand(1, e.target.value)}>{options}</select></label>
                <label>{t.swir}<select value={bands[2]} onChange={(e) => updateBand(2, e.target.value)}>{options}</select></label>
              </div>
              <div className="processing-log">
                <div className="processing-log-head"><b>Log de processamento</b><span>{busy ? 'em andamento' : processingLog.length ? 'concluído' : '—'}</span></div>
                {processingLog.length ? <div className="processing-log-list">{processingLog.map((en, i) => <div className={`processing-log-entry ${en.level}`} key={`${en.time}-${i}`}><time>{en.time}</time><span>{en.message}</span></div>)}</div> : <p>Clique em Calcular mapa térmico para iniciar.</p>}
              </div>
              <button className="primary-button" onClick={() => void processFile()} disabled={!file || busy}>{busy ? t.processing : t.calculate}<span>→</span></button>
              {(raster || file) && (
                <div className="button-row" style={{ marginTop: '8px' }}>
                  {differenceReady && comparisonMode !== 'main' && (
                    <button type="button" onClick={() => { setSwipeActive(false); setComparisonMode('main'); }}>
                      👁 Ver Mapa Principal
                    </button>
                  )}
                  <button type="button" onClick={clearMainAnalysis}>
                    ✕ Limpar principal
                  </button>
                </div>
              )}
              {error && <div className="error-box">{error}</div>}
            </section>
            {(raster || differenceReady || hoverSample || sample || identifyMode) && (
              <section className="rail-card inspector-rail-card">
                <div className="card-heading">
                  <h3>ⓘ {t.sample}</h3>
                  <span className="chip">{showingComparison && activeInspect?.diffTemp !== undefined ? 'Δ LST ±1σ' : displayMode === 'uhi' ? 'UHI 1m' : '°C'}</span>
                </div>
                <div className="inspector-split">
                  <div>
                    {showingComparison && activeInspect?.diffTemp !== undefined && differenceStats ? (
                      <>
                        <strong className="inspector-temperature" style={{ color: activeDiffInfo?.color }}>
                          {activeInspect.diffTemp >= 0 ? `+${activeInspect.diffTemp.toFixed(2)}°C` : `${activeInspect.diffTemp.toFixed(2)}°C`}
                        </strong>
                        <span className="inspector-uhi-class" style={{ display: 'block', marginTop: '4px' }}><b style={{ color: activeDiffInfo?.color }}>{activeDiffInfo?.label}</b></span>
                        <div className="inspector-coordinates" style={{ marginTop: '4px' }}>
                          Antes: <b>{activeInspect.beforeTemp?.toFixed(1) ?? '—'}°C</b> → Depois: <b>{activeInspect.afterTemp?.toFixed(1) ?? '—'}°C</b><br />
                          Desvio (1σ): ±{differenceStats.thresholdSigma.toFixed(2)}°C · Lat: {activeInspect.lat.toFixed(4)} · Lon: {activeInspect.lng.toFixed(4)}
                        </div>
                      </>
                    ) : (
                      <>
                        <strong className="inspector-temperature">{activeInspect ? `${activeInspect.temp.toFixed(1)}°C` : `${raster?.stats.mean.toFixed(1) ?? comparisonPrimary?.stats.mean.toFixed(1) ?? '—'}°C`}</strong>
                        {raster && (
                          <span className="inspector-uhi-class">
                            {activeInspect ? 'Nível local: ' : 'Média da cena · '}
                            <b>{activeInspect ? uhiClassLabel(activeInspect.temp, raster.stats, uhiMethod, uhiPower, lang) : `${raster.stats.min.toFixed(1)}°C – ${raster.stats.max.toFixed(1)}°C`}</b>
                          </span>
                        )}
                        {activeInspect && <div className="inspector-coordinates">Lat: {activeInspect.lat.toFixed(4)} · Lon: {activeInspect.lng.toFixed(4)}</div>}
                      </>
                    )}
                  </div>
                  <div className="side-legends">
                    <div className="side-legend">
                      <b>{showingComparison && comparisonMode === 'difference' && !swipeActive ? 'Escala ΔLST (±1σ)' : displayMode === 'uhi' ? 'Escala UHI' : `Paleta: ${palette}`}</b>
                      <i className="legend-gradient" style={{ background: showingComparison && comparisonMode === 'difference' && !swipeActive ? DIFFERENCE_GRADIENT_CSS : legendGradient }} />
                      <small>{showingComparison && comparisonMode === 'difference' && !swipeActive ? 'Diminuiu ← Igual → Aumentou' : `${raster?.stats.min.toFixed(1) ?? '—'}°C → ${raster?.stats.max.toFixed(1) ?? '—'}°C`}</small>
                    </div>
                  </div>
                </div>
                {raster && colorTempHistogram.length > 0 && (
                  <div style={{ marginTop: '12px', padding: '10px', background: 'rgba(0,0,0,0.22)', borderRadius: '8px', border: '1px solid rgba(121,226,220,0.14)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px', fontSize: '11px' }}><b>{t.histogram}</b><span>σ = {raster.stats.stdDev.toFixed(2)}°C</span></div>
                    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${colorTempHistogram.length}, 1fr)`, alignItems: 'end', gap: '2px', height: '64px', paddingBottom: '4px' }}>
                      {colorTempHistogram.map((b, idx) => <div key={idx} title={b.tempLabel} style={{ height: `${b.height}%`, background: b.color, borderRadius: '2px 2px 0 0' }} />)}
                    </div>
                    <div className="legend-gradient" style={{ background: legendGradient, height: '8px', borderRadius: '4px', margin: '2px 0 5px' }} />
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', opacity: 0.85 }}>
                      <span>{raster.stats.min.toFixed(1)}°C</span><span>Q25: {raster.stats.q25.toFixed(1)}°</span><b>μ: {raster.stats.mean.toFixed(1)}°C</b><span>Q75: {raster.stats.q75.toFixed(1)}°</span><span>{raster.stats.max.toFixed(1)}°C</span>
                    </div>
                  </div>
                )}
                <div className="control-row" style={{ marginTop: '10px' }}>
                  <span>Modo</span>
                  <select value={displayMode} onChange={(e) => setDisplayMode(e.target.value as 'temperature' | 'uhi')}>
                    <option value="temperature">Temperatura (°C)</option><option value="uhi">UHI / ilhas de calor (1m)</option>
                  </select>
                </div>
                {displayMode === 'temperature' ? (
                  <>
                    <div className="control-row">
                      <span>{t.palette}</span>
                      <select value={palette} onChange={(e) => setPalette(e.target.value as PaletteType)}>
                        <option value="ironbow">Ironbow (Perceptual HD)</option><option value="spectral">Spectral</option><option value="jet">Jet</option>
                        <option value="viridis">Viridis</option><option value="magma">Magma</option><option value="coolwarm">Coolwarm</option>
                        <option value="terrain">Terrain</option><option value="grayscale">Grayscale</option><option value="custom">Custom (Rápido)</option>
                      </select>
                    </div>
                    {palette === 'custom' && (
                      <div style={{ marginTop: '8px', padding: '8px', background: 'rgba(255,255,255,0.03)', borderRadius: '6px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                          <small style={{ fontSize: '11px' }}>Paradas de cor (instantâneo):</small>
                          <div style={{ display: 'flex', gap: '4px' }}>
                            <button type="button" style={{ padding: '2px 6px', fontSize: '10px' }} onClick={() => setDraftCustomColors((p) => [...p].reverse())}>⇄ Inverter</button>
                            <button type="button" style={{ padding: '2px 6px', fontSize: '10px' }} onClick={() => setDraftCustomColors(DEFAULT_CUSTOM_COLORS)}>↺ Reset</button>
                          </div>
                        </div>
                        <div className="custom-colors" style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: '6px' }}>
                          {draftCustomColors.map((col, idx) => <input key={idx} type="color" value={col} onChange={(e) => { const v = e.target.value; setDraftCustomColors((cs) => cs.map((it, i) => (i === idx ? v : it))); }} style={{ width: '100%', height: '28px', cursor: 'pointer', border: 'none', borderRadius: '4px' }} />)}
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div className="control-row">
                      <span>Clustering UHI</span>
                      <select value={uhiMethod} onChange={(e) => setUhiMethod(e.target.value as UhiClusterMethod)}>
                        <option value="zscore">Z-Score (Desvio-Padrão)</option><option value="quantiles">Quantis Adaptativos (IQR)</option>
                        <option value="natural">Quebras Naturais (Jenks-Otsu)</option><option value="kernel">Kernel Espacial (Gi* Hotspot)</option>
                      </select>
                    </div>
                    <div className="control-row">
                      <span>Potenciação (γ) <b>{uhiPower.toFixed(2)}x</b></span>
                      <input type="range" min="0.60" max="2.20" step="0.05" value={uhiPower} onChange={(e) => setUhiPower(Number(e.target.value))} />
                    </div>
                  </>
                )}
              </section>
            )}
            <section className="rail-card">
              <div className="card-heading"><h3><Icon name="layers" /> {t.layers}</h3></div>
              <LayerRow label={t.lst} visible={visibleLst} onToggle={() => setVisibleLst(!visibleLst)} color="thermal" />
              <LayerRow label={t.optical} visible={visibleOptical} onToggle={() => setVisibleOptical(!visibleOptical)} color="optical" />
              {raster && <LayerRow label="Clusterizar / Isotermas (vetor)" visible={uhiSurfaceVisible} onToggle={() => setUhiSurfaceVisible(!uhiSurfaceVisible)} color="thermal" />}
              <div className="control-row"><span>{t.basemap}</span><select value={provider} onChange={(e) => setProvider(e.target.value as Provider)}><option value="osm">OpenStreetMap</option><option value="esri">Esri World Imagery</option></select></div>
              <div className="control-row"><span>{t.opacity}</span><input type="range" min="0" max="1" step="0.05" value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} /></div>
              <div className="control-row"><span>{t.contrast}</span><input type="range" min="-1" max="1" step="0.05" value={contrast} onChange={(e) => setContrast(Number(e.target.value))} /></div>
            </section>
            <section className="rail-card compare-card">
              <div className="card-heading"><h3>{t.compare}</h3><span className="chip">{comparisonImages.length ? `${comparisonImages.length} LST` : '—'}</span></div>
              <div className="control-row comparison-count">
                <span>Quantidade de imagens</span>
                <select value={comparisonCount} onChange={(e) => { const v = Number(e.target.value); setComparisonCount(v); setComparisonFiles((p) => Array.from({ length: v }, (_, i) => p[i] ?? null)); setComparisonImages([]); setDifferenceReady(false); }}>
                  {[2, 3, 4, 5, 6].map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </div>
              <div className="comparison-file-list">
                {comparisonFiles.map((sel, idx) => (
                  <label className="comparison-file" key={idx} style={{ cursor: 'pointer', position: 'relative' }}>
                    <span><b>{idx === 0 ? 'Imagem 1 (ANTES)' : idx === 1 ? 'Imagem 2 (DEPOIS)' : `Imagem ${idx + 1}`}</b><small>{sel ? `${imageDateLabel(sel.name, idx)} · ${sel.name}` : 'Selecionar GeoTIFF SR2D4/MS'}</small></span>
                    <input type="file" accept=".tif,.tiff,image/tiff,application/geotiff,application/octet-stream" style={{ position: 'absolute', inset: 0, opacity: 0, width: '100%', height: '100%', cursor: 'pointer', zIndex: 12 }} onChange={(e) => { const sf = e.target.files?.[0] ?? null; setComparisonFiles((p) => p.map((it, i) => (i === idx ? sf : it))); setDifferenceReady(false); }} disabled={busy} />
                  </label>
                ))}
              </div>
              <div className="compare-actions">
                <button onClick={() => void calculateComparisons()} disabled={busy || comparisonFiles.filter(Boolean).length < 2}>{busy ? 'Processando…' : 'Calcular Δ LST (Depois − Antes)'}</button>
                <button onClick={() => { setSwipeActive(false); setComparisonMode('difference'); }} disabled={!differenceReady} className={!swipeActive && showingComparison && comparisonMode === 'difference' ? 'active' : ''}>Mapa Diferença</button>
                <button onClick={() => { setComparisonMode('difference'); setSwipeActive(!swipeActive); }} disabled={!differenceReady} className={swipeActive && showingComparison ? 'active' : ''}>{swipeActive && showingComparison ? 'Cortina Fixa Ativa' : 'Cortina (Antes/Depois)'}</button>
                <button onClick={() => void downloadComparisonPanel()} disabled={!differenceReady}>Exportar A / B / Δ</button>
                {raster && differenceReady && (
                  <button type="button" className={comparisonMode === 'main' ? 'active' : ''} onClick={() => { setSwipeActive(false); setComparisonMode(comparisonMode === 'main' ? 'difference' : 'main'); }}>
                    {comparisonMode === 'main' ? '👁 Voltar para Comparação' : '👁 Ver Data Principal'}
                  </button>
                )}
                {(differenceReady || comparisonFiles.some(Boolean)) && (
                  <button type="button" onClick={clearComparisonAnalysis}>
                    ✕ Limpar comparação
                  </button>
                )}
              </div>
              {swipeActive && showingComparison && (
                <label className="swipe-control">
                  <span>◀ ANTES ({comparisonPrimary?.dateLabel}) | DEPOIS ({comparisonSecondary?.dateLabel}) ▶ <b>{swipePosition.toFixed(0)}%</b></span>
                  <input type="range" min="0" max="100" value={swipePosition} onChange={(e) => setSwipePosition(Number(e.target.value))} />
                </label>
              )}
            </section>

            {/* SEÇÃO AOI SEMPRE VISÍVEL COM BARRINHA DE 4 FORMAS */}
            <section className="rail-card">
              <div className="card-heading"><h3>⌗ {t.aoi}</h3><span className="chip">{aoi.length ? `${aoi.length} pts` : aoiShapeMode}</span></div>
              <p className="microcopy">{aoiStats ? `Média AOI: ${aoiStats.mean.toFixed(2)}°C (${aoiStats.min.toFixed(1)}–${aoiStats.max.toFixed(1)}°C · ${aoiStats.count.toLocaleString('pt-BR')} px)` : t.aoiHelp}</p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '6px', marginBottom: '8px' }}>
                {([
                  ['rectangle', '▭ Retângulo'],
                  ['square', '◻ Quadrado'],
                  ['circle', '◯ Círculo'],
                  ['polygon', '⬠ Polígono'],
                ] as const).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    className={drawAoi && aoiShapeMode === mode ? 'active' : ''}
                    onClick={() => selectAoiShape(mode)}
                    style={{ padding: '8px 6px', fontSize: '12px', fontWeight: 700, border: drawAoi && aoiShapeMode === mode ? '2px solid #ffb000' : undefined }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="button-row">
                <button onClick={drawAoi ? finishAoi : toggleAoi}>{drawAoi ? '✓ Concluir AOI' : t.draw}</button>
                <button disabled={aoi.length < 3 || !raster} onClick={analyzeAoi}>📊 {t.clip}</button>
                <button disabled={aoi.length === 0} onClick={clearAoi}>✕ {t.clear}</button>
              </div>
            </section>

            {raster && (
              <>
                <section className="rail-card">
                  <div className="card-heading"><h3>{t.stats}</h3><span className="chip">°C</span></div>
                  <div className="metric-grid">
                    <Metric label={t.min} value={raster.stats.min.toFixed(1)} /><Metric label={t.mean} value={raster.stats.mean.toFixed(1)} />
                    <Metric label={t.max} value={raster.stats.max.toFixed(1)} /><Metric label={t.std} value={raster.stats.stdDev.toFixed(2)} />
                  </div>
                </section>
                <section className="rail-card">
                  <div className="card-heading"><h3>{t.indices}</h3><span className="chip">MS</span></div>
                  <div className="metric-grid index-grid"><Metric label={t.ndvi} value={meanOf(raster.ndvi).toFixed(3)} /><Metric label={t.ndbi} value={meanOf(raster.ndbi).toFixed(3)} /></div>
                </section>
                <section className="rail-card">
                  <div className="card-heading"><h3>{t.export}</h3></div>
                  <div className="export-grid">
                    <button onClick={() => setUhiSurfaceVisible(!uhiSurfaceVisible)}>{uhiSurfaceVisible ? 'Ocultar Isotermas' : 'Ver Isotermas (Meso)'}</button>
                    <button onClick={() => exportVectorIsotherms('geojson')}>Isotermas GeoJSON</button>
                    <button onClick={() => exportVectorIsotherms('kml')}>Isotermas KML</button>
                    <button onClick={exportPng}>{t.png}</button>
                    <button onClick={() => downloadFloat32Tiff(raster.data, raster.width, raster.height, 'LST-SR2D4.tif', raster.origin, raster.resolution, raster.epsg, raster.isProjected)}>{t.tiff}</button>
                    <button onClick={() => downloadUhiTiff(raster.data, raster.width, raster.height, 'UHI-SR2D4.tif', raster.origin, raster.resolution, raster.epsg, raster.isProjected, raster.stats.mean, raster.stats.stdDev)}>{t.uhi}</button>
                    <button disabled={!uhiSurface} onClick={() => uhiSurface && downloadUhiSurface(uhiSurface)}>Grade UHI GeoJSON</button>
                    <button onClick={() => void downloadReport()}>{t.report}</button>
                  </div>
                </section>
              </>
            )}
          </div>
        </aside>
      </main>

      {/* POP-UP DEDICADO DE ANÁLISE DA AOI COM 5 OPÇÕES DE EXPORTAÇÃO */}
      {showAoiModal && aoiDetailed && raster && (
        <div className="dialog-backdrop" onClick={() => setShowAoiModal(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(3,10,14,0.8)', backdropFilter: 'blur(6px)', zIndex: 9999, display: 'grid', placeItems: 'center', padding: '20px' }}>
          <div className="dialog-card" onClick={(e) => e.stopPropagation()} style={{ width: 'min(940px, 96vw)', maxHeight: '90vh', overflowY: 'auto', background: '#0b1b22', border: '2px solid #ffb000', borderRadius: '18px', padding: '24px', color: '#fff', position: 'relative' }}>
            <button className="dialog-close" onClick={() => setShowAoiModal(false)}>×</button>
            <div className="card-kicker" style={{ color: '#ffb000' }}>⌗ DIAGNÓSTICO DE ÁREA DE INTERESSE (AOI)</div>
            <h2 style={{ margin: '4px 0 6px' }}>Análise Espacial da AOI ({aoiDetailed.shapeMode.toUpperCase()})</h2>
            <p style={{ margin: '0 0 16px', fontSize: '13px', color: '#9cddda' }}>
              Área útil: <b>{aoiDetailed.areaHa.toFixed(2)} ha</b> ({aoiDetailed.areaM2.toFixed(0)} m²) · <b>{aoiDetailed.count.toLocaleString('pt-BR')}</b> píxeis válidos no raster numérico · EPSG:{raster.epsg}
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '16px' }}>
              <div style={{ background: '#071317', border: '1px solid rgba(121,226,220,0.25)', borderRadius: '12px', padding: '12px', textAlign: 'center' }}>
                <img src={aoiDetailed.previewDataUrl} alt="Preview AOI" style={{ maxWidth: '100%', maxHeight: '280px', objectFit: 'contain', borderRadius: '8px', border: '1px solid #ffb000' }} />
                <small style={{ display: 'block', marginTop: '8px', color: '#9ab0b5' }}>Recorte: {aoiDetailed.clipWidth} × {aoiDetailed.clipHeight} px</small>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px' }}>
                  <div style={{ background: 'rgba(255,255,255,0.05)', padding: '10px', borderRadius: '8px' }}><small style={{ color: '#9ab0b5', display: 'block', fontSize: '11px' }}>Mínima</small><strong style={{ fontSize: '18px', color: '#38bdf8' }}>{aoiDetailed.min.toFixed(1)} °C</strong></div>
                  <div style={{ background: 'rgba(255,255,255,0.05)', padding: '10px', borderRadius: '8px' }}><small style={{ color: '#9ab0b5', display: 'block', fontSize: '11px' }}>Média (μ)</small><strong style={{ fontSize: '18px', color: '#ffb000' }}>{aoiDetailed.mean.toFixed(2)} °C</strong></div>
                  <div style={{ background: 'rgba(255,255,255,0.05)', padding: '10px', borderRadius: '8px' }}><small style={{ color: '#9ab0b5', display: 'block', fontSize: '11px' }}>Máxima</small><strong style={{ fontSize: '18px', color: '#f43f5e' }}>{aoiDetailed.max.toFixed(1)} °C</strong></div>
                  <div style={{ background: 'rgba(255,255,255,0.05)', padding: '10px', borderRadius: '8px' }}><small style={{ color: '#9ab0b5', display: 'block', fontSize: '11px' }}>Mediana (Q50)</small><strong>{aoiDetailed.q50.toFixed(2)} °C</strong></div>
                  <div style={{ background: 'rgba(255,255,255,0.05)', padding: '10px', borderRadius: '8px' }}><small style={{ color: '#9ab0b5', display: 'block', fontSize: '11px' }}>Q25 – Q75</small><strong>{aoiDetailed.q25.toFixed(1)}–{aoiDetailed.q75.toFixed(1)}°</strong></div>
                  <div style={{ background: 'rgba(255,255,255,0.05)', padding: '10px', borderRadius: '8px' }}><small style={{ color: '#9ab0b5', display: 'block', fontSize: '11px' }}>Desvio (σ)</small><strong>±{aoiDetailed.stdDev.toFixed(2)} °C</strong></div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', fontSize: '12px' }}>
                  <div style={{ background: 'rgba(52,211,153,0.12)', padding: '8px 10px', borderRadius: '8px', border: '1px solid #34d399' }}>🌿 NDVI: <b>{aoiDetailed.ndviMean.toFixed(3)}</b> (Veg: {aoiDetailed.vegPct.toFixed(1)}%)</div>
                  <div style={{ background: 'rgba(251,146,60,0.12)', padding: '8px 10px', borderRadius: '8px', border: '1px solid #fb923c' }}>🏢 NDBI: <b>{aoiDetailed.ndbiMean.toFixed(3)}</b> (Const: {aoiDetailed.builtPct.toFixed(1)}%)</div>
                </div>
                <div style={{ background: 'rgba(0,0,0,0.28)', padding: '10px', borderRadius: '8px', fontSize: '11px' }}>
                  <b style={{ display: 'block', marginBottom: '6px', color: '#9cddda' }}>Classes UHI dentro da AOI:</b>
                  {['1. Frescor', '2. Amenizado', '3. Neutro', '4. UHI Moderada', '5. UHI Forte', '6. Hotspot Extremo'].map((lbl, idx) => (
                    <div key={lbl} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '3px' }}>
                      <span>{lbl}</span>
                      <b>{aoiDetailed.uhiPcts[idx].toFixed(1)}% ({aoiDetailed.uhiCounts[idx].toLocaleString('pt-BR')} px)</b>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div style={{ marginTop: '18px', paddingTop: '14px', borderTop: '1px solid rgba(121,226,220,0.25)', display: 'flex', flexWrap: 'wrap', gap: '8px', justifyContent: 'space-between', alignItems: 'center' }}>
              <b style={{ fontSize: '12px', color: '#ffb000' }}>⇩ Exportar recorte da AOI:</b>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                <button type="button" onClick={() => void downloadAoiModalPng()} style={{ padding: '8px 14px', borderRadius: '8px', background: '#ffb000', color: '#071317', fontWeight: 800, border: 'none', cursor: 'pointer' }}>🖼 PNG (com legenda)</button>
                <button type="button" onClick={downloadAoiModalTiff} style={{ padding: '8px 14px', borderRadius: '8px', background: 'rgba(121,226,220,0.18)', color: '#79e2dc', fontWeight: 700, border: '1px solid #79e2dc', cursor: 'pointer' }}>🗺 GeoTIFF (LST)</button>
                <button type="button" onClick={downloadAoiModalGeoJson} style={{ padding: '8px 14px', borderRadius: '8px', background: 'rgba(255,255,255,0.1)', color: '#fff', fontWeight: 700, border: '1px solid rgba(255,255,255,0.3)', cursor: 'pointer' }}>📐 GeoJSON</button>
                <button type="button" onClick={downloadAoiModalKml} style={{ padding: '8px 14px', borderRadius: '8px', background: 'rgba(255,255,255,0.1)', color: '#fff', fontWeight: 700, border: '1px solid rgba(255,255,255,0.3)', cursor: 'pointer' }}>🌍 KML</button>
                <button type="button" onClick={downloadAoiModalCsv} style={{ padding: '8px 14px', borderRadius: '8px', background: 'rgba(255,255,255,0.1)', color: '#fff', fontWeight: 700, border: '1px solid rgba(255,255,255,0.3)', cursor: 'pointer' }}>📊 CSV</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {(showMethod || showHelp || showMeta || showLimits) && (
        <div className="dialog-backdrop" onClick={() => { setShowMethod(false); setShowHelp(false); setShowMeta(false); setShowLimits(false); }}>
          <div className="dialog-card" onClick={(e) => e.stopPropagation()}>
            <button className="dialog-close" onClick={() => { setShowMethod(false); setShowHelp(false); setShowMeta(false); setShowLimits(false); }}>×</button>
            <div className="card-kicker">SR2D4 / LST EXPLORER</div>
            <h2>{showMethod ? t.method : showHelp ? t.help : showLimits ? t.limitation : t.metadata}</h2>
            {showMethod && <p>{t.methodText}</p>}{showHelp && <p>{t.helpText}</p>}{showLimits && <p>{t.limitationText}</p>}
            {showMeta && raster && <div className="meta-list"><span><b>File</b>{raster.fileName}</span><span><b>Dimensions</b>{raster.width} × {raster.height}</span><span><b>EPSG</b>{raster.epsg}</span></div>}
          </div>
        </div>
      )}
      {showTutorial && (
        <div className="tutorial-backdrop">
          <div className="tutorial-card">
            <div className="card-kicker">SR2D4 / LST EXPLORER</div>
            <h2>{['Explore o mapa', 'Carregue suas bandas', 'Calcule a temperatura', 'Compare e exporte'][tutorialStep]}</h2>
            <p>{[t.helpText, t.methodText, t.uhiText, t.limitationText][tutorialStep]}</p>
            <div className="tutorial-actions">
              <button onClick={closeTutorial}>Pular</button>
              {tutorialStep < 3 ? <button className="primary-button" onClick={() => setTutorialStep((s) => s + 1)}>Próximo →</button> : <button className="primary-button" onClick={closeTutorial}>Começar →</button>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
// FIM DO ARQUIVO src/App.tsx v3.0
