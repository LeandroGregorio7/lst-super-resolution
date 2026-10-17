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
type IsothermMode = 'clusters' | 'step-1.0' | 'step-1.5';
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
    id: number;
    temperature_c: number;
    label: string;
    uhi_class: string;
    color: string;
    feature_type: 'isotherm_contour' | 'thermal_cluster';
  };
  geometry: {
    type: 'LineString' | 'Polygon';
    coordinates: [number, number][] | [number, number][][];
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
    colab: 'Abrir Colab', upload: 'Carregar produto SR2D4/MS', uploadHint: 'GeoTIFF local • nada é enviado para um servidor', bands: 'Bandas ópticas do SR2D4', red: 'Vermelho (Red)', nir: 'Infravermelho próximo (NIR)', swir: 'Infravermelho de ondas curtas (SWIR)', calculate: 'Calcular mapa térmico', processing: 'Processando raster…', layers: 'Camadas', lst: 'LST / temperatura', optical: 'Imagem óptica', opacity: 'Transparência', contrast: 'Contraste', palette: 'Paleta', stats: 'Resumo estatístico', min: 'mínima', max: 'máxima', mean: 'média', std: 'desvio', histogram: 'Distribuição térmica', sample: 'Escala Térmica & Inspeção', aoi: 'Área de interesse', draw: 'Desenhar AOI', clear: 'Limpar AOI', clip: 'Analisar AOI', export: 'Exportar', png: 'PNG composto', tiff: 'GeoTIFF LST', uhi: 'GeoTIFF UHI', method: 'Metodologia', help: 'Como usar', metadata: 'Metadados', theme: 'Tema', basemap: 'Mapa-base', ready: 'Pronto', error: 'Não foi possível processar. Carregue um GeoTIFF SR2D4 com Red, NIR e SWIR; o Landsat térmico é buscado automaticamente.', methodText: 'O app extrai a data AAAAMMDD do nome do SR2D4, busca automaticamente a cena Landsat 8/9 Collection 2 Level-2 mais próxima, mascara nuvens com QA_PIXEL, decodifica ST_B10 e ajusta uma regressão multivariada com NDVI, NDBI e NDWI. O app executa TsHARP: agrega NDVI/índices do SR2D4 na grade térmica, ajusta a relação LST–NDVI coarse, aplica-a no NDVI fino e adiciona o residual Landsat por célula para conservar a LST observada. A saída usa exatamente a grade nativa do SR2D4; o detalhe térmico é estimado, não uma medição independente em cada pixel.', helpText: '1. Gere o produto MS no Colab com o nome contendo AAAAMMDD e sufixo _MS.tif. 2. Carregue o GeoTIFF SR2D4. 3. Confirme apenas Red/NIR/SWIR do próprio SR2D4. 4. O app busca Landsat 8/9 automaticamente, pela área e data. 5. Explore LST, índices, isotermas, AOI e exportações.', noData: 'Carregue um GeoTIFF para começar', search: 'Buscar cidade, bairro ou lugar', coords: 'Longitude, latitude', locate: 'Minha localização', go: 'Ir', compare: 'Comparar antes/depois', before: 'Óptico / antes', after: 'LST / depois', indices: 'Índices espectrais', ndvi: 'NDVI vegetação', ndbi: 'NDBI construído', report: 'Relatório rápido', resize: 'Arraste para redimensionar o painel', searchError: 'Local não encontrado.', uhiText: 'Níveis UHI (1m): Frescor, Amenizado, Neutro, Leve, Forte e Extremo.', aoiHelp: 'Ative Desenhar AOI, clique em pelo menos três pontos no mapa e finalize com ✓ ou duplo clique.', aoiStats: 'Média da AOI', limitation: 'Limitações da super-resolução', limitationText: 'A LST detalhada é uma estimativa guiada por índices ópticos. Use-a para investigação espacial e comparação, não como substituta de uma medição térmica de campo.',
  },
  en: {
    eyebrow: 'OPEN SOURCE • WEB GIS', title: 'SR2D4 / LST Explorer', subtitle: 'A browser-based thermal lab for turning multispectral GeoTIFFs into spatial evidence.', colab: 'Open Colab', upload: 'Load SR2D4/MS product', uploadHint: 'Local GeoTIFF • nothing is uploaded to a server', bands: 'SR2D4 optical bands', red: 'Red', nir: 'Near infrared (NIR)', swir: 'Short-wave infrared (SWIR)', calculate: 'Calculate thermal map', processing: 'Processing raster…', layers: 'Layers', lst: 'LST / temperature', optical: 'Optical image', opacity: 'Opacity', contrast: 'Contrast', palette: 'Palette', stats: 'Statistics', min: 'minimum', max: 'maximum', mean: 'mean', std: 'std dev', histogram: 'Temperature distribution', sample: 'Thermal Scale & Inspection', aoi: 'Area of interest', draw: 'Draw AOI', clear: 'Clear AOI', clip: 'Analyze AOI', export: 'Export', png: 'Composite PNG', tiff: 'LST GeoTIFF', uhi: 'UHI GeoTIFF', method: 'Methodology', help: 'How it works', metadata: 'Metadata', theme: 'Theme', basemap: 'Basemap', ready: 'Ready', error: 'Processing failed. Load an SR2D4 GeoTIFF with Red, NIR and SWIR; thermal Landsat is fetched automatically.', methodText: 'The workflow combines SR2D4 imagery with optical indices and TsHARP regression to estimate spatial LST. Spatial detail is estimated: super-resolution does not create independent thermal observations for every new pixel. Validate results with field data.', helpText: '1. Generate the MS product in Colab. 2. Load the GeoTIFF. 3. Confirm Red/NIR/SWIR. 4. Search a place, use GPS or enter coordinates. 5. Calculate and explore LST, indices, isotherms, AOI and exports.', noData: 'Load a GeoTIFF to begin', search: 'Search city, neighborhood or place', coords: 'Longitude, latitude', locate: 'My location', go: 'Go', compare: 'Compare before/after', before: 'Optical / before', after: 'LST / after', indices: 'Spectral indices', ndvi: 'NDVI vegetation', ndbi: 'NDBI built-up', report: 'Quick report', resize: 'Drag to resize the panel', searchError: 'Place not found.', uhiText: 'UHI levels (1m): Cool island, Mitigated, Neutral, Mild, Strong and Extreme.', aoiHelp: 'Activate Draw AOI, click at least three map points, then finish with ✓ or double-click.', aoiStats: 'AOI mean', limitation: 'Super-resolution limitations', limitationText: 'Detailed LST is an optical-index-guided estimate. Use it for spatial investigation and comparison, not as a replacement for field thermal measurement.',
  },
} as const;

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

