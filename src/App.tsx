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
import { downloadExpandedTechnicalReport } from './reportExpanded';
import {
  AoiAnalysisModal,
  AoiToolbar,
  analyzeAoiDetailed,
  buildShapeVertices,
  type AoiDetailedStats,
  type AoiShapeMode,
} from './aoiToolkit';

type Lang = 'pt' | 'en';
type Theme = 'light' | 'dark';
type Provider = 'osm' | 'esri';
type UhiClusterMethod = 'zscore' | 'quantiles' | 'natural' | 'kernel';
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
type OsmFeatureStat = {
  name: string;
  kind: 'Bairro / Setor' | 'Via / Corredor' | 'Parque / Referência';
  meanTemp: number;
  maxTemp: number;
  ndvi: number;
  ndbi: number;
  uhiClass: string;
  mobilityRisk: string;
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
    eyebrow: 'OPEN SOURCE • WEB GIS', title: 'SR2D4 / LST Explorer',
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
    helpText: '1. Gere o produto MS no Colab com AAAAMMDD e _MS.tif. 2. Carregue o GeoTIFF SR2D4. 3. Confirme Red/NIR/SWIR. 4. Escolha a forma da AOI (Retângulo, Quadrado, Círculo ou Polígono) ou gere o Relatório Executivo.',
    noData: 'Carregue um GeoTIFF para começar', search: 'Buscar cidade, bairro ou lugar', coords: 'Longitude, latitude',
    locate: 'Minha localização', go: 'Ir', compare: 'Comparar antes/depois', indices: 'Índices espectrais',
    ndvi: 'NDVI vegetação', ndbi: 'NDBI construído', report: 'Relatório Executivo', resize: 'Arraste para redimensionar o painel',
    searchError: 'Local não encontrado.', uhiText: 'Níveis UHI (1m): Frescor, Amenizado, Neutro, Leve, Forte e Extremo.',
    aoiHelp: 'Escolha a forma geométrica (Retângulo, Quadrado, Círculo ou Polígono), desenhe no mapa e veja o diagnóstico em Pop-up.',
    limitation: 'Limitações da super-resolução',
    limitationText: 'A LST detalhada é uma estimativa guiada por índices ópticos e reflectância de 1m. Use-a para investigação espacial e comparação.',
  },
  en: {
    eyebrow: 'OPEN SOURCE • WEB GIS', title: 'SR2D4 / LST Explorer',
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
    helpText: '1. Generate the MS product in Colab. 2. Load the GeoTIFF. 3. Confirm Red/NIR/SWIR. 4. Draw AOI shapes or export the Executive Report.',
    noData: 'Load a GeoTIFF to begin', search: 'Search city, neighborhood or place', coords: 'Longitude, latitude',
    locate: 'My location', go: 'Go', compare: 'Compare before/after', indices: 'Spectral indices',
    ndvi: 'NDVI vegetation', ndbi: 'NDBI built-up', report: 'Executive Report', resize: 'Drag to resize the panel',
    searchError: 'Place not found.', uhiText: 'UHI levels (1m): Cool island, Mitigated, Neutral, Mild, Strong and Extreme.',
    aoiHelp: 'Select shape (Rectangle, Square, Circle, Polygon), draw on map and open the Pop-up analysis.',
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
      sqSum += d * d;
      sqCount += 1;
      anomSamples.push(Math.abs(d));
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

// Consulta ruas, avenidas, bairros e parques reais da base OpenStreetMap (Overpass API) e cruza com os pixels de 1m do raster
async function fetchOsmUrbanFeatures(raster: RasterState) {
  const ext = boundsExtent(raster.bounds);
  const sampleAt = (lng: number, lat: number) => {
    const x = Math.floor(((lng - ext.west) / (ext.east - ext.west)) * raster.width);
    const y = Math.floor(((ext.north - lat) / (ext.north - ext.south)) * raster.height);
    if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) return null;
    let sumT = 0; let maxT = -Infinity; let sumV = 0; let sumB = 0; let cnt = 0;
    for (let ky = -3; ky <= 3; ky += 1) {
      for (let kx = -3; kx <= 3; kx += 1) {
        const nx = Math.max(0, Math.min(raster.width - 1, x + kx));
        const ny = Math.max(0, Math.min(raster.height - 1, y + ky));
        const idx = ny * raster.width + nx;
        const t = raster.data[idx];
        if (Number.isFinite(t)) {
          sumT += t;
          if (t > maxT) maxT = t;
          sumV += Number.isFinite(raster.ndvi[idx]) ? raster.ndvi[idx] : 0;
          sumB += Number.isFinite(raster.ndbi[idx]) ? raster.ndbi[idx] : 0;
          cnt += 1;
        }
      }
    }
    if (!cnt) return null;
    const meanTemp = sumT / cnt;
    return { meanTemp, maxTemp: maxT, ndvi: sumV / cnt, ndbi: sumB / cnt, count: cnt };
  };

  const bairrosMap = new Map<string, OsmFeatureStat & { id?: string; count?: number;highway?: string }>();
  const viasMap = new Map<string, OsmFeatureStat & { id?: string; count?: number; highway?: string }>();
  const parquesMap = new Map<string, OsmFeatureStat>();

  try {
    const query = `[out:json][timeout:6];(node["place"~"suburb|neighbourhood|quarter"](${ext.south},${ext.west},${ext.north},${ext.east});way["highway"~"primary|secondary|tertiary|trunk|residential"]["name"](${ext.south},${ext.west},${ext.north},${ext.east});way["leisure"~"park|nature_reserve|pitch"]["name"](${ext.south},${ext.west},${ext.north},${ext.east}););out center 120;`;
    const resp = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`);
    if (resp.ok) {
      const json = (await resp.json()) as { elements?: any[] };
      for (const el of json.elements ?? []) {
        const name = el.tags?.name;
        if (!name) continue;
        const lat = el.lat ?? el.center?.lat;
        const lon = el.lon ?? el.center?.lon;
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const s = sampleAt(lon, lat);
        if (!s) continue;
        const uhiClass = uhiClassLabel(s.meanTemp, raster.stats, 'zscore', 1.1, 'pt');
        const mobilityRisk = s.meanTemp > raster.stats.mean + 0.85 * raster.stats.stdDev ? 'Crítico' : s.meanTemp > raster.stats.mean ? 'Moderado' : 'Adequado';
        const osmId = `${el.type}/${el.id}`;
        if (el.tags?.place) {
          if (!bairrosMap.has(name)) bairrosMap.set(name, { name, id: osmId, kind: 'Bairro / Setor', ...s, uhiClass, mobilityRisk });
        } else if (el.tags?.highway) {
          const existing = viasMap.get(name);
          if (!existing || s.meanTemp > existing.meanTemp) {
            viasMap.set(name, { name, id: osmId, highway: el.tags.highway, kind: 'Via / Corredor', ...s, uhiClass, mobilityRisk });
          }
        } else if (!parquesMap.has(name)) {
          parquesMap.set(name, { name, kind: 'Parque / Referência', ...s, uhiClass, mobilityRisk });
        }
      }
    }
  } catch { /* ignore network error */ }

  const bairros = [...bairrosMap.values()].sort((a, b) => b.meanTemp - a.meanTemp).slice(0, 10);
  const vias = [...viasMap.values()].sort((a, b) => b.meanTemp - a.meanTemp).slice(0, 15);
  const parques = [...parquesMap.values()].sort((a, b) => a.meanTemp - b.meanTemp).slice(0, 6);

  return {
    bairros,
    neighborhoods: bairros,
    vias,
    ruas: vias,
    streets: vias,
    parques,
  };
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
    const map = mapInstance.current; if (!map || !map.isStyleLoaded()) return;
    const src = map.getSource('aoi-source') as maplibregl.GeoJSONSource | undefined;
    const pts = aoi.slice(0, 12).map((pt) => ({ type: 'Feature' as const, properties: {}, geometry: { type: 'Point' as const, coordinates: pt } }));
    const line = aoi.length >= 2 ? [{ type: 'Feature' as const, properties: {}, geometry: { type: 'LineString' as const, coordinates: aoi.length >= 3 ? [...aoi, aoi[0]] : aoi } }] : [];
    const poly = aoi.length >= 3 ? [{ type: 'Feature' as const, properties: {}, geometry: { type: 'Polygon' as const, coordinates: [[...aoi, aoi[0]]] } }] : [];
    const data = { type: 'FeatureCollection' as const, features: [...poly, ...line, ...pts] };
    if (src) src.setData(data as any);
    else {
      map.addSource('aoi-source', { type: 'geojson', data: data as any });
      map.addLayer({ id: 'aoi-fill', type: 'fill', source: 'aoi-source', filter: ['==', '$type', 'Polygon'], paint: { 'fill-color': '#ffb000', 'fill-opacity': 0.2 } });
      map.addLayer({ id: 'aoi-line', type: 'line', source: 'aoi-source', filter: ['==', '$type', 'LineString'], paint: { 'line-color': '#ffb000', 'line-width': 3, 'line-dasharray': [2, 1] } });
      map.addLayer({ id: 'aoi-pts', type: 'circle', source: 'aoi-source', filter: ['==', '$type', 'Point'], paint: { 'circle-radius': 5, 'circle-color': '#ffb000', 'circle-stroke-color': '#071317', 'circle-stroke-width': 2 } });
    }
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

  // Relatório Técnico Expandido com Mapas LST + UHI, Bairros/Ruas OSM e Botão PT/EN
  const downloadReport = async () => {
    if (!raster || !lstCanvas.current || !opticalCanvas.current) return;
    setStatus('Lendo ruas e bairros da base OpenStreetMap e gerando relatório expandido…');
    const osm = await fetchOsmUrbanFeatures(raster);
    downloadExpandedTechnicalReport({
      raster,
      opticalCanvas: opticalCanvas.current,
      lstCanvas: lstCanvas.current,
      opacity,
      paletteName: palette,
      uhiMethod,
      uhiPower,
      aoiStats: aoiStats ? { vertices: aoi, ...aoiStats } : null,
      diffStats:
        differenceReady && differenceStats && comparisonPrimary && comparisonSecondary
          ? {
              beforeLabel: comparisonPrimary.dateLabel,
              afterLabel: comparisonSecondary.dateLabel,
              ...differenceStats,
            }
          : null,
      osmData: osm,
    });
    setStatus('Relatório técnico expandido exportado.');
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
  };
  const clearAoi = () => {
    setAoi([]);
    setAoiAnchor(null);
    setAoiStats(null);
    setAoiDetailed(null);
    setShowAoiModal(false);
    setDrawAoi(false);
    setPanEnabled(true);
  };
  const analyzeAoi = () => {
    if (!raster || aoi.length < 3) return;
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
      setDrawAoi(false);
      setAoiAnchor(null);
      setPanEnabled(true);
      analyzeAoi();
    }
  };
  const toggleAoi = () => {
    const n = !drawAoi;
    setDrawAoi(n);
    setIdentifyMode(false);
    setAoiAnchor(null);
    if (n) {
      setAoi([]);
      setAoiStats(null);
      setAoiDetailed(null);
    }
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
            {!drawAoi && aoi.length >= 3 && <button onClick={analyzeAoi} title="Abrir Pop-up AOI">📊</button>}
          </div>
          <AoiToolbar
            active={drawAoi}
            shapeMode={aoiShapeMode}
            vertexCount={aoi.length}
            hasAnchor={Boolean(aoiAnchor)}
            hasStats={Boolean(aoiDetailed)}
            onSelectShape={selectAoiShape}
            onFinishPolygon={finishAoi}
            onOpenPopup={analyzeAoi}
            onClear={clearAoi}
          />
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
              {differenceReady && differenceStats && (
                <div style={{ marginTop: '10px', padding: '10px', background: 'rgba(0,0,0,0.26)', borderRadius: '8px', border: '1px solid rgba(121,226,220,0.18)' }}>
                  <b style={{ fontSize: '11px', display: 'block', marginBottom: '6px' }}>Escala de Mudança Térmica (±1σ = ±{differenceStats.thresholdSigma.toFixed(2)}°C)</b>
                  <div className="legend-gradient" style={{ background: DIFFERENCE_GRADIENT_CSS, height: '10px', borderRadius: '5px', marginBottom: '8px' }} />
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px', textAlign: 'center', fontSize: '11px' }}>
                    <div style={{ padding: '6px', background: 'rgba(0,150,199,0.18)', border: '1px solid #48cae4', borderRadius: '6px' }}>
                      <b style={{ color: '#48cae4', display: 'block' }}>↓ DIMINUIU</b><span>&lt; -1σ</span><strong style={{ display: 'block', fontSize: '13px' }}>{differenceStats.pctDecreased.toFixed(1)}%</strong>
                    </div>
                    <div style={{ padding: '6px', background: 'rgba(148,163,184,0.14)', border: '1px solid #94a3b8', borderRadius: '6px' }}>
                      <b style={{ color: '#cbd5e1', display: 'block' }}>＝ IGUAL</b><span>±1σ</span><strong style={{ display: 'block', fontSize: '13px' }}>{differenceStats.pctEqual.toFixed(1)}%</strong>
                    </div>
                    <div style={{ padding: '6px', background: 'rgba(247,127,0,0.18)', border: '1px solid #ff9e00', borderRadius: '6px' }}>
                      <b style={{ color: '#ff9e00', display: 'block' }}>↑ AUMENTOU</b><span>&gt; +1σ</span><strong style={{ display: 'block', fontSize: '13px' }}>{differenceStats.pctIncreased.toFixed(1)}%</strong>
                    </div>
                  </div>
                </div>
              )}
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
                  <div className="card-heading"><h3>{t.aoi}</h3><span className="chip">{aoi.length ? `${aoi.length} pts` : aoiShapeMode}</span></div>
                  <p className="microcopy">{aoiStats ? `Média AOI: ${aoiStats.mean.toFixed(2)}°C (${aoiStats.min.toFixed(1)}–${aoiStats.max.toFixed(1)}°C · ${aoiStats.count.toLocaleString('pt-BR')} px)` : t.aoiHelp}</p>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '6px', marginBottom: '8px' }}>
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
                        style={{
                          padding: '6px 4px',
                          fontSize: '11px',
                          fontWeight: 700,
                          border: drawAoi && aoiShapeMode === mode ? '1.5px solid #ffb000' : undefined,
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="button-row">
                    <button onClick={drawAoi ? finishAoi : toggleAoi}>{drawAoi ? '✓ Concluir AOI' : t.draw}</button>
                    <button disabled={aoi.length < 3} onClick={analyzeAoi}>📊 {t.clip}</button>
                    <button disabled={aoi.length === 0} onClick={clearAoi}>✕ {t.clear}</button>
                  </div>
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
      <AoiAnalysisModal
        open={showAoiModal}
        stats={aoiDetailed}
        raster={raster}
        onClose={() => setShowAoiModal(false)}
      />
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
// FIM DO ARQUIVO src/App.tsx
