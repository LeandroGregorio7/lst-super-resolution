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
    eyebrow: 'OPEN SOURCE • WEB GIS', title: 'SR2D4 / LST Explorer', subtitle: 'A browser-based thermal lab for turning multispectral GeoTIFFs into spatial evidence.', colab: 'Open Colab', upload: 'Load SR2D4/MS product', uploadHint: 'Local GeoTIFF • nothing is uploaded to a server', bands: 'SR2D4 optical bands', red: 'Red', nir: 'Near infrared (NIR)', swir: 'Short-wave infrared (SWIR)', calculate: 'Calculate thermal map', processing: 'Processing raster…', layers: 'Layers', lst: 'LST / temperature', optical: 'Optical image', opacity: 'Opacity', contrast: 'Contrast', palette: 'Palette', stats: 'Statistics', min: 'minimum', max: 'maximum', mean: 'mean', std: 'std dev', histogram: 'Temperature distribution', sample: 'Thermal Scale & Inspection', aoi: 'Area of interest', draw: 'Draw AOI', clear: 'Clear AOI', clip: 'Analyze AOI', export: 'Export', png: 'PNG composto', tiff: 'LST GeoTIFF', uhi: 'UHI GeoTIFF', method: 'Methodology', help: 'How it works', metadata: 'Metadata', theme: 'Theme', basemap: 'Basemap', ready: 'Ready', error: 'Processing failed. Load an SR2D4 GeoTIFF with Red, NIR and SWIR; thermal Landsat is fetched automatically.', methodText: 'The workflow combines SR2D4 imagery with optical indices and TsHARP regression to estimate spatial LST. Spatial detail is estimated: super-resolution does not create independent thermal observations for every new pixel. Validate results with field data.', helpText: '1. Generate the MS product in Colab. 2. Load the GeoTIFF. 3. Confirm Red/NIR/SWIR. 4. Search a place, use GPS or enter coordinates. 5. Calculate and explore LST, indices, AOI and exports.', noData: 'Load a GeoTIFF to begin', search: 'Search city, neighborhood or place', coords: 'Longitude, latitude', locate: 'My location', go: 'Go', compare: 'Compare before/after', before: 'Optical / before', after: 'LST / after', indices: 'Spectral indices', ndvi: 'NDVI vegetation', ndbi: 'NDBI built-up', report: 'Quick report', resize: 'Drag to resize the panel', searchError: 'Place not found.', uhiText: 'UHI levels (1m): Cool island, Mitigated, Neutral, Mild, Strong and Extreme.', aoiHelp: 'Activate Draw AOI, click at least three map points, then finish with ✓ or double-click.', aoiStats: 'AOI mean', limitation: 'Super-resolution limitations', limitationText: 'Detailed LST is an optical-index-guided estimate. Use it for spatial investigation and comparison, not as a replacement for field thermal measurement.',
  },
} as const;

const UHI_STOPS: [number, number, number, number][] = [
  [-1.65, 24, 90, 157],
  [-0.95, 43, 140, 104],
  [-0.30, 138, 196, 110],
  [0.15, 247, 226, 139],
  [0.65, 244, 132, 56],
  [1.20, 215, 38, 38],
  [1.90, 255, 242, 175],
];