function isothermColorForZ(z: number): string {
  if (z < -0.95) return '#2b83ba';
  if (z < -0.30) return '#66c2a5';
  if (z < 0.25) return '#fee08b';
  if (z < 0.85) return '#fdae61';
  if (z < 1.40) return '#f46d43';
  return '#d53e4f';
}

/**
 * Suavização de curvas vetoriais por corte de cantos de Chaikin (2 iterações).
 * Transforma segmentos lineares do Marching Squares em isotermas orgânicas suaves para meso-escala.
 */
function smoothChaikin(pts: [number, number][], closed: boolean): [number, number][] {
  if (pts.length < 3) return pts;
  let current = pts;
  for (let iter = 0; iter < 2; iter += 1) {
    const next: [number, number][] = [];
    if (!closed) next.push(current[0]);
    const limit = closed ? current.length : current.length - 1;
    for (let i = 0; i < limit; i += 1) {
      const p0 = current[i];
      const p1 = current[(i + 1) % current.length];
      next.push([0.75 * p0[0] + 0.25 * p1[0], 0.75 * p0[1] + 0.25 * p1[1]]);
      next.push([0.25 * p0[0] + 0.75 * p1[0], 0.25 * p0[1] + 0.75 * p1[1]]);
    }
    if (!closed) next.push(current[current.length - 1]);
    else if (next.length > 0) next.push([next[0][0], next[0][1]]);
    current = next;
  }
  return current;
}

/**
 * Gerador de Isotermas e Clusters Térmicos em Meso-escala via Marching Squares Contínuo.
 * Agrega o raster de 1m numa malha de meso-escala suavizada (~160x160), extrai as isolinhas
 * exatas por interpolação linear, encadeia os segmentos em polilinhas/polígonos e suaviza via Chaikin.
 */
