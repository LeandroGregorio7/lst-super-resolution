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
type AoiShapeMode = 'polygon' | 'rectangle' | 'square' | 'circle';
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
    sample: 'Escala Térmica & Inspeção', aoi: 'Área de interesse', draw: 'Desenhar AOI', clear: 'Limpar AOI', clip: 'Analisar AOI',
    export: 'Exportar', png: 'PNG composto', tiff: 'GeoTIFF LST', uhi: 'GeoTIFF UHI', method: 'Metodologia', help: 'Como usar',
    metadata: 'Metadados', theme: 'Tema', basemap: 'Mapa-base', ready: 'Pronto',
    error: 'Não foi possível processar. Carregue um GeoTIFF SR2D4 com Red, NIR e SWIR; o Landsat térmico é buscado automaticamente.',
    methodText: 'O app extrai a data AAAAMMDD do nome do SR2D4, busca automaticamente a cena Landsat 8/9 Collection 2 Level-2 mais próxima, mascara nuvens com QA_PIXEL, decodifica ST_B10 e executa fusão física TsHARP HD 1m guiada por reflectância e índices ópticos.',
    helpText: '1. Gere o produto MS no Colab com AAAAMMDD e _MS.tif. 2. Carregue o GeoTIFF SR2D4. 3. Confirme Red/NIR/SWIR. 4. O app busca o Landsat automaticamente. 5. Explore LST, UHI, Isotermas, Comparação e Exportações.',
    noData: 'Carregue um GeoTIFF para começar', search: 'Buscar cidade, bairro ou lugar', coords: 'Longitude, latitude',
    locate: 'Minha localização', go: 'Ir', compare: 'Comparar antes/depois', indices: 'Índices espectrais',
    ndvi: 'NDVI vegetação', ndbi: 'NDBI construído', report: 'Relatório Executivo', resize: 'Arraste para redimensionar o painel',
    searchError: 'Local não encontrado.', uhiText: 'Níveis UHI (1m): Frescor, Amenizado, Neutro, Leve, Forte e Extremo.',
    aoiHelp: 'Clique em Desenhar AOI para abrir a barra de formas (Polígono, Retângulo, Quadrado ou Círculo). Duplo clique fecha o desenho.',
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
    sample: 'Thermal Scale & Inspection', aoi: 'Area of interest', draw: 'Draw AOI', clear: 'Clear AOI', clip: 'Analyze AOI',
    export: 'Export', png: 'Composite PNG', tiff: 'LST GeoTIFF', uhi: 'UHI GeoTIFF', method: 'Methodology', help: 'How it works',
    metadata: 'Metadata', theme: 'Theme', basemap: 'Basemap', ready: 'Ready',
    error: 'Processing failed. Load an SR2D4 GeoTIFF with Red, NIR and SWIR; thermal Landsat is fetched automatically.',
    methodText: 'The workflow combines SR2D4 imagery with optical indices and TsHARP regression to estimate 1m spatial LST.',
    helpText: '1. Generate the MS product in Colab. 2. Load the GeoTIFF. 3. Confirm Red/NIR/SWIR. 4. Calculate and explore LST, UHI, Isotherms and exports.',
    noData: 'Load a GeoTIFF to begin', search: 'Search city, neighborhood or place', coords: 'Longitude, latitude',
    locate: 'My location', go: 'Go', compare: 'Compare before/after', indices: 'Spectral indices',
    ndvi: 'NDVI vegetation', ndbi: 'NDBI built-up', report: 'Executive Report', resize: 'Drag to resize the panel',
    searchError: 'Place not found.', uhiText: 'UHI levels (1m): Cool island, Mitigated, Neutral, Mild, Strong and Extreme.',
    aoiHelp: 'Click Draw AOI to open the shape bar (Polygon, Rectangle, Square, Circle). Double-click to close.',
    limitation: 'Super-resolution limitations',
    limitationText: 'Detailed LST is an optical-guided estimate. Validate results with field data.',
  },
} as const;