function hexToRgbTuple(hex: string): [number, number, number] {
  const clean = hex.replace('#', '').trim();
  const num = parseInt(clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function getPaletteRgbStops(palette: PaletteType, customColors: string[]): [number, number, number][] {
  const map: Record<string, string[]> = {
    ironbow: ['#06005a', '#4b0082', '#9e0059', '#d62828', '#f77f00', '#fcbf49', '#fff8d6'],
    spectral: ['#3288bd', '#66c2a5', '#abdda4', '#e6f598', '#fee08b', '#fdae61', '#f46d43', '#d53e4f'],
    jet: ['#000082', '#0066ff', '#00ffff', '#55ff00', '#ffff00', '#ff5500', '#cc0000'],
    viridis: ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'],
    magma: ['#000004', '#340f4b', '#7b206b', '#ca464a', '#fb9b06', '#fcfdbf'],
    coolwarm: ['#3b4cc0', '#7b9ff9', '#dddddd', '#f29072', '#b40426'],
    terrain: ['#225ea8', '#41b6c4', '#a1dab4', '#fed976', '#e31a1c', '#800026'],
    grayscale: ['#080808', '#484848', '#888888', '#c8c8c8', '#ffffff'],
    custom: customColors.length >= 2 ? customColors : ['#173f9d', '#25a7a0', '#f5d547', '#b62025'],
  };
  return (map[palette] || map.ironbow).map(hexToRgbTuple);
}

function samplePaletteStops(t: number, stops: [number, number, number][]): [number, number, number] {
  const clamped = Math.max(0, Math.min(1, t));
  const scaled = clamped * (stops.length - 1);
  const idx = Math.min(stops.length - 2, Math.floor(scaled));
  const frac = scaled - idx;
  const c0 = stops[idx];
  const c1 = stops[idx + 1];
  return [
    c0[0] + (c1[0] - c0[0]) * frac,
    c0[1] + (c1[1] - c0[1]) * frac,
    c0[2] + (c1[2] - c0[2]) * frac,
  ];
}

/**
 * Renderizador de Temperatura (LST) em Alta Definição (1m):
 * - Aplica Tone Mapping Radiométrico (Soft-Knee Gamma) para não estourar telhados em amarelo
 * - Desenha as linhas divisórias de polígonos (casas, muros, quadras e ruas) via micro-oclusão de 1m.
 */
function renderHighDefLstToCanvas(
  data: Float32Array,
  width: number,
  height: number,
  canvas: HTMLCanvasElement,
  palette: PaletteType,
  customColors: string[],
  stats: { min: number; max: number; mean: number; stdDev: number },
) {
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const img = ctx.createImageData(width, height);
  const out = img.data;

  const stops = getPaletteRgbStops(palette, customColors);
  const span = Math.max(0.5, stats.max - stats.min);
  const safeStd = Math.max(0.6, stats.stdDev);

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

      const xPrev = Math.max(0, x - 1);
      const xNext = Math.min(width - 1, x + 1);
      const vE = Number.isFinite(data[row + xNext]) ? data[row + xNext] : val;
      const vW = Number.isFinite(data[row + xPrev]) ? data[row + xPrev] : val;
      const vS = Number.isFinite(data[yNext + x]) ? data[yNext + x] : val;
      const vN = Number.isFinite(data[yPrev + x]) ? data[yPrev + x] : val;

      const meanNeigh = 0.25 * (vE + vW + vS + vN);
      const lap = (val - meanNeigh) / safeStd;
      const gx = (vE - vW) / safeStd;
      const gy = (vS - vN) / safeStd;
      const gradMag = Math.sqrt(gx * gx + gy * gy);

      // Posição linear [0, 1]
      const tLin = Math.max(0, Math.min(1, (val - stats.min) / span));

      // Curva S-Roll-off nos altos: reserva os últimos 20% da paleta (amarelo claro/branco)
      // apenas para os grandes hotspots (>82% da amplitude), mantendo casas em laranja/âmbar rico!
      const tToneMapped =
        tLin <= 0.48
          ? Math.pow(tLin / 0.48, 0.92) * 0.48
          : 0.48 + Math.pow((tLin - 0.48) / 0.52, 1.38) * 0.52;

      // Recuo cromático nas divisas entre imóveis (lap < 0) para separar visualmente cada casa
      const boundaryColorPull = lap < 0 ? Math.max(-0.08, lap * 0.06) : Math.min(0.03, lap * 0.02);
      const [r, g, b] = samplePaletteStops(tToneMapped + boundaryColorPull, stops);

      // Oclusão de linha divisória de polígonos (escurece suavemente as bordas entre telhados vizinhos)
      const solarSlope = (gx * 0.75 - gy * 0.65) * 0.08;
      const polygonLineDarken =
        lap < -0.04
          ? Math.max(-0.28, lap * 0.24 - gradMag * 0.09)
          : Math.min(0.10, lap * 0.06 - gradMag * 0.04);

      const brightness = Math.max(0.70, Math.min(1.12, 1 + solarSlope + polygonLineDarken));

      out[px] = Math.max(0, Math.min(255, Math.round(r * brightness)));
      out[px + 1] = Math.max(0, Math.min(255, Math.round(g * brightness)));
      out[px + 2] = Math.max(0, Math.min(255, Math.round(b * brightness)));
      out[px + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
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
      const tStepped = 0.65 * t + 0.35 * (Math.round(t * 2) / 2);
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
  mean: number,
  stdDev: number,
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
    grid[i] = counts[i] > 0 ? rawGrid[i] / counts[i] : mean;
  }

  const kernel = [1, 2, 1, 2, 4, 2, 1, 2, 1];
  for (let pass = 0; pass < 3; pass += 1) {
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

  const safeStd = Math.max(0.8, stdDev);
  const levels = [
    { z: -0.95, label: 'Ilha de Frescor', color: '#38bdf8', kmlColor: 'fff8bd38' },
    { z: -0.35, label: 'Zona Amenizada', color: '#34d399', kmlColor: 'ff99d334' },
    { z: 0.20, label: 'Limiar UHI Leve', color: '#fde047', kmlColor: 'ff47e0fd' },
    { z: 0.75, label: 'Cluster UHI Forte', color: '#fb923c', kmlColor: 'ff3c92fb' },
    { z: 1.25, label: 'Hotspot Extremo', color: '#f43f5e', kmlColor: 'ff5e3ff4' },
  ];

  const toLng = (gx: number) => ext.west + ((gx + 0.5) / gW) * (ext.east - ext.west);
  const toLat = (gy: number) => ext.north - ((gy + 0.5) / gH) * (ext.north - ext.south);

  const features: IsothermFeature[] = [];

  levels.forEach((lvl, idx) => {
    const iso = Number((mean + lvl.z * safeStd).toFixed(2));
    const segments: [number, number][][] = [];

    for (let y = 0; y < gH - 1; y += 1) {
      for (let x = 0; x < gW - 1; x += 1) {
        const v0 = grid[y * gW + x];
        const v1 = grid[y * gW + (x + 1)];
        const v2 = grid[(y + 1) * gW + (x + 1)];
        const v3 = grid[(y + 1) * gW + x];

        let mask = 0;
        if (v0 >= iso) mask |= 1;
        if (v1 >= iso) mask |= 2;
        if (v2 >= iso) mask |= 4;
        if (v3 >= iso) mask |= 8;
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
  return <svg className="logo-mark" viewBox="0 0 44 44" role="img" aria-label="SR2D4 LST Explorer logo"><defs><linearGradient id="thermal-logo" x1="0" x2="1"><stop stopColor="#4324a8"/><stop offset=".52" stopColor="#f04435"/><stop offset="1" stopColor="#ffc400"/></linearGradient></defs><path d="M22 3c8 0 15 5 18 12-6-2-11-1-16 3-5 4-8 10-8 18-6-4-10-10-10-17C6 10 13 3 22 3Z" fill="url(#thermal-logo)"/><path d="M10 31c5-4 11-6 18-5 4 1 7 3 10 6-4 6-10 9-17 9-4 0-8-1-11-3Z" fill="none" stroke="#79e2dc" strokeWidth="2"/><circle cx="27" cy="14" r="3" fill="#fff5bf"/></svg>;
}
function Icon({ name }: { name: 'search' | 'gps' | 'pin' | 'resize' | 'layers' | 'sun' | 'moon' }) {
  const paths = { search: <><circle cx="11" cy="11" r="6"/><path d="m16 16 5 5"/></>, gps: <><circle cx="12" cy="12" r="7"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M12 9v6M9 12h6"/></>, pin: <><path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></>, resize: <><path d="M8 3H3v5M16 21h5v-5M3 3l7 7M21 21l-7-7"/></>, layers: <><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/></>, sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></>, moon: <path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z"/> }[name];
  return <svg className="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths}</svg>;
}
function LayerRow({ label, visible, onToggle, color }: { label: string; visible: boolean; onToggle: () => void; color: string }) { return <button className="layer-row" onClick={onToggle}><span className={`layer-swatch ${color}`} /><span>{label}</span><span className="layer-state">{visible ? 'VISIBLE' : 'HIDDEN'}</span></button>; }
function Metric({ label, value }: { label: string; value: string }) { return <div className="metric"><small>{label}</small><strong>{value}</strong></div>; }
function meanOf(data: Float32Array) { let sum = 0; let count = 0; for (const value of data) if (Number.isFinite(value)) { sum += value; count += 1; } return count ? sum / count : 0; }
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
  onProgress?.('Calculando NDVI, NDBI, NDWI e morfologia óptica de 1m (Red/NIR)…');
  const indices = calculateOpticalIndices(red, nir, swir);
  onProgress?.('Executando TsHARP + Decomposição de Polígonos 1m: ajustando LST e conservando energia…');
  const result = downscaleLandsatLST(
    landsat.lstCelsius,
    landsat.width,
    landsat.height,
    landsat.bounds,
    { ...indices, red, nir },
    tiff.width,
    tiff.height,
    bounds,
  );
  const resolutionLabel = tiff.isProjected ? `${Math.abs(tiff.resolution[0]).toFixed(2)} m/pixel` : `${Math.abs(tiff.resolution[0]).toFixed(6)} graus/pixel`;
  onProgress?.(`Fusão concluída: ${result.model} · ${result.validCount} células coarse · coef. NDVI ${result.slope.toFixed(4)} · saída ${tiff.width.toLocaleString()}×${tiff.height.toLocaleString()} px · resolução ${resolutionLabel}`);
  onProgress?.(`Prova numérica: LST coarse ${result.coarseRange.toFixed(2)} °C · LST fina ${result.fineRange.toFixed(2)} °C · sinal transferido do SR2D4 ${result.fineSignalRange.toFixed(2)} °C · erro médio de conservação ${result.conservationMae.toFixed(3)} °C`);
  return { tiff, bounds, indices, landsat, result };
}
function pointInPolygon(point: [number, number], polygon: [number, number][]) { let inside = false; for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) { const [xi, yi] = polygon[i]; const [xj, yj] = polygon[j]; const intersects = ((yi > point[1]) !== (yj > point[1])) && point[0] < (xj - xi) * (point[1] - yi) / ((yj - yi) || Number.EPSILON) + xi; if (intersects) inside = !inside; } return inside; }
function thermalDifference(primary: { data: Float32Array; width: number; height: number; bounds: RasterBounds; stats: { stdDev: number } }, secondary: { data: Float32Array; width: number; height: number; bounds: RasterBounds; stats: { stdDev: number } }) { const result = new Float32Array(primary.width * primary.height); const primaryExtent = boundsExtent(primary.bounds); const secondaryExtent = boundsExtent(secondary.bounds); for (let y = 0; y < primary.height; y += 1) for (let x = 0; x < primary.width; x += 1) { const lng = primaryExtent.west + (x + .5) / primary.width * (primaryExtent.east - primaryExtent.west); const lat = primaryExtent.north - (y + .5) / primary.height * (primaryExtent.north - primaryExtent.south); const sx = Math.floor((lng - secondaryExtent.west) / (secondaryExtent.east - secondaryExtent.west) * secondary.width); const sy = Math.floor((secondaryExtent.north - lat) / (secondaryExtent.north - secondaryExtent.south) * secondary.height); const a = primary.data[y * primary.width + x]; const b = sx >= 0 && sy >= 0 && sx < secondary.width && sy < secondary.height ? secondary.data[sy * secondary.width + sx] : NaN; result[y * primary.width + x] = Number.isFinite(a) && Number.isFinite(b) ? b - a : NaN; } return result; }
function renderDifferenceToCanvas(data: Float32Array, width: number, height: number, canvas: HTMLCanvasElement) { canvas.width = width; canvas.height = height; const ctx = canvas.getContext('2d'); if (!ctx) return null; const image = ctx.createImageData(width, height); let min = Infinity; let max = -Infinity; let count = 0; for (const value of data) if (Number.isFinite(value)) { min = Math.min(min, value); max = Math.max(max, value); count += 1; } const maxAbs = Math.max(0.1, count ? Math.max(Math.abs(min), Math.abs(max)) : 0); const color = (value: number) => { const t = Math.min(1, Math.abs(value) / maxAbs); const start = value < 0 ? [33, 102, 172] : [255, 255, 255]; const end = value < 0 ? [247, 247, 247] : [178, 24, 43]; return { r: Math.round(start[0] + (end[0] - start[0]) * t), g: Math.round(start[1] + (end[1] - start[1]) * t), b: Math.round(start[2] + (end[2] - start[2]) * t) }; }; for (let i = 0; i < data.length; i += 1) { const value = data[i]; const index = i * 4; if (!Number.isFinite(value)) { image.data[index + 3] = 0; continue; } const rgb = color(value); image.data[index] = rgb.r; image.data[index + 1] = rgb.g; image.data[index + 2] = rgb.b; image.data[index + 3] = 255; } ctx.putImageData(image, 0, 0); return { min: count ? min : 0, max: count ? max : 0, maxAbs }; }

function uhiClassLabel(value: number, stats: { mean: number; stdDev: number }, lang: Lang) {
  if (!Number.isFinite(value)) return '—';
  const z = (value - stats.mean) / Math.max(0.8, stats.stdDev);
  if (z < -0.95) return lang === 'pt' ? 'Ilha de Frescor' : 'Cool Island';
  if (z < -0.30) return lang === 'pt' ? 'Amenizado' : 'Mitigated';
  if (z < 0.25) return lang === 'pt' ? 'Neutro' : 'Neutral';
  if (z < 0.85) return lang === 'pt' ? 'UHI Moderada' : 'Moderate UHI';
  if (z < 1.40) return lang === 'pt' ? 'UHI Forte' : 'Strong UHI';
  return lang === 'pt' ? 'UHI Extrema (Hotspot)' : 'Extreme Hotspot';
}
function imageDateLabel(name: string, index: number) { const match = name.match(/(20\d{2})[-_]?([01]\d)[-_]?([0-3]\d)/); return match ? `${match[1]}-${match[2]}-${match[3]}` : `Data ${String(index + 1).padStart(2, '0')}`; }
function paletteGradient(palette: PaletteType, customColors: string[]) { const gradients: Record<string, string> = { ironbow: '#06005a, #4b0082, #9e0059, #d62828, #f77f00, #fcbf49, #fff8d6', spectral: '#5e4fa2, #3288bd, #66c2a5, #fdd486, #f46d43, #9e0142', jet: '#000082, #00ffff, #00ff00, #ffff00, #ff0000', viridis: '#440154, #3b528b, #21918c, #5ec962, #fde725', magma: '#000004, #340f4b, #7b206b, #ca464a, #fcfdbf', coolwarm: '#3b4cc0, #dddddd, #b40426', terrain: '#225ea8, #53a85d, #dcbe68, #8b261f', grayscale: '#050505, #ffffff', custom: customColors.join(', ') }; return `linear-gradient(90deg, ${gradients[palette] || gradients.ironbow})`; }
function statsOf(data: Float32Array) { let min = Infinity; let max = -Infinity; let sum = 0; let count = 0; for (const value of data) if (Number.isFinite(value)) { min = Math.min(min, value); max = Math.max(max, value); sum += value; count += 1; } return { min: count ? min : 0, max: count ? max : 0, mean: count ? sum / count : 0 }; }

export default function App() {
  const [lang, setLang] = useState<Lang>(() => navigator.language.toLowerCase().startsWith('pt') ? 'pt' : 'en');
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('lst-theme') as Theme) || 'dark');
  const [provider, setProvider] = useState<Provider>('osm');
  const [raster, setRaster] = useState<RasterState | null>(null);
  const [lstUrl, setLstUrl] = useState<string | null>(null); const [opticalUrl, setOpticalUrl] = useState<string | null>(null);
  const [visibleLst, setVisibleLst] = useState(true); const [visibleOptical, setVisibleOptical] = useState(true);
  const [opacity, setOpacity] =