function buildMesoscaleVectorIsotherms(
  data: Float32Array,
  width: number,
  height: number,
  bounds: RasterBounds,
  stats: { min: number; max: number; mean: number; stdDev: number },
  mode: IsothermMode,
  lang: Lang,
): IsothermCollection {
  const ext = boundsExtent(bounds);
  const gridW = Math.min(170, Math.max(60, Math.round(width / 24)));
  const gridH = Math.min(170, Math.max(60, Math.round(height / 24)));
  const nGrid = gridW * gridH;

  const sums = new Float64Array(nGrid);
  const counts = new Uint32Array(nGrid);

  for (let y = 0; y < height; y += 1) {
    const gy = Math.min(gridH - 1, Math.floor((y / height) * gridH));
    const row = y * width;
    const gRow = gy * gridW;
    for (let x = 0; x < width; x += 1) {
      const v = data[row + x];
      if (!Number.isFinite(v)) continue;
      const gx = Math.min(gridW - 1, Math.floor((x / width) * gridW));
      sums[gRow + gx] += v;
      counts[gRow + gx] += 1;
    }
  }

  let field = new Float32Array(nGrid);
  for (let i = 0; i < nGrid; i += 1) {
    field[i] = counts[i] > 0 ? sums[i] / counts[i] : stats.mean;
  }

  // Suavização Gaussiana de Meso-escala (3 passagens) para isotermas limpas de bairro
  const kernel = [1, 2, 1, 2, 4, 2, 1, 2, 1];
  for (let pass = 0; pass < 3; pass += 1) {
    const next = new Float32Array(nGrid);
    for (let y = 0; y < gridH; y += 1) {
      for (let x = 0; x < gridW; x += 1) {
        let s = 0;
        let w = 0;
        for (let ky = -1; ky <= 1; ky += 1) {
          for (let kx = -1; kx <= 1; kx += 1) {
            const ny = Math.max(0, Math.min(gridH - 1, y + ky));
            const nx = Math.max(0, Math.min(gridW - 1, x + kx));
            const kw = kernel[(ky + 1) * 3 + (kx + 1)];
            s += field[ny * gridW + nx] * kw;
            w += kw;
          }
        }
        next[y * gridW + x] = s / w;
      }
    }
    field = next;
  }

  const safeStd = Math.max(0.8, stats.stdDev);
  const levels: number[] = [];

  if (mode === 'clusters') {
    const zLevels = [-1.15, -0.50, 0.0, 0.50, 1.00, 1.45];
    zLevels.forEach((z) => {
      const tVal = Number((stats.mean + z * safeStd).toFixed(2));
      if (tVal > stats.min + 0.2 && tVal < stats.max - 0.2) levels.push(tVal);
    });
  } else {
    const step = mode === 'step-1.0' ? 1.0 : 1.5;
    const startT = Math.ceil((stats.min + 0.4) / step) * step;
    const endT = Math.floor((stats.max - 0.4) / step) * step;
    for (let tVal = startT; tVal <= endT + 1e-4; tVal += step) {
      levels.push(Number(tVal.toFixed(2)));
    }
  }

  if (levels.length === 0) {
    levels.push(Number(stats.mean.toFixed(2)));
  }

  const toGeo = (gx: number, gy: number): [number, number] => {
    const lng = ext.west + ((gx + 0.5) / gridW) * (ext.east - ext.west);
    const lat = ext.north - ((gy + 0.5) / gridH) * (ext.north - ext.south);
    return [Number(lng.toFixed(6)), Number(lat.toFixed(6))];
  };

  const features: IsothermFeature[] = [];
  let featureId = 1;

  levels.forEach((iso) => {
    type Seg = { p1: [number, number]; p2: [number, number]; k1: string; k2: string };
    const segments: Seg[] = [];

    const interp = (vA: number, vB: number): number => {
      const d = vB - vA;
      if (Math.abs(d) < 1e-7) return 0.5;
      return Math.max(0.02, Math.min(0.98, (iso - vA) / d));
    };

    for (let y = 0; y < gridH - 1; y += 1) {
      for (let x = 0; x < gridW - 1; x += 1) {
        const vTL = field[y * gridW + x];
        const vTR = field[y * gridW + x + 1];
        const vBR = field[(y + 1) * gridW + x + 1];
        const vBL = field[(y + 1) * gridW + x];

        let mask = 0;
        if (vTL >= iso) mask |= 8;
        if (vTR >= iso) mask |= 4;
        if (vBR >= iso) mask |= 2;
        if (vBL >= iso) mask |= 1;
        if (mask === 0 || mask === 15) continue;

        const topPt: [number, number] = [x + interp(vTL, vTR), y];
        const rightPt: [number, number] = [x + 1, y + interp(vTR, vBR)];
        const bottomPt: [number, number] = [x + interp(vBL, vBR), y + 1];
        const leftPt: [number, number] = [x, y + interp(vTL, vBL)];

        const topKey = `H:${x}:${y}`;
        const rightKey = `V:${x + 1}:${y}`;
        const bottomKey = `H:${x}:${y + 1}`;
        const leftKey = `V:${x}:${y}`;

        const addSeg = (p1: [number, number], k1: string, p2: [number, number], k2: string) => {
          segments.push({ p1, p2, k1, k2 });
        };

        switch (mask) {
          case 1:
          case 14:
            addSeg(leftPt, leftKey, bottomPt, bottomKey);
            break;
          case 2:
          case 13:
            addSeg(bottomPt, bottomKey, rightPt, rightKey);
            break;
          case 3:
          case 12:
            addSeg(leftPt, leftKey, rightPt, rightKey);
            break;
          case 4:
          case 11:
            addSeg(topPt, topKey, rightPt, rightKey);
            break;
          case 5:
            addSeg(leftPt, leftKey, topPt, topKey);
            addSeg(bottomPt, bottomKey, rightPt, rightKey);
            break;
          case 6:
          case 9:
            addSeg(topPt, topKey, bottomPt, bottomKey);
            break;
          case 7:
          case 8:
            addSeg(leftPt, leftKey, topPt, topKey);
            break;
          case 10:
            addSeg(topPt, topKey, rightPt, rightKey);
            addSeg(leftPt, leftKey, bottomPt, bottomKey);
            break;
          default:
            break;
        }
      }
    }

    // Encadeia segmentos que compartilham a mesma aresta na malha
    const adj = new Map<string, number[]>();
    segments.forEach((seg, idx) => {
      const list1 = adj.get(seg.k1) ?? [];
      list1.push(idx);
      adj.set(seg.k1, list1);
      const list2 = adj.get(seg.k2) ?? [];
      list2.push(idx);
      adj.set(seg.k2, list2);
    });

    const visited = new Uint8Array(segments.length);
    const zVal = (iso - stats.mean) / safeStd;
    const color = isothermColorForZ(zVal);
    const cls = uhiClassLabel(iso, stats, lang);

    for (let i = 0; i < segments.length; i += 1) {
      if (visited[i]) continue;
      visited[i] = 1;

      const chainPts: [number, number][] = [segments[i].p1, segments[i].p2];
      let headKey = segments[i].k1;
      let tailKey = segments[i].k2;

      // Avança pela cauda
      let growingTail = true;
      while (growingTail) {
        growingTail = false;
        const candidates = adj.get(tailKey) ?? [];
        for (const nextIdx of candidates) {
          if (!visited[nextIdx]) {
            visited[nextIdx] = 1;
            const s = segments[nextIdx];
            if (s.k1 === tailKey) {
              chainPts.push(s.p2);
              tailKey = s.k2;
            } else {
              chainPts.push(s.p1);
              tailKey = s.k1;
            }
            growingTail = true;
            break;
          }
        }
      }

      // Avança pela cabeça
      let growingHead = true;
      while (growingHead) {
        growingHead = false;
        const candidates = adj.get(headKey) ?? [];
        for (const nextIdx of candidates) {
          if (!visited[nextIdx]) {
            visited[nextIdx] = 1;
            const s = segments[nextIdx];
            if (s.k1 === headKey) {
              chainPts.unshift(s.p2);
              headKey = s.k2;
            } else {
              chainPts.unshift(s.p1);
              headKey = s.k1;
            }
            growingHead = true;
            break;
          }
        }
      }

      // Descarta micro-ilhas irrelevantes para meso-escala (< 6 vértices)
      if (chainPts.length < 6) continue;

      const isClosedLoop = headKey === tailKey && chainPts.length >= 8;
      const geoPts = chainPts.map(([gx, gy]) => toGeo(gx, gy));
      const smoothed = smoothChaikin(geoPts, isClosedLoop);

      // Adiciona a linha de isoterma
      features.push({
        type: 'Feature',
        properties: {
          id: featureId,
          temperature_c: iso,
          label: `${iso.toFixed(1)}°C`,
          uhi_class: cls,
          color,
          feature_type: 'isotherm_contour',
        },
        geometry: {
          type: 'LineString',
          coordinates: smoothed,
        },
      });
      featureId += 1;

      // Se formou um cluster fechado em meso-escala, adiciona também o polígono de cluster
      if (isClosedLoop && smoothed.length >= 6) {
        features.push({
          type: 'Feature',
          properties: {
            id: featureId,
            temperature_c: iso,
            label: `${iso.toFixed(1)}°C (${cls})`,
            uhi_class: cls,
            color,
            feature_type: 'thermal_cluster',
          },
          geometry: {
            type: 'Polygon',
            coordinates: [smoothed],
          },
        });
        featureId += 1;
      }
    }
  });

  return { type: 'FeatureCollection', features };
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
      out[px] = Math.max(0, Math.min(255, Math.round(r * shadeMult)));
      out[px + 1] = Math.max(0, Math.min(255, Math.round(g * shadeMult)));
      out[px + 2] = Math.max(0, Math.min(255, Math.round(b * shadeMult)));
      out[px + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
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
  onProgress?.('Calculando NDVI, NDBI e NDWI nas bandas selecionadas…');
  const indices = calculateOpticalIndices(red, nir, swir);
  onProgress?.('Executando TsHARP: agregando índices à grade térmica, ajustando LST–NDVI e conservando residual por célula…');
  const result = downscaleLandsatLST(landsat.lstCelsius, landsat.width, landsat.height, landsat.bounds, indices, tiff.width, tiff.height, bounds);
  const resolutionLabel = tiff.isProjected ? `${Math.abs(tiff.resolution[0]).toFixed(2)} m/pixel` : `${Math.abs(tiff.resolution[0]).toFixed(6)} graus/pixel`;
  onProgress?.(`Fusão concluída: ${result.model} · ${result.validCount} células coarse · coef. NDVI ${result.slope.toFixed(4)} · saída ${tiff.width.toLocaleString()}×${tiff.height.toLocaleString()} px · resolução ${resolutionLabel}`);
  onProgress?.(`Prova numérica: LST coarse ${result.coarseRange.toFixed(2)} °C · LST fina ${result.fineRange.toFixed(2)} °C · sinal transferido do SR2D4 ${result.fineSignalRange.toFixed(2)} °C · erro médio de conservação ${result.conservationMae.toFixed(3)} °C`);
  return { tiff, bounds, indices, landsat, result };
}
function pointInPolygon(point: [number, number], polygon: [number, number][]) { let inside = false; for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) { const [xi, yi] = polygon[i]; const [xj, yj] = polygon[j]; const intersects = ((yi > point[1]) !== (yj > point[1])) && point[0] < (xj - xi) * (point[1] - yi) / ((yj - yi) || Number.EPSILON) + xi; if (intersects) inside = !inside; } return inside; }
function thermalDifference(primary: { data: Float32Array; width: number; height: number; bounds: RasterBounds; stats: { stdDev: number } }, secondary: { data: Float32Array; width: number; height: number; bounds: RasterBounds; stats: { stdDev: number } }) { const result = new Float32Array(primary.width * primary.height); const primaryExtent = boundsExtent(primary.bounds); const secondaryExtent = boundsExtent(secondary.bounds); for (let y = 0; y < primary.height; y += 1) for (let x = 0; x < primary.width; x += 1) { const lng = primaryExtent.west + (x + .5) / primary.width * (primaryExtent.east - primaryExtent.west); const lat = primaryExtent.north - (y + .5) / primary.height * (primaryExtent.north - primaryExtent.south); const sx = Math.floor((lng - secondaryExtent.west) / (secondaryExtent.east - secondaryExtent.west) * secondary.width); const sy = Math.floor((secondaryExtent.north - lat) / (secondaryExtent.north - secondaryExtent.south) * secondary.height); const a = primary.data[y * primary.width + x]; const b = sx >= 0 && sy >= 0 && sx < secondary.width && sy < secondary.height ? secondary.data[sy * secondary.width + sx] : NaN; result[y * primary.width + x] = Number.isFinite(a) && Number.isFinite(b) ? b - a : NaN; } return result; }
function renderDifferenceToCanvas(data: Float32Array, width: number, height: number, canvas: HTMLCanvasElement) { canvas.width = width; canvas.height = height; const ctx = canvas.getContext('2d'); if (!ctx) return null; const image = ctx.createImageData(width, height); let min = Infinity; let max = -Infinity; let count = 0; for (const value of data) if (Number.isFinite(value)) { min = Math.min(min, value); max = Math.max(max, value); count += 1; } const maxAbs = Math.max(0.1, count ? Math.max(Math.abs(min), Math.abs(max)) : 0); const color = (value: number) => { const t = Math.min(1, Math.abs(value) / maxAbs); const start = value < 0 ? [33, 102, 172] : [255, 255, 255]; const end = value < 0 ? [247, 247, 247] : [178, 24, 43]; return { r: Math.round(start[0] + (end[0] - start[0]) * t), g: Math.round(start[1] + (end[1] - start[1]) * t), b: Math.round(start[2] + (end[2] - start[2]) * t) }; }; for (let i = 0; i < data.length; i += 1) { const value = data[i]; const index = i * 4; if (!Number.isFinite(value)) { image.data[index + 3] = 0; continue; } const rgb = color(value); image.data[index] = rgb.r; image.data[index + 1] = rgb.g; image.data[index + 2] = rgb.b; image.data[index + 3] = 255; } ctx.putImageData(image, 0, 0); return { min: count ? min : 0, max: count ? max : 0, maxAbs }; }