function buildShapeVertices(mode: AoiShapeMode, start: [number, number], end: [number, number]): [number, number][] {
  const [x0, y0] = start;
  const [x1, y1] = end;
  if (mode === 'rectangle') {
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  }
  const cosLat = Math.max(0.2, Math.cos((y0 * Math.PI) / 180));
  if (mode === 'square') {
    const dxMeters = (x1 - x0) * cosLat;
    const dyMeters = y1 - y0;
    const side = Math.max(Math.abs(dxMeters), Math.abs(dyMeters));
    const sx = (side / cosLat) * (x1 >= x0 ? 1 : -1);
    const sy = side * (y1 >= y0 ? 1 : -1);
    return [[x0, y0], [x0 + sx, y0], [x0 + sx, y0 + sy], [x0, y0 + sy]];
  }
  if (mode === 'circle') {
    const dx = (x1 - x0) * cosLat;
    const dy = y1 - y0;
    const r = Math.sqrt(dx * dx + dy * dy);
    const pts: [number, number][] = [];
    const steps = 64;
    for (let i = 0; i < steps; i += 1) {
      const ang = (i / steps) * Math.PI * 2;
      pts.push([x0 + (Math.cos(ang) * r) / cosLat, y0 + Math.sin(ang) * r]);
    }
    return pts;
  }
  return [start, end];
}

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
    return `rgb(${Math.round(r)}, ${Math.round(g)},${Math.round(b)})`;
  }
  const stops = getPaletteStopList(palette, customColors).map(hexToRgbTuple);
  const maxSeg = stops.length - 1;
  const p = perceptualCoolExpansion(t) * maxSeg;
  const idx = Math.min(maxSeg - 1, Math.floor(p));
  const f = p - idx;
  const [r0, g0, b0] = stops[idx];
  const [r1, g1, b1] = stops[idx + 1];
  return `rgb(${Math.round(r0 + (r1 - r0) * f)}, ${Math.round(g0 + (g1 - g0) * f)},${Math.round(b0 + (b1 - b0) * f)})`;
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
        geometry: { type: 'MultiLineString'; coordinates: [number, number][][] }['coordinates'] ? { type: 'MultiLineString', coordinates: segments } : { type: 'MultiLineString', coordinates: segments },
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
  onProgress?.(`Fusão concluída: ${result.model} ·${result.validCount} células coarse · saída ${tiff.width.toLocaleString()}×${tiff.height.toLocaleString()} px · ${resLabel}`);
  return { tiff, bounds, indices, landsat, result };
}
function pointInPolygon(point: [number, number], polygon: [number, number][]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]; const [xj, yj] = polygon[j];
    if (((yi > point[1]) !== (yj > point[1])) && point[0] < ((xj - xi) * (point[1] - yi)) / ((yj - yi) || Number.EPSILON) + xi) inside = !inside;
  }
  return inside;
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

  // Estados da AOI com Barra Pop-up Flutuante e Formas (Polígono, Retângulo, Quadrado, Círculo)
  const [aoi, setAoi] = useState<[number, number][]>([]);
  const [drawAoi, setDrawAoi] = useState(false);
  const [showAoiPopup, setShowAoiPopup] = useState(false);
  const [aoiShapeMode, setAoiShapeMode] = useState<AoiShapeMode>('polygon');
  const [aoiAnchor, setAoiAnchor] = useState<[number, number] | null>(null);
  const [aoiHoverCoord, setAoiHoverCoord] = useState<[number, number] | null>(null);
  const [mapViewTick, setMapViewTick] = useState(0);
  const [aoiStats, setAoiStats] = useState<{ count: number; min: number; max: number; mean: number } | null>(null);

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

  const computeAoiStatsForPolygon = useCallback((poly: [number, number][]) => {
    if (!raster || poly.length < 3 || !extent) return;
    const vals: number[] = [];
    let w = Infinity; let e = -Infinity; let s = Infinity; let n = -Infinity;
    for (const pt of poly) { w = Math.min(w, pt[0]); e = Math.max(e, pt[0]); s = Math.min(s, pt[1]); n = Math.max(n, pt[1]); }
    const x0 = Math.max(0, Math.floor(((w - extent.west) / (extent.east - extent.west)) * raster.width));
    const x1 = Math.min(raster.width - 1, Math.ceil(((e - extent.west) / (extent.east - extent.west)) * raster.width));
    const y0 = Math.max(0, Math.floor(((extent.north - n) / (extent.north - extent.south)) * raster.height));
    const y1 = Math.min(raster.height - 1, Math.ceil(((extent.north - s) / (extent.north - extent.south)) * raster.height));
    for (let y = y0; y <= y1; y += 1) {
      const lat = extent.north - ((y + 0.5) / raster.height) * (extent.north - extent.south);
      const row = y * raster.width;
      for (let x = x0; x <= x1; x += 1) {
        const lng = extent.west + ((x + 0.5) / raster.width) * (extent.east - extent.west);
        const v = raster.data[row + x];
        if (Number.isFinite(v) && pointInPolygon([lng, lat], poly)) vals.push(v);
      }
    }
    if (!vals.length) { setAoiStats(null); return; }
    let min = Infinity; let max = -Infinity; let sum = 0;
    for (const v of vals) { if (v < min) min = v; if (v > max) max = v; sum += v; }
    setAoiStats({ count: vals.length, min, max, mean: sum / vals.length });
    setStatus(`AOI analisada · ${vals.length.toLocaleString('pt-BR')} pixels`);
  }, [extent, raster]);

  const mapClickMode = useRef({
    drawAoi: false, aoiShapeMode: 'polygon' as AoiShapeMode, aoiAnchor: null as [number, number] | null,
    raster: null as RasterState | null, extent: null as ReturnType<typeof boundsExtent> | null,
    identifyMode: false, comparisonPrimary: null as ComparisonImage | null,
    comparisonSecondary: null as ComparisonImage | null, differenceData: null as Float32Array | null,
    showingComparison: false, computeAoiStatsForPolygon,
  });

  const uhiGradient = 'linear-gradient(90deg, #103e8a, #187a8c, #3aae6c, #bade76, #f8d668, '#f47c30', #d42026, #fff4b8)'.replace("'_'", '');
  const legendGradient = displayMode === 'uhi'
    ? 'linear-gradient(90deg, #103e8a, #187a8c, #3aae6c, #bade76, #f8d668, #f47c30, #d42026, #fff4b8)'
    : paletteGradient(palette, draftCustomColors);
  const differenceStats = differenceRender?.stats ?? null;

  useEffect(() => { localStorage.setItem('lst-theme', theme); document.documentElement.dataset.theme = theme; }, [theme]);
  useEffect(() => {
    mapClickMode.current = {
      drawAoi, aoiShapeMode, aoiAnchor, raster, extent, identifyMode, comparisonPrimary, comparisonSecondary,
      differenceData: differenceRender?.data ?? null, showingComparison, computeAoiStatsForPolygon,
    };
  }, [drawAoi, aoiShapeMode, aoiAnchor, raster, extent, identifyMode, comparisonPrimary, comparisonSecondary, differenceRender, showingComparison, computeAoiStatsForPolygon]);

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
    window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp);
    return () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
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
    const bumpView = () => setMapViewTick((v) => (v + 1) % 1000000);
    map.on('move', bumpView);
    map.on('zoom', bumpView);
    map.on('resize', bumpView);

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
        const coord: [number, number] = [ev.lngLat.lng, ev.lngLat.lat];
        if (m.aoiShapeMode === 'polygon') {
          setAoi((p) => [...p, coord]);
        } else if (!m.aoiAnchor) {
          setAoiAnchor(coord);
          setAoiHoverCoord(coord);
          setAoi([coord]);
        } else {
          const built = buildShapeVertices(m.aoiShapeMode, m.aoiAnchor, coord);
          setAoi(built);
          setAoiAnchor(null);
          setAoiHoverCoord(null);
          setDrawAoi(false);
          setPanEnabled(true);
          map.dragPan.enable(); map.doubleClickZoom.enable(); map.scrollZoom.enable();
          m.computeAoiStatsForPolygon(built);
        }
        return;
      }
      inspectAt(ev, true);
    });

    map.on('dblclick', (ev) => {
      const m = mapClickMode.current;
      if (!m.drawAoi) return;
      ev.preventDefault();
      if (m.aoiShapeMode === 'polygon') {
        setAoi((p) => {
          const cl = p.length > 1 && Math.abs(p[p.length - 1][0] - ev.lngLat.lng) < 1e-6 && Math.abs(p[p.length - 1][1] - ev.lngLat.lat) < 1e-6 ? p.slice(0, -1) : p;
          if (cl.length >= 3) {
            setDrawAoi(false);
            setAoiHoverCoord(null);
            setPanEnabled(true);
            map.dragPan.enable(); map.doubleClickZoom.enable(); map.scrollZoom.enable();
            m.computeAoiStatsForPolygon(cl);
          }
          return cl;
        });
      } else if (m.aoiAnchor) {
        const built = buildShapeVertices(m.aoiShapeMode, m.aoiAnchor, [ev.lngLat.lng, ev.lngLat.lat]);
        setAoi(built);
        setAoiAnchor(null);
        setAoiHoverCoord(null);
        setDrawAoi(false);
        setPanEnabled(true);
        map.dragPan.enable(); map.doubleClickZoom.enable(); map.scrollZoom.enable();
        m.computeAoiStatsForPolygon(built);
      }
    });

    let hf = 0;
    map.on('mousemove', (ev) => {
      const m = mapClickMode.current;
      if (m.drawAoi) {
        const coord: [number, number] = [ev.lngLat.lng, ev.lngLat.lat];
        setAoiHoverCoord(coord);
        if (m.aoiShapeMode !== 'polygon' && m.aoiAnchor) {
          setAoi(buildShapeVertices(m.aoiShapeMode, m.aoiAnchor, coord));
        }
        return;
      }
      if (m.identifyMode && !hf) {
        hf = requestAnimationFrame(() => { inspectAt(ev, false); hf = 0; });
      }
    });
    map.on('dragstart', () => setHoverSample(null));
    map.dragPan.enable(); mapInstance.current = map;
    return () => { map.remove(); mapInstance.current = null; };
  }, []);

  const syncLayers = useCallback(() => {
    const map = mapInstance.current;
    if (!map) return;
    const addOrUpdate = (id: string, url: string, coordinates: RasterBounds) => {
      try {
        const ex = map.getSource(id) as any;
        if (ex) ex.updateImage({ url, coordinates }); else map.addSource(id, { type: 'image', url, coordinates });
      } catch { /* ignore if style still warming up */ }
    };
    if (raster && lstUrl && opticalUrl) {
      addOrUpdate('lst-raster', lstUrl, raster.bounds); addOrUpdate('optical-raster', opticalUrl, raster.bounds);
      if (map.getSource('lst-raster') && !map.getLayer('lst-layer')) map.addLayer({ id: 'lst-layer', type: 'raster', source: 'lst-raster', paint: { 'raster-opacity': opacity, 'raster-contrast': contrast } });
      if (map.getSource('optical-raster') && !map.getLayer('optical-layer')) map.addLayer({ id: 'optical-layer', type: 'raster', source: 'optical-raster', paint: { 'raster-opacity': 1 } });
    }
    if (comparisonPrimary && comparisonSecondary && showingComparison) {
      addOrUpdate('comparison-primary-raster', comparisonPrimary.lstUrl, comparisonPrimary.bounds);
      addOrUpdate('comparison-lst-raster', comparisonSecondary.lstUrl, comparisonSecondary.bounds);
      if (map.getSource('comparison-primary-raster') && !map.getLayer('comparison-primary-layer')) map.addLayer({ id: 'comparison-primary-layer', type: 'raster', source: 'comparison-primary-raster', paint: { 'raster-opacity': 1 } });
      if (map.getSource('comparison-lst-raster') && !map.getLayer('comparison-lst-layer')) map.addLayer({ id: 'comparison-lst-layer', type: 'raster', source: 'comparison-lst-raster', paint: { 'raster-opacity': 0.95 } });
      if (differenceRender) addOrUpdate('comparison-difference-raster', differenceRender.url, comparisonPrimary.bounds);
      if (map.getSource('comparison-difference-raster') && !map.getLayer('comparison-difference-layer')) map.addLayer({ id: 'comparison-difference-layer', type: 'raster', source: 'comparison-difference-raster', paint: { 'raster-opacity': 0.94 } });
      if (map.getLayer('comparison-primary-layer')) map.setLayoutProperty('comparison-primary-layer', 'visibility', swipeActive ? 'visible' : 'none');
      if (map.getLayer('comparison-lst-layer')) map.setLayoutProperty('comparison-lst-layer', 'visibility', !swipeActive && comparisonMode === 'secondary' ? 'visible' : 'none');
      if (map.getLayer('comparison-difference-layer')) map.setLayoutProperty('comparison-difference-layer', 'visibility', comparisonMode === 'difference' && !swipeActive ? 'visible' : 'none');
    } else {
      for (const id of ['comparison-primary-layer', 'comparison-lst-layer', 'comparison-difference-layer']) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
    }
    if (map.getLayer('lst-layer')) {
      map.setLayoutProperty('lst-layer', 'visibility', visibleLst && !showingComparison ? 'visible' : 'none');
      map.setPaintProperty('lst-layer', 'raster-opacity', opacity); map.setPaintProperty('lst-layer', 'raster-contrast', contrast);
    }
    if (map.getLayer('optical-layer')) map.setLayoutProperty('optical-layer', 'visibility', visibleOptical && !showingComparison ? 'visible' : 'none');
    for (const aoiLayerId of ['aoi-fill', 'aoi-line', 'aoi-points']) {
      if (map.getLayer(aoiLayerId)) map.moveLayer(aoiLayerId);
    }
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
      map.dragPan.disable(); map.boxZoom.disable(); map.doubleClickZoom.disable(); map.getCanvas().style.cursor = 'crosshair';
    } else {
      if (panEnabled) map.dragPan.enable(); else map.dragPan.disable();
      map.scrollZoom.enable(); map.boxZoom.enable(); map.doubleClickZoom.enable(); map.getCanvas().style.cursor = '';
    }
  }, [drawAoi, identifyMode, panEnabled]);

  useEffect(() => {
    const map = mapInstance.current; if (!map || (!raster && !differenceReady)) return;
    syncLayers();
    map.on('styledata', syncLayers);
    return () => { map.off('styledata', syncLayers); };
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

  // Sincronização da AOI com o MapLibre + elevação para o topo das camadas
  useEffect(() => {
    const map = mapInstance.current;
    if (!map) return;
    const updateAoi = () => {
      try {
        const previewCoords = drawAoi && aoiShapeMode === 'polygon' && aoiHoverCoord && aoi.length >= 1
          ? [...aoi, aoiHoverCoord]
          : aoi;
        const features: any[] = aoi.map((pt, idx) => ({
          type: 'Feature', properties: { idx: idx + 1 }, geometry: { type: 'Point', coordinates: pt },
        }));
        if (previewCoords.length >= 2) {
          features.push({
            type: 'Feature', properties: {},
            geometry: { type: 'LineString', coordinates: previewCoords.length >= 3 ? [...previewCoords, previewCoords[0]] : previewCoords },
          });
        }
        if (previewCoords.length >= 3) {
          features.push({
            type: 'Feature', properties: {},
            geometry: { type: 'Polygon', coordinates: [[...previewCoords, previewCoords[0]]] },
          });
        }
        const data = { type: 'FeatureCollection' as const, features };
        const src = map.getSource('aoi-source') as maplibregl.GeoJSONSource | undefined;
        if (src) {
          src.setData(data as any);
        } else {
          map.addSource('aoi-source', { type: 'geojson', data: data as any });
          map.addLayer({ id: 'aoi-fill', type: 'fill', source: 'aoi-source', filter: ['==', '$type', 'Polygon'], paint: { 'fill-color': '#ffb000', 'fill-opacity': 0.24 } });
          map.addLayer({ id: 'aoi-line', type: 'line', source: 'aoi-source', filter: ['==', '$type', 'LineString'], paint: { 'line-color': '#ffb000', 'line-width': 3, 'line-dasharray': [2, 1] } });
          map.addLayer({ id: 'aoi-points', type: 'circle', source: 'aoi-source', filter: ['==', '$type', 'Point'], paint: { 'circle-radius': 6, 'circle-color': '#ffb000', 'circle-stroke-color': '#071317', 'circle-stroke-width': 2 } });
        }
        for (const id of ['aoi-fill', 'aoi-line', 'aoi-points']) {
          if (map.getLayer(id)) map.moveLayer(id);
        }
      } catch { /* ignore */ }
    };
    updateAoi();
  }, [aoi, aoiHoverCoord, aoiShapeMode, drawAoi]);

  // Projeção em coordenadas de tela para o Overlay SVG da AOI (garante renderização 100% infalível)
  const projectedAoiScreen = useMemo(() => {
    const map = mapInstance.current;
    if (!map || (aoi.length === 0 && !aoiAnchor)) return null;
    const pts = aoi.map((c) => {
      const p = map.project([c[0], c[1]]);
      return { x: p.x, y: p.y };
    });
    const hoverPt = drawAoi && aoiHoverCoord ? map.project([aoiHoverCoord[0], aoiHoverCoord[1]]) : null;
    const polyPts = drawAoi && aoiShapeMode === 'polygon' && hoverPt && pts.length >= 1
      ? [...pts, { x: hoverPt.x, y: hoverPt.y }]
      : pts;
    const pointsAttr = polyPts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    return { pts, polyPts, pointsAttr, hoverPt };
  }, [aoi, aoiAnchor, aoiHoverCoord, aoiShapeMode, drawAoi, mapViewTick]);

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
      try {
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
      } catch { /* ignore */ }
    };
    syncIso();
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
    setAoi([]); setAoiAnchor(null); setAoiHoverCoord(null); setAoiStats(null);
    setSample(null); setHoverSample(null); setUhiSurface(null); setIsotherms(null);
    setUhiSurfaceVisible(false); setProcessingLog([]); setStatus('Produto principal limpo.');
    const map = mapInstance.current;
    if (map) {
      for (const id of ['lst-layer', 'optical-layer', 'uhi-surface-line', 'uhi-surface-casing']) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
      }
    }
  };

  const clearComparisonAnalysis = () => {
    setComparisonImages([]);
    setComparisonFiles(Array.from({ length: comparisonCount }, () => null));
    setDifferenceReady(false);
    setSwipeActive(false);
    setComparisonMode('main');
    setSample(null);
    setHoverSample(null);
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

  const getAoiWindow = () => {
    if (!raster || aoi.length < 3 || !extent) return null;
    let w = Infinity; let e = -Infinity; let s = Infinity; let n = -Infinity;
    for (const pt of aoi) { w = Math.min(w, pt[0]); e = Math.max(e, pt[0]); s = Math.min(s, pt[1]); n = Math.max(n, pt[1]); }
    const x0 = Math.max(0, Math.floor(((w - extent.west) / (extent.east - extent.west)) * raster.width));
    const x1 = Math.min(raster.width, Math.ceil(((e - extent.west) / (extent.east - extent.west)) * raster.width));
    const y0 = Math.max(0, Math.floor(((extent.north - n) / (extent.north - extent.south)) * raster.height));
    const y1 = Math.min(raster.height, Math.ceil(((extent.north - s) / (extent.north - extent.south)) * raster.height));
    return { x0, y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
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
    if (raster && extent && aoi.length >= 3) {
      ctx.save();
      ctx.beginPath();
      aoi.forEach((pt, idx) => {
        const px = ((pt[0] - extent.west) / (extent.east - extent.west)) * raster.width;
        const py = ((extent.north - pt[1]) / (extent.north - extent.south)) * raster.height;
        if (idx === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.closePath();
      ctx.fillStyle = 'rgba(255, 176, 0, 0.22)';
      ctx.fill();
      ctx.strokeStyle = '#ffb000';
      ctx.lineWidth = Math.max(3, Math.round(raster.width / 600));
      ctx.stroke();
      ctx.restore();
    }
    drawLegend(ctx, 16, c.height - 190);
    const a = document.createElement('a'); a.href = c.toDataURL('image/png'); a.download = `SR2D4-${displayMode}-${palette}.png`; a.click();
  };

  const exportAoiPng = () => {
    const win = getAoiWindow(); if (!win || !lstCanvas.current || !opticalCanvas.current) return;
    const c = document.createElement('canvas'); c.width = win.width; c.height = win.height + 200;
    const ctx = c.getContext('2d'); if (!ctx) return;
    ctx.drawImage(opticalCanvas.current, win.x0, win.y0, win.width, win.height, 0, 0, win.width, win.height);
    ctx.globalAlpha = opacity; ctx.drawImage(lstCanvas.current, win.x0, win.y0, win.width, win.height, 0, 0, win.width, win.height); ctx.globalAlpha = 1;
    drawLegend(ctx, 16, win.height + 10);
    const a = document.createElement('a'); a.href = c.toDataURL('image/png'); a.download = 'SR2D4-AOI.png'; a.click();
  };

  const exportAoiTiff = () => {
    const win = getAoiWindow(); if (!win || !raster) return;
    const cl = new Float32Array(win.width * win.height);
    for (let y = 0; y < win.height; y += 1) cl.set(raster.data.subarray((win.y0 + y) * raster.width + win.x0, (win.y0 + y) * raster.width + win.x0 + win.width), y * win.width);
    downloadFloat32Tiff(cl, win.width, win.height, `SR2D4-AOI-${displayMode}.tif`, [raster.origin[0] + win.x0 * raster.resolution[0], raster.origin[1] + win.y0 * raster.resolution[1], raster.origin[2] || 0], raster.resolution, raster.epsg, raster.isProjected);
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
      setRaster({ data: auto.result.lstDownscaled, width: auto.tiff.width, height: auto.tiff.height, bounds: auto.bounds, origin: auto.tiff.origin, resolution: auto.tiff.resolution, epsg: auto.tiff.epsg, isProjected: auto.tiff.isProjected, stats, ndvi: auto.indices.ndvi, ndbi: auto.indices.ndbi, fileName: `${selectedFile.name} ·${auto.landsat.itemId}`, bands: auto.tiff.rasters.length });
      setComparisonMode('main'); setSwipeActive(false); setAoi([]);
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
    const w = 740;
    const iH = Math.round((w * a.height) / a.width);
    const legH = 168;
    const c = document.createElement('canvas');
    c.width = w * 3;
    c.height = iH + legH + 64;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#071317';
    ctx.fillRect(0, 0, c.width, c.height);

    const panels = [
      { im: a, lbl: `ANTES · ${comparisonPrimary.dateLabel} (LST °C)`, st: comparisonPrimary.stats },
      { im: b, lbl: `DEPOIS · ${comparisonSecondary.dateLabel} (LST °C)`, st: comparisonSecondary.stats },
      { im: d, lbl: `DIFERENÇA ΔLST (DEPOIS − ANTES) · ±1σ = ±${differenceStats.thresholdSigma.toFixed(2)}°C`, st: null },
    ];

    panels.forEach((p, idx) => {
      const x = idx * w;
      ctx.fillStyle = '#ffffff';
      ctx.font = '700 22px Arial';
      ctx.textAlign = 'center';
      ctx.fillText(p.lbl, x + w / 2, 36);
      ctx.textAlign = 'left';
      ctx.drawImage(p.im, x + 14, 52, w - 28, iH - 16);
      ctx.strokeStyle = 'rgba(121,226,220,0.45)';
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 14, 52, w - 28, iH - 16);

      const ly = iH + 52;
      const lw = w - 28;
      const lx = x + 14;
      ctx.fillStyle = '#0d1f26';
      ctx.fillRect(lx, ly, lw, legH - 14);
      ctx.strokeStyle = 'rgba(121,226,220,0.5)';
      ctx.strokeRect(lx, ly, lw, legH - 14);

      if (p.st) {
        ctx.fillStyle = '#79e2dc';
        ctx.font = '700 17px Arial';
        ctx.fillText(`ESCALA TÉRMICA (${palette.toUpperCase()})`, lx + 18, ly + 28);
        const grad = ctx.createLinearGradient(lx + 18, ly + 42, lx + lw - 18, ly + 42);
        for (let s = 0; s <= 16; s += 1) grad.addColorStop(s / 16, sampleCssColorAt(s / 16, palette, draftCustomColors, false));
        ctx.fillStyle = grad;
        ctx.fillRect(lx + 18, ly + 42, lw - 36, 26);
        ctx.strokeStyle = 'rgba(255,255,255,0.5)';
        ctx.strokeRect(lx + 18, ly + 42, lw - 36, 26);

        ctx.fillStyle = '#ffffff';
        ctx.font = '700 17px Arial';
        ctx.fillText(`Mín: ${p.st.min.toFixed(1)} °C`, lx + 18, ly + 96);
        ctx.textAlign = 'center';
        ctx.fillText(`Média: ${p.st.mean.toFixed(1)} °C (σ=${p.st.stdDev.toFixed(2)}°C)`, lx + lw / 2, ly + 96);
        ctx.textAlign = 'right';
        ctx.fillText(`Máx: ${p.st.max.toFixed(1)} °C`, lx + lw - 18, ly + 96);
        ctx.textAlign = 'left';
        ctx.fillStyle = '#9ab0b5';
        ctx.font = '14px Arial';
        ctx.fillText(`Quartis: Q25 = ${p.st.q25.toFixed(1)}°C · Mediana = ${p.st.q50.toFixed(1)}°C · Q75 = ${p.st.q75.toFixed(1)}°C`, lx + 18, ly + 128);
      } else {
        const sig = differenceStats.thresholdSigma;
        ctx.fillStyle = '#ffb000';
        ctx.font = '700 17px Arial';
        ctx.fillText(`CLASSIFICAÇÃO POR DESVIO-PADRÃO (±1σ = ±${sig.toFixed(2)} °C · ΔMédio = ${differenceStats.mean >= 0 ? '+' : ''}${differenceStats.mean.toFixed(2)} °C)`, lx + 18, ly + 28);
        const grad = ctx.createLinearGradient(lx + 18, ly + 42, lx + lw - 18, ly + 42);
        grad.addColorStop(0, '#023e8a'); grad.addColorStop(0.24, '#0096c7'); grad.addColorStop(0.36, '#48cae4');
        grad.addColorStop(0.37, '#45525a'); grad.addColorStop(0.63, '#526069'); grad.addColorStop(0.64, '#f77f00');
        grad.addColorStop(0.84, '#d62828'); grad.addColorStop(1, '#ffea00');
        ctx.fillStyle = grad;
        ctx.fillRect(lx + 18, ly + 42, lw - 36, 26);
        ctx.strokeStyle = 'rgba(255,255,255,0.5)';
        ctx.strokeRect(lx + 18, ly + 42, lw - 36, 26);

        ctx.font = '700 16px Arial';
        ctx.fillStyle = '#48cae4';
        ctx.fillText(`↓ Diminuiu (< -1σ): ${differenceStats.pctDecreased.toFixed(1)}%`, lx + 18, ly + 96);
        ctx.textAlign = 'center';
        ctx.fillStyle = '#cbd5e1';
        ctx.fillText(`＝ Igual (±1σ): ${differenceStats.pctEqual.toFixed(1)}%`, lx + lw / 2, ly + 96);
        ctx.textAlign = 'right';
        ctx.fillStyle = '#ff9e00';
        ctx.fillText(`↑ Aumentou (> +1σ): ${differenceStats.pctIncreased.toFixed(1)}%`, lx + lw - 18, ly + 96);
        ctx.textAlign = 'left';
        ctx.fillStyle = '#9ab0b5';
        ctx.font = '14px Arial';
        ctx.fillText(`Amplitude ΔLST: ${differenceStats.min.toFixed(1)}°C a +${differenceStats.max.toFixed(1)}°C · Destaque estatístico acima de ±1σ.`, lx + 18, ly + 128);
      }
    });

    const lnk = document.createElement('a');
    lnk.href = c.toDataURL('image/png');
    lnk.download = `SR2D4-Comparacao-${comparisonPrimary.dateLabel}-${comparisonSecondary.dateLabel}.png`;
    lnk.click();
  };

  // Relatório Executivo HTML com Layout Premium, Conforto Térmico (UTFVI), Mobilidade Urbana e Matriz de Mitigação
  const downloadReport = () => {
    if (!raster || !lstCanvas.current || !opticalCanvas.current) return;
    let vegetation = 0; let built = 0; let water = 0; let valid = 0;
    let uhiCool = 0; let uhiMit = 0; let uhiNeut = 0; let uhiMod = 0; let uhiStr = 0; let uhiExt = 0;
    let utfviOpt = 0; let utfviGood = 0; let utfviNorm = 0; let utfviMild = 0; let utfviSev = 0; let utfviExt = 0;
    let unshadedBuiltHot = 0;

    const meanT = raster.stats.mean;
    const hotThreshold = meanT + 0.85 * raster.stats.stdDev;

    for (let i = 0; i < raster.data.length; i += 1) {
      const val = raster.data[i];
      const ndvi = raster.ndvi[i];
      const ndbi = raster.ndbi[i];
      if (!Number.isFinite(val)) continue;
      valid += 1;
      if (Number.isFinite(ndvi) && Number.isFinite(ndbi)) {
        if (ndvi > 0.3) vegetation += 1;
        else if (ndvi < 0 && ndbi < 0) water += 1;
        else if (ndbi > 0.1) {
          built += 1;
          if (val >= hotThreshold && ndvi < 0.2) unshadedBuiltHot += 1;
        }
      }
      const z = computeClusteredZ(val, val, raster.stats, uhiMethod, uhiPower);
      if (z < -0.95) uhiCool += 1;
      else if (z < -0.30) uhiMit += 1;
      else if (z < 0.25) uhiNeut += 1;
      else if (z < 0.85) uhiMod += 1;
      else if (z < 1.40) uhiStr += 1;
      else uhiExt += 1;

      const utfvi = (val - meanT) / Math.max(1, meanT);
      if (utfvi < 0) utfviOpt += 1;
      else if (utfvi < 0.005) utfviGood += 1;
      else if (utfvi < 0.010) utfviNorm += 1;
      else if (utfvi < 0.015) utfviMild += 1;
      else if (utfvi < 0.020) utfviSev += 1;
      else utfviExt += 1;
    }

    const pct = (v: number) => (valid ? ((v / valid) * 100).toFixed(1) : '0.0');
    const pxAreaM2 = raster.isProjected ? Math.abs(raster.resolution[0] * raster.resolution[1]) : 1;
    const totalAreaHa = (valid * pxAreaM2) / 10000;
    const criticalAreaHa = ((uhiStr + uhiExt) * pxAreaM2) / 10000;
    const unshadedHotHa = (unshadedBuiltHot * pxAreaM2) / 10000;
    const uhiLevel = raster.stats.mean + 1.5 * raster.stats.stdDev;
    const amplitude = raster.stats.max - raster.stats.min;
    const criticalPedestrianPct = valid ? (((uhiStr + uhiExt) / valid) * 100).toFixed(1) : '0.0';
    const comfortPct = valid ? (((utfviOpt + utfviGood + utfviNorm) / valid) * 100).toFixed(1) : '0.0';

    const compImg = document.createElement('canvas');
    compImg.width = lstCanvas.current.width;
    compImg.height = lstCanvas.current.height;
    const iCtx = compImg.getContext('2d');
    if (iCtx) {
      iCtx.drawImage(opticalCanvas.current, 0, 0);
      iCtx.globalAlpha = opacity;
      iCtx.drawImage(lstCanvas.current, 0, 0);
      iCtx.globalAlpha = 1;
      if (extent && aoi.length >= 3) {
        iCtx.beginPath();
        aoi.forEach((pt, idx) => {
          const px = ((pt[0] - extent.west) / (extent.east - extent.west)) * raster.width;
          const py = ((extent.north - pt[1]) / (extent.north - extent.south)) * raster.height;
          if (idx === 0) iCtx.moveTo(px, py); else iCtx.lineTo(px, py);
        });
        iCtx.closePath();
        iCtx.fillStyle = 'rgba(255, 176, 0, 0.25)';
        iCtx.fill();
        iCtx.strokeStyle = '#ffb000';
        iCtx.lineWidth = Math.max(4, Math.round(raster.width / 500));
        iCtx.stroke();
      }
    }

    const aoiSection = aoiStats
      ? `<div class="section-card">
          <div class="sec-kicker">RECOTE ESPACIAL FOCAL</div>
          <h2>Diagnóstico da Área de Interesse (AOI Selecionada)</h2>
          <div class="kpi-grid">
            <div class="kpi-card"><span>Área / Pixels Analisados</span><strong>${aoiStats.count.toLocaleString('pt-BR')} px</strong><small>≈ ${((aoiStats.count * pxAreaM2) / 10000).toFixed(2)} ha (${(aoiStats.count * pxAreaM2).toLocaleString('pt-BR', { maximumFractionDigits: 0 })} m²)</small></div>
            <div class="kpi-card"><span>Mínima na AOI</span><strong>${aoiStats.min.toFixed(1)} °C</strong><small>Refúgio microclimático local</small></div>
            <div class="kpi-card accent"><span>Média na AOI</span><strong>${aoiStats.mean.toFixed(2)} °C</strong><small>Anomalia vs. Cena: ${(aoiStats.mean - raster.stats.mean) >= 0 ? '+' : ''}${(aoiStats.mean - raster.stats.mean).toFixed(2)} °C</small></div>
            <div class="kpi-card danger"><span>Pico Térmico na AOI</span><strong>${aoiStats.max.toFixed(1)} °C</strong><small>Classificação: ${uhiClassLabel(aoiStats.max, raster.stats, uhiMethod, uhiPower, 'pt')}</small></div>
          </div>
        </div>`
      : '';

    const diffSection = differenceReady && differenceStats && comparisonPrimary && comparisonSecondary && differenceRender
      ? `<div class="section-card">
          <div class="sec-kicker">DINÂMICA MULTITEMPORAL</div>
          <h2>Comparação Antes / Depois (ΔLST: ${comparisonPrimary.dateLabel} →${comparisonSecondary.dateLabel})</h2>
          <div class="kpi-grid">
            <div class="kpi-card"><span>Limiar Estatístico (±1σ)</span><strong>±${differenceStats.thresholdSigma.toFixed(2)} °