function imageDateLabel(name: string, index: number) { const match = name.match(/(20\d{2})[-_]?([01]\d)[-_]?([0-3]\d)/); return match ? `${match[1]}-${match[2]}-${match[3]}` : `Data ${String(index + 1).padStart(2, '0')}`; }
function paletteGradient(palette: PaletteType, customColors: string[]) { const gradients: Record<string, string> = { ironbow: '#000082, #780078, #cc0000, #ffcc00, #ffffff', spectral: '#5e4fa2, #3288bd, #66c2a5, #fdd486, #f46d43, #9e0142', jet: '#000082, #00ffff, #00ff00, #ffff00, #ff0000', viridis: '#440154', '#3b528b', '#21918c', '#5ec962', '#fde725', magma: '#000004, #340f4b, #7b206b, #ca464a, #fcfdbf', coolwarm: '#3b4cc0, #dddddd, #b40426', terrain: '#225ea8, #53a85d, #dcbe68, #8b261f', grayscale: '#050505, #ffffff', custom: customColors.join(', ') }; return `linear-gradient(90deg, ${gradients[palette] || gradients.ironbow})`; }
function statsOf(data: Float32Array) { let min = Infinity; let max = -Infinity; let sum = 0; let count = 0; for (const value of data) if (Number.isFinite(value)) { min = Math.min(min, value); max = Math.max(max, value); sum += value; count += 1; } return { min: count ? min : 0, max: count ? max : 0, mean: count ? sum / count : 0 }; }

export default function App() {
  const [lang, setLang] = useState<Lang>(() => navigator.language.toLowerCase().startsWith('pt') ? 'pt' : 'en');
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('lst-theme') as Theme) || 'dark');
  const [provider, setProvider] = useState<Provider>('osm');
  const [raster, setRaster] = useState<RasterState | null>(null);
  const [lstUrl, setLstUrl] = useState<string | null>(null); const [opticalUrl, setOpticalUrl] = useState<string | null>(null);
  const [visibleLst, setVisibleLst] = useState(true); const [visibleOptical, setVisibleOptical] = useState(true);
  const [opacity, setOpacity] = useState(.86); const [contrast, setContrast] = useState(0); const [palette, setPalette] = useState<PaletteType>('ironbow'); const [customColors, setCustomColors] = useState(['#173f9d', '#2457b8', '#25a7a0', '#f5d547', '#e8752f', '#b62025']); const [displayMode, setDisplayMode] = useState<'temperature' | 'uhi'>('temperature');
  const [file, setFile] = useState<File | null>(null); const [bandCount, setBandCount] = useState(3); const [bandLabels, setBandLabels] = useState<string[]>([]); const [bands, setBands] = useState(['0', '1', '2']); const [busy, setBusy] = useState(false); const [status, setStatus] = useState(''); const [error, setError] = useState(''); const [processingLog, setProcessingLog] = useState<Array<{ time: string; message: string; level: 'info' | 'success' | 'error' }>>([]);
  const [sample, setSample] = useState<{ temp: number; lng: number; lat: number } | null>(null); const [hoverSample, setHoverSample] = useState<{ temp: number; lng: number; lat: number } | null>(null); const [identifyMode, setIdentifyMode] = useState(false); const [panEnabled, setPanEnabled] = useState(true); const [showMethod, setShowMethod] = useState(false); const [showHelp, setShowHelp] = useState(false); const [showMeta, setShowMeta] = useState(false); const [showLimits, setShowLimits] = useState(false); const [showTutorial, setShowTutorial] = useState(() => sessionStorage.getItem('sr2d4-tutorial-seen') !== '1'); const [tutorialStep, setTutorialStep] = useState(0); const [showSearch, setShowSearch] = useState(true);
  const [aoi, setAoi] = useState<[number, number][]>([]); const [drawAoi, setDrawAoi] = useState(false); const [aoiStats, setAoiStats] = useState<{ count: number; min: number; max: number; mean: number } | null>(null);
  const [search, setSearch] = useState(''); const [searchResults, setSearchResults] = useState<SearchResult[]>([]); const [searching, setSearching] = useState(false); const [searchError, setSearchError] = useState(''); const [coordText, setCoordText] = useState(''); const [comparisonCount, setComparisonCount] = useState(2); const [comparisonFiles, setComparisonFiles] = useState<(File | null)[]>([null, null]); const [comparisonImages, setComparisonImages] = useState<ComparisonImage[]>([]); const [comparisonMode, setComparisonMode] = useState<'difference' | 'secondary'>('difference'); const [differenceReady, setDifferenceReady] = useState(false); const [swipeActive, setSwipeActive] = useState(false); const [swipePosition, setSwipePosition] = useState(50); const [uhiSurface, setUhiSurface] = useState<UhiSurface | null>(null);
  const [uhiSurfaceVisible, setUhiSurfaceVisible] = useState(false);
  // Estados para Isotermas & Clusters Vetoriais em Meso-escala
  const [isothermsVisible, setIsothermsVisible] = useState(false);
  const [isothermMode, setIsothermMode] = useState<IsothermMode>('clusters');
  const [panelWidth, setPanelWidth] = useState(390); const resizing = useRef(false); const curtainDragging = useRef(false); const curtainMapRef = useRef<MapLibreMap | null>(null); const curtainContainerRef = useRef<HTMLDivElement>(null); const mapRef = useRef<HTMLDivElement>(null); const mapInstance = useRef<MapLibreMap | null>(null); const mapClickMode = useRef({ drawAoi: false, raster: null as RasterState | null, extent: null as ReturnType<typeof boundsExtent> | null, identifyMode: false });
  const lstCanvas = useRef<HTMLCanvasElement | null>(null); const opticalCanvas = useRef<HTMLCanvasElement | null>(null); const t = copy[lang]; const extent = raster ? boundsExtent(raster.bounds) : null; const comparisonPrimary = comparisonImages[0] ?? null; const comparisonSecondary = comparisonImages[1] ?? null; const differenceRender = useMemo(() => { if (!comparisonPrimary || !comparisonSecondary || !differenceReady) return null; const data = thermalDifference(comparisonPrimary, comparisonSecondary); const canvas = document.createElement('canvas'); const stats = renderDifferenceToCanvas(data, comparisonPrimary.width, comparisonPrimary.height, canvas) ?? statsOf(data); return { url: canvas.toDataURL('image/png'), stats }; }, [comparisonPrimary, comparisonSecondary, customColors, differenceReady, palette]);
  const uhiGradient = 'linear-gradient(90deg, #185a9d, #2b8c68, #8ac46e, #f7e28b, #f48438, #d72626, #fff2af)';
  const legendGradient = displayMode === 'uhi' ? uhiGradient : paletteGradient(palette, customColors);
  const differenceStats = differenceRender?.stats ?? null; const differenceExtent = differenceStats ? Math.max(Math.abs(differenceStats.min), Math.abs(differenceStats.max)) : 0;

  // Cálculo automático memorizado das Isotermas e Clusters em Meso-escala
  const vectorIsotherms = useMemo<IsothermCollection | null>(() => {
    if (!raster) return null;
    return buildMesoscaleVectorIsotherms(
      raster.data,
      raster.width,
      raster.height,
      raster.bounds,
      raster.stats,
      isothermMode,
      lang,
    );
  }, [raster, isothermMode, lang]);

  useEffect(() => { localStorage.setItem('lst-theme', theme); document.documentElement.dataset.theme = theme; }, [theme]);
  useEffect(() => { mapClickMode.current = { drawAoi, raster, extent, identifyMode }; }, [drawAoi, raster, extent, identifyMode]);
  useEffect(() => { const onMove = (event: PointerEvent) => { if (resizing.current) setPanelWidth(Math.max(330, Math.min(560, window.innerWidth - event.clientX))); if (curtainDragging.current) { const stage = document.querySelector('.map-stage') as HTMLElement | null; if (stage) { const rect = stage.getBoundingClientRect(); setSwipePosition(Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100))); } } }; const onUp = () => { resizing.current = false; curtainDragging.current = false; document.body.classList.remove('is-resizing'); document.body.classList.remove('is-curtain-dragging'); }; window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp); return () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); }; }, []);

  useEffect(() => {
    if (!mapRef.current || mapInstance.current) return;
    const map = new maplibregl.Map({ container: mapRef.current, style: { version: 8, sources: { basemap: { type: 'raster', tiles: [TILE_URLS.osm], tileSize: 256, attribution: '© OpenStreetMap contributors' } }, layers: [{ id: 'basemap', type: 'raster', source: 'basemap' }] }, center: [-46.63, -23.55], zoom: 4, attributionControl: false });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right'); map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
    const inspectAt = (event: maplibregl.MapMouseEvent, commit: boolean) => { const mode = mapClickMode.current; if (!mode.raster || !mode.extent) return; const x = Math.floor(((event.lngLat.lng - mode.extent.west) / (mode.extent.east - mode.extent.west)) * mode.raster.width); const y = Math.floor(((mode.extent.north - event.lngLat.lat) / (mode.extent.north - mode.extent.south)) * mode.raster.height); if (x >= 0 && y >= 0 && x < mode.raster.width && y < mode.raster.height) { const temp = mode.raster.data[y * mode.raster.width + x]; if (Number.isFinite(temp)) { const point = { temp, lng: event.lngLat.lng, lat: event.lngLat.lat }; if (commit) setSample(point); else if (mapClickMode.current.identifyMode) setHoverSample(point); } } };
    map.on('click', (event) => { const mode = mapClickMode.current; if (mode.drawAoi) { event.preventDefault(); setAoi((prev) => [...prev, [event.lngLat.lng, event.lngLat.lat]]); return; } inspectAt(event, true); });
    map.on('dblclick', (event) => { const mode = mapClickMode.current; if (!mode.drawAoi) return; event.preventDefault(); setAoi((prev) => { const cleaned = prev.length > 1 && Math.abs(prev[prev.length - 1][0] - event.lngLat.lng) < 1e-7 && Math.abs(prev[prev.length - 1][1] - event.lngLat.lat) < 1e-7 ? prev.slice(0, -1) : prev; if (cleaned.length >= 3) { setDrawAoi(false); setPanEnabled(true); map.dragPan.enable(); map.doubleClickZoom.enable(); map.scrollZoom.enable(); map.touchZoomRotate.enable(); } return cleaned; }); });
    let hoverFrame = 0; map.on('mousemove', (event) => { if (!mapClickMode.current.drawAoi && mapClickMode.current.identifyMode && !hoverFrame) { hoverFrame = requestAnimationFrame(() => { inspectAt(event, false); hoverFrame = 0; }); } }); map.on('dragstart', () => setHoverSample(null));
    map.dragPan.enable(); mapInstance.current = map; return () => { map.remove(); mapInstance.current = null; };
  }, []);
  const syncLayers = useCallback(() => { const map = mapInstance.current; if (!map || !map.isStyleLoaded()) return; const addOrUpdate = (id: string, url: string, coordinates: RasterBounds) => { const existing = map.getSource(id) as any; if (existing) existing.updateImage({ url, coordinates }); else map.addSource(id, { type: 'image', url, coordinates }); }; if (raster && lstUrl && opticalUrl) { addOrUpdate('lst-raster', lstUrl, raster.bounds); addOrUpdate('optical-raster', opticalUrl, raster.bounds); if (!map.getLayer('lst-layer')) map.addLayer({ id: 'lst-layer', type: 'raster', source: 'lst-raster', paint: { 'raster-opacity': opacity, 'raster-contrast': contrast } }); if (!map.getLayer('optical-layer')) map.addLayer({ id: 'optical-layer', type: 'raster', source: 'optical-raster', paint: { 'raster-opacity': 1 } }); } if (comparisonPrimary && comparisonSecondary && differenceReady) { addOrUpdate('comparison-primary-raster', comparisonPrimary.lstUrl, comparisonPrimary.bounds); addOrUpdate('comparison-lst-raster', comparisonSecondary.lstUrl, comparisonSecondary.bounds); if (!map.getLayer('comparison-primary-layer')) map.addLayer({ id: 'comparison-primary-layer', type: 'raster', source: 'comparison-primary-raster', paint: { 'raster-opacity': 1 } }); if (!map.getLayer('comparison-lst-layer')) map.addLayer({ id: 'comparison-lst-layer', type: 'raster', source: 'comparison-lst-raster', paint: { 'raster-opacity': .5 } }); if (differenceRender) addOrUpdate('comparison-difference-raster', differenceRender.url, comparisonPrimary.bounds); if (!map.getLayer('comparison-difference-layer')) map.addLayer({ id: 'comparison-difference-layer', type: 'raster', source: 'comparison-difference-raster', paint: { 'raster-opacity': .9 } }); map.setLayoutProperty('comparison-primary-layer', 'visibility', swipeActive ? 'visible' : 'none'); map.setLayoutProperty('comparison-lst-layer', 'visibility', !swipeActive && comparisonMode === 'secondary' ? 'visible' : 'none'); map.setPaintProperty('comparison-lst-layer', 'raster-opacity', .9); map.setLayoutProperty('comparison-difference-layer', 'visibility', comparisonMode === 'difference' && !swipeActive ? 'visible' : 'none'); } else { for (const id of ['comparison-primary-layer', 'comparison-lst-layer', 'comparison-difference-layer']) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none'); } if (map.getLayer('lst-layer')) { map.setLayoutProperty('lst-layer', 'visibility', visibleLst && !swipeActive && !(comparisonMode === 'difference' && differenceReady) ? 'visible' : 'none'); map.setPaintProperty('lst-layer', 'raster-opacity', opacity); map.setPaintProperty('lst-layer', 'raster-contrast', contrast); } if (map.getLayer('optical-layer')) map.setLayoutProperty('optical-layer', 'visibility', visibleOptical && !swipeActive && !(comparisonMode === 'difference' && differenceReady) ? 'visible' : 'none'); const aoiSource = map.getSource('aoi-source') as any; if (aoi.length >= 2) { const coordinates = aoi.length >= 3 ? [...aoi, aoi[0]] : aoi; const geometry = aoi.length >= 3 ? { type: 'Polygon', coordinates: [coordinates] } : { type: 'LineString', coordinates }; if (aoiSource) aoiSource.setData({ type: 'Feature', geometry, properties: {} }); else { map.addSource('aoi-source', { type: 'geojson', data: { type: 'Feature', geometry, properties: {} } }); map.addLayer({ id: 'aoi-fill', type: 'fill', source: 'aoi-source', filter: ['==', '$type', 'Polygon'], paint: { 'fill-color': '#ffb000', 'fill-opacity': .18 } }); map.addLayer({ id: 'aoi-line', type: 'line', source: 'aoi-source', paint: { 'line-color': '#ffb000', 'line-width': 3, 'line-dasharray': [2, 1] } }); } } else if (aoiSource) { aoiSource.setData({ type: 'FeatureCollection', features: [] }); } }, [aoi, comparisonMode, comparisonPrimary, comparisonSecondary, contrast, differenceReady, differenceRender, lstUrl, opacity, opticalUrl, raster, swipeActive, swipePosition, visibleLst, visibleOptical]);

  useEffect(() => { const container = curtainContainerRef.current; const main = mapInstance.current; if (!container || !main || !swipeActive || !comparisonSecondary || !differenceReady) { curtainMapRef.current?.remove(); curtainMapRef.current = null; return; } const curtainMap = new maplibregl.Map({ container, style: { version: 8, sources: {}, layers: [] }, center: main.getCenter(), zoom: main.getZoom(), bearing: main.getBearing(), pitch: main.getPitch(), interactive: false, attributionControl: false }); const syncCamera = () => curtainMap.jumpTo({ center: main.getCenter(), zoom: main.getZoom(), bearing: main.getBearing(), pitch: main.getPitch() }); const addCurtainLayer = () => { curtainMap.addSource('curtain-secondary-raster', { type: 'image', url: comparisonSecondary.lstUrl, coordinates: comparisonSecondary.bounds }); curtainMap.addLayer({ id: 'curtain-secondary-layer', type: 'raster', source: 'curtain-secondary-raster', paint: { 'raster-opacity': 1 } }); syncCamera(); }; curtainMap.on('load', addCurtainLayer); main.on('move', syncCamera); curtainMapRef.current = curtainMap; return () => { main.off('move', syncCamera); curtainMap.remove(); curtainMapRef.current = null; }; }, [comparisonSecondary, differenceReady, swipeActive]);
  useEffect(() => { const source = mapInstance.current?.getSource('basemap') as any; if (source?.setTiles) source.setTiles([TILE_URLS[provider]]); }, [provider]);
  useEffect(() => { const map = mapInstance.current; if (!map) return; const locked = drawAoi || identifyMode; if (locked) { map.dragPan.disable(); map.scrollZoom.disable(); map.boxZoom.disable(); map.doubleClickZoom.disable(); map.dragRotate.disable(); map.keyboard.disable(); map.touchZoomRotate.disable(); map.getCanvas().style.cursor = 'crosshair'; } else { if (panEnabled) map.dragPan.enable(); else map.dragPan.disable(); map.scrollZoom.enable(); map.boxZoom.enable(); map.doubleClickZoom.enable(); map.dragRotate.enable(); map.keyboard.enable(); map.touchZoomRotate.enable(); map.getCanvas().style.cursor = ''; } }, [drawAoi, identifyMode, panEnabled]);
  useEffect(() => { const map = mapInstance.current; if (!map || (!raster && !differenceReady)) return; if (map.isStyleLoaded()) syncLayers(); else map.once('load', syncLayers); return () => { map.off('load', syncLayers); }; }, [lstUrl, opticalUrl, raster, syncLayers]);
  useEffect(() => { const viewExtent = extent ?? (comparisonPrimary ? boundsExtent(comparisonPrimary.bounds) : null); if (mapInstance.current && viewExtent) mapInstance.current.fitBounds([[viewExtent.west, viewExtent.south], [viewExtent.east, viewExtent.north]], { padding: 70, duration: 850, maxZoom: 16 }); }, [comparisonPrimary, extent, raster]);
  useEffect(() => { const map = mapInstance.current; if (!map || !map.isStyleLoaded()) return; const source = map.getSource('aoi-source') as maplibregl.GeoJSONSource | undefined; const coordinates = aoi.length >= 3 ? [...aoi, aoi[0]] : aoi.length ? [...aoi, aoi[0]] : []; const data = { type: 'FeatureCollection' as const, features: coordinates.length ? [{ type: 'Feature' as const, properties: {}, geometry: { type: 'Polygon' as const, coordinates: [coordinates] } }] : [] }; if (source) source.setData(data); else { map.addSource('aoi-source', { type: 'geojson', data }); map.addLayer({ id: 'aoi-fill', type: 'fill', source: 'aoi-source', paint: { 'fill-color': '#ffb000', 'fill-opacity': .15 } }); map.addLayer({ id: 'aoi-line', type: 'line', source: 'aoi-source', paint: { 'line-color': '#ffb000', 'line-width': 3, 'line-dasharray': [2, 1] } }); } }, [aoi]);
  useEffect(() => { if (raster) setUhiSurface(buildUhiSurface({ data: raster.data, width: raster.width, height: raster.height, bounds: raster.bounds, mean: raster.stats.mean, stdDev: raster.stats.stdDev })); else setUhiSurface(null); }, [raster]);
  useEffect(() => {
    if (!raster) return;
    const canvas = document.createElement('canvas');
    if (displayMode === 'uhi') {
      renderHighDefUhiToCanvas(raster.data, raster.width, raster.height, canvas, raster.stats.mean, raster.stats.stdDev);
    } else {
      renderLstToCanvas(raster.data, raster.width, raster.height, canvas, palette, customColors);
    }
    lstCanvas.current = canvas;
    setLstUrl(canvas.toDataURL('image/png'));
  }, [customColors, displayMode, palette, raster]);
  useEffect(() => { const map = mapInstance.current; if (!map || !uhiSurface) return; const syncUhi = () => { if (!map.isStyleLoaded()) return; const source = map.getSource('uhi-surface') as maplibregl.GeoJSONSource | undefined; if (source) source.setData(uhiSurface as any); else { map.addSource('uhi-surface', { type: 'geojson', data: uhiSurface as any }); map.addLayer({ id: 'uhi-surface-fill', type: 'fill', source: 'uhi-surface', paint: { 'fill-color': ['match', ['get', 'class'], 'cool', '#1a9641', 'light', '#fee08b', 'moderate', '#fd8d3c', 'extreme', '#d7191c', '#d7191c'], 'fill-opacity': .22 } }); map.addLayer({ id: 'uhi-surface-line', type: 'line', source: 'uhi-surface', paint: { 'line-color': '#ffffff', 'line-opacity': .15, 'line-width': .6 } }); } if (map.getLayer('uhi-surface-fill')) map.setLayoutProperty('uhi-surface-fill', 'visibility', displayMode === 'uhi' && uhiSurfaceVisible ? 'visible' : 'none'); if (map.getLayer('uhi-surface-line')) map.setLayoutProperty('uhi-surface-line', 'visibility', displayMode === 'uhi' && uhiSurfaceVisible ? 'visible' : 'none'); }; if (map.isStyleLoaded()) syncUhi(); else map.once('load', syncUhi); return () => { map.off('load', syncUhi); }; }, [displayMode, uhiSurface, uhiSurfaceVisible]);

  // Efeito para sobrepor as Isotermas e Clusters Vetoriais de Meso-escala no mapa MapLibre
  useEffect(() => {
    const map = mapInstance.current;
    if (!map || !vectorIsotherms) return;
    const syncIsotherms = () => {
      if (!map.isStyleLoaded()) return;
      const source = map.getSource('isotherms-source') as maplibregl.GeoJSONSource | undefined;
      if (source) {
        source.setData(vectorIsotherms as any);
      } else {
        map.addSource('isotherms-source', { type: 'geojson', data: vectorIsotherms as any });
        map.addLayer({
          id: 'isotherms-cluster-fill',
          type: 'fill',
          source: 'isotherms-source',
          filter: ['==', '$type', 'Polygon'],
          paint: {
            'fill-color': ['get', 'color'],
            'fill-opacity': 0.14,
          },
        });
        map.addLayer({
          id: 'isotherms-line-casing',
          type: 'line',
          source: 'isotherms-source',
          filter: ['==', '$type', 'LineString'],
          paint: {
            'line-color': '#061014',
            'line-width': 3.4,
            'line-opacity': 0.85,
          },
        });
        map.addLayer({
          id: 'isotherms-line',
          type: 'line',
          source: 'isotherms-source',
          filter: ['==', '$type', 'LineString'],
          paint: {
            'line-color': ['get', 'color'],
            'line-width': 2.0,
            'line-opacity': 0.96,
          },
        });
      }
      const vis = isothermsVisible ? 'visible' : 'none';
      if (map.getLayer('isotherms-cluster-fill')) map.setLayoutProperty('isotherms-cluster-fill', 'visibility', vis);
      if (map.getLayer('isotherms-line-casing')) map.setLayoutProperty('isotherms-line-casing', 'visibility', vis);
      if (map.getLayer('isotherms-line')) map.setLayoutProperty('isotherms-line', 'visibility', vis);
    };
    if (map.isStyleLoaded()) syncIsotherms();
    else map.once('load', syncIsotherms);
    return () => { map.off('load', syncIsotherms); };
  }, [vectorIsotherms, isothermsVisible]);

  const handleFileChange = async (selected: File | null) => { setFile(selected); setError(''); setSearchResults([]); if (!selected) return; setStatus(lang === 'pt' ? 'Lendo bandas e metadados…' : 'Reading bands and metadata…'); try { const preview = await readTiffPixels(selected); const count = preview.rasters.length; setBandCount(count); setBandLabels(preview.bandLabels); const standardTenBand = preview.bandLabels.length === 10 && preview.bandLabels[2]?.includes('B04') && preview.bandLabels[6]?.includes('B08') && preview.bandLabels[8]?.includes('B11') && preview.bandLabels[9]?.includes('B12'); setBands(standardTenBand ? ['2', '6', '8'] : (prev) => prev.map((value, index) => Number(value) < count ? value : String(Math.max(0, count - 1 - index)))); setStatus(lang === 'pt' ? `${count} bandas detectadas — confirme Red, NIR e SWIR.` : `${count} bands detected — confirm Red, NIR and SWIR.`); } catch { setError(lang === 'pt' ? 'Não foi possível ler as bandas deste GeoTIFF.' : 'Unable to read the bands from this GeoTIFF.'); setStatus(''); } };
  const closeTutorial = () => { setShowTutorial(false); sessionStorage.setItem('sr2d4-tutorial-seen', '1'); };
  const updateComparisonCount = (value: number) => { setComparisonCount(value); setComparisonFiles((previous) => Array.from({ length: value }, (_, index) => previous[index] ?? null)); setComparisonImages([]); setDifferenceReady(false); };
  const calculateComparisons = async () => { const selected = comparisonFiles.filter((item): item is File => Boolean(item)); if (selected.length < 2) { setError(lang === 'pt' ? 'Selecione pelo menos duas imagens para
