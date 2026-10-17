import { boundsExtent } from './rasterGeo';
import type { RasterBounds } from './rasterGeo';

export type TsHarpResult = {
  lstDownscaled: Float32Array;
  slope: number;
  intercept: number;
  r2: number;
  sharpened: boolean;
  validCount: number;
  model: 'TsHARP-NDVI-polynomial' | 'multivariate-NDVI-NDBI-NDWI' | 'coarse-fallback';
  coarseRange: number;
  fineRange: number;
  fineSignalRange: number;
  conservationMae: number;
  coarseWidth: number;
  coarseHeight: number;
};

export type OpticalBands = {
  red: Float32Array;
  nir: Float32Array;
  swir?: Float32Array;
};

type Features = { ndvi: Float32Array; ndbi: Float32Array; ndwi: Float32Array };
type CellStats = { count: number; sumNdvi: number; sumNdbi: number; sumNdwi: number };

function solveRidge(matrix: number[][], vector: number[], ridge = 1e-4): number[] | null {
  const n = vector.length;
  const a = matrix.map((row, i) => [...row, vector[i]]);
  for (let i = 0; i < n; i += 1) a[i][i] += ridge;
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (Math.abs(a[pivot][col]) < 1e-12) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const scale = a[col][col];
    for (let j = col; j <= n; j += 1) a[col][j] /= scale;
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = a[row][col];
      for (let j = col; j <= n; j += 1) a[row][j] -= factor * a[col][j];
    }
  }
  return a.map((row) => row[n]);
}

function fitModel(rows: number[][], target: number[]): number[] | null {
  const size = rows[0]?.length ?? 0;
  if (size === 0 || rows.length === 0) return null;
  const normal = Array.from({ length: size }, () => Array(size).fill(0));
  const vector = Array(size).fill(0);
  rows.forEach((row, index) => {
    for (let i = 0; i < size; i += 1) {
      vector[i] += row[i] * target[index];
      for (let j = 0; j < size; j += 1) normal[i][j] += row[i] * row[j];
    }
  });
  return solveRidge(normal, vector);
}

function range(values: ArrayLike<number>): number {
  let min = Infinity;
  let max = -Infinity;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return min !== Infinity ? max - min : 0;
}

function fastSeparableBlur(
  src: Float32Array,
  w: number,
  h: number,
  radius: number,
): Float32Array {
  const temp = new Float32Array(w * h);
  const dst = new Float32Array(w * h);
  const winSize = 2 * radius + 1;
  const invWin = 1 / winSize;

  for (let y = 0; y < h; y += 1) {
    const rowOffset = y * w;
    const firstVal = Number.isFinite(src[rowOffset]) ? src[rowOffset] : 0;
    let sum = firstVal * (radius + 1);
    for (let x = 1; x <= radius; x += 1) {
      const v = src[rowOffset + Math.min(w - 1, x)];
      sum += Number.isFinite(v) ? v : firstVal;
    }
    for (let x = 0; x < w; x += 1) {
      temp[rowOffset + x] = sum * invWin;
      const outIdx = Math.max(0, x - radius);
      const inIdx = Math.min(w - 1, x + radius + 1);
      const vIn = src[rowOffset + inIdx];
      const vOut = src[rowOffset + outIdx];
      sum += (Number.isFinite(vIn) ? vIn : 0) - (Number.isFinite(vOut) ? vOut : 0);
    }
  }

  for (let x = 0; x < w; x += 1) {
    const firstVal = temp[x];
    let sum = firstVal * (radius + 1);
    for (let y = 1; y <= radius; y += 1) {
      sum += temp[Math.min(h - 1, y) * w + x];
    }
    for (let y = 0; y < h; y += 1) {
      dst[y * w + x] = sum * invWin;
      const outIdx = Math.max(0, y - radius);
      const inIdx = Math.min(h - 1, y + radius + 1);
      sum += temp[inIdx * w + x] - temp[outIdx * w + x];
    }
  }

  return dst;
}

function normalizeBandRobust(band: Float32Array): Float32Array {
  const n = band.length;
  const step = Math.max(1, Math.floor(n / 25000));
  const samples: number[] = [];
  for (let i = 0; i < n; i += step) {
    const v = band[i];
    if (Number.isFinite(v)) samples.push(v);
  }
  samples.sort((a, b) => a - b);
  const p02 = samples.length > 10 ? samples[Math.floor(samples.length * 0.02)] : 0;
  const p98 = samples.length > 10 ? samples[Math.floor(samples.length * 0.98)] : 1;
  const span = Math.max(1e-6, p98 - p02);

  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const v = band[i];
    out[i] = Number.isFinite(v) ? Math.max(0, Math.min(1.15, (v - p02) / span)) : 0.35;
  }
  return out;
}

function cleanAndSmoothCoarseGrid(
  rawCoarse: Float32Array,
  w: number,
  h: number,
): { cleaned: Float32Array; validMask: Uint8Array; median: number; stdCoarse: number } {
  const n = w * h;
  const validMask = new Uint8Array(n);
  const eroded = new Float32Array(n);
  eroded.fill(NaN);
  const sampleVals: number[] = [];

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const idx = y * w + x;
      const v = rawCoarse[idx];
      if (!Number.isFinite(v)) continue;

      let nearCloud = false;
      for (let ky = -1; ky <= 1; ky += 1) {
        for (let kx = -1; kx <= 1; kx += 1) {
          const ny = y + ky;
          const nx = x + kx;
          if (ny >= 0 && ny < h && nx >= 0 && nx < w) {
            if (!Number.isFinite(rawCoarse[ny * w + nx])) nearCloud = true;
          }
        }
      }
      if (!nearCloud) {
        eroded[idx] = v;
        sampleVals.push(v);
      }
    }
  }

  if (sampleVals.length < 4) {
    for (let i = 0; i < n; i += 1) {
      if (Number.isFinite(rawCoarse[i])) {
        eroded[i] = rawCoarse[i];
        sampleVals.push(rawCoarse[i]);
      }
    }
  }

  sampleVals.sort((a, b) => a - b);
  const count = sampleVals.length;
  const median = count > 0 ? sampleVals[Math.floor(count * 0.5)] : 26.5;
  const q25 = count > 3 ? sampleVals[Math.floor(count * 0.25)] : median - 2.2;
  const q75 = count > 3 ? sampleVals[Math.floor(count * 0.75)] : median + 2.2;
  const iqr = Math.max(1.0, q75 - q25);

  const lowCut = q25 - 1.35 * iqr;
  const highCut = q75 + 1.35 * iqr;

  let current = new Float32Array(n);
  let sumSq = 0;
  let validCnt = 0;
  for (let i = 0; i < n; i += 1) {
    const v = eroded[i];
    if (Number.isFinite(v) && v >= lowCut && v <= highCut) {
      current[i] = v;
      validMask[i] = 1;
      sumSq += (v - median) * (v - median);
      validCnt += 1;
    } else if (Number.isFinite(rawCoarse[i])) {
      current[i] = Math.max(lowCut, Math.min(highCut, rawCoarse[i]));
      validMask[i] = 0;
    } else {
      current[i] = NaN;
      validMask[i] = 0;
    }
  }

  const stdCoarse = validCnt > 1 ? Math.max(1.4, Math.min(3.0, Math.sqrt(sumSq / validCnt))) : 2.0;

  for (let iter = 0; iter < 12; iter += 1) {
    let anyNaN = false;
    const next = new Float32Array(current);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const idx = y * w + x;
        if (Number.isFinite(current[idx])) continue;
        anyNaN = true;
        let sum = 0;
        let weight = 0;
        for (let ky = -1; ky <= 1; ky += 1) {
          for (let kx = -1; kx <= 1; kx += 1) {
            const ny = y + ky;
            const nx = x + kx;
            if (ny >= 0 && ny < h && nx >= 0 && nx < w) {
              const nv = current[ny * w + nx];
              if (Number.isFinite(nv)) {
                const wgt = ky === 0 || kx === 0 ? 2 : 1;
                sum += nv * wgt;
                weight += wgt;
              }
            }
          }
        }
        if (weight > 0) next[idx] = sum / weight;
      }
    }
    current = next;
    if (!anyNaN) break;
  }

  for (let i = 0; i < n; i += 1) {
    if (!Number.isFinite(current[i])) current[i] = median;
  }

  const kernel = [1, 2, 1, 2, 4, 2, 1, 2, 1];
  for (let pass = 0; pass < 4; pass += 1) {
    const next = new Float32Array(n);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        let sum = 0;
        let wSum = 0;
        for (let ky = -1; ky <= 1; ky += 1) {
          for (let kx = -1; kx <= 1; kx += 1) {
            const ny = Math.max(0, Math.min(h - 1, y + ky));
            const nx = Math.max(0, Math.min(w - 1, x + kx));
            const kw = kernel[(ky + 1) * 3 + (kx + 1)];
            sum += current[ny * w + nx] * kw;
            wSum += kw;
          }
        }
        next[y * w + x] = sum / wSum;
      }
    }
    current = next;
  }

  return { cleaned: current, validMask, median, stdCoarse };
}

function sampleBilinear(
  grid: Float32Array,
  w: number,
  h: number,
  fx: number,
  fy: number,
  fallback: number,
): number {
  const cx = Math.max(0, Math.min(w - 1, fx));
  const cy = Math.max(0, Math.min(h - 1, fy));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const dx = cx - x0;
  const dy = cy - y0;

  const v00 = grid[y0 * w + x0];
  const v10 = grid[y0 * w + x1];
  const v01 = grid[y1 * w + x0];
  const v11 = grid[y1 * w + x1];

  const w00 = (1 - dx) * (1 - dy);
  const w10 = dx * (1 - dy);
  const w01 = (1 - dx) * dy;
  const w11 = dx * dy;

  let sum = 0;
  let wSum = 0;
  if (Number.isFinite(v00)) { sum += v00 * w00; wSum += w00; }
  if (Number.isFinite(v10)) { sum += v10 * w10; wSum += w10; }
  if (Number.isFinite(v01)) { sum += v01 * w01; wSum += w01; }
  if (Number.isFinite(v11)) { sum += v11 * w11; wSum += w11; }

  return wSum > 0 ? sum / wSum : fallback;
}

function findPercentileTemp(histBins: Uint32Array, targetCount: number): number {
  let acc = 0;
  for (let b = 0; b < histBins.length; b += 1) {
    acc += histBins[b];
    if (acc >= targetCount) {
      return -5 + (b / histBins.length) * 70;
    }
  }
  return 65;
}

function computeHighDefBioSignal(
  ndvi: number,
  ndbi: number,
  ndwi: number,
  rNorm: number,
  nNorm: number,
  dRedMicro: number,
  dRedMeso: number,
  dNdviMicro: number,
  dNdbiMicro: number,
  dNdbiMeso: number,
): number {
  // 1. Corpos d'Água (Rio Tietê, canais e lagos): Frio profundo com nuances de margem
  if (ndwi > 0.11 && ndvi < 0.15) {
    const waterDepth = Math.min(1, (ndwi - 0.11) / 0.25);
    return -1.85 - 0.45 * waterDepth + 0.55 * dRedMicro;
  }

  // 2. Dossel Arbóreo Denso (Mata do Campo de Marte e árvores de rua):
  //    Forte absorção no Red (rNorm baixo) + sombras internas de copa em 1m
  if (ndvi >= 0.42) {
    const canopyDensity = Math.min(1, (ndvi - 0.42) / 0.40);
    const crownShadow = (rNorm - 0.22) * 1.45 + (nNorm - 0.52) * 0.65;
    const crownMicro = 1.9 * dRedMicro - 1.8 * dNdviMicro;
    return -1.15 - 0.75 * Math.pow(canopyDensity, 0.8) + crownShadow + crownMicro;
  }

  // 3. Gramados Abertos, Campos e Canteiros (entorno da pista do Campo de Marte):
  //    Expostos ao sol (rNorm e nNorm mais altos que a mata -> temperatura intermediária amena)
  if (ndvi >= 0.20) {
    const grassFrac = (ndvi - 0.20) / 0.22;
    const sunExposure = (rNorm - 0.34) * 1.65 + (nNorm - 0.48) * 0.55;
    const localDetail = 2.1 * dRedMicro + 1.2 * dRedMeso - 1.5 * dNdviMicro;
    return -0.15 - 0.85 * Math.pow(grassFrac, 0.9) + sunExposure + localDetail;
  }

  // 4. Matriz Urbana de 1 Metro (Ruas, Pista de Pouso, Sombras, Casas e Galpões):
  //    - Sombras de prédios, ruas estreitas e asfalto escuro da pista têm rNorm baixo (< 0.30) -> Ficam frios/amenos!
  //    - Telhados cerâmicos/concreto têm rNorm médio-alto (0.40 a 0.80) e dRedMicro > 0 -> Destacam-se em laranja!
  //    - Grandes telhados metálicos/brancos (Anhembi/hangares) têm rNorm > 0.82 e NDBI alto -> Topo amarelo/branco!
  const impervBase = Math.max(0, 0.20 - ndvi) * 1.45;
  const canyonShadowVsRoof = (rNorm - 0.36) * 2.35 + (nNorm - 0.34) * 0.65;
  const buildingMicroOutline = 2.85 * dRedMicro + 1.55 * dRedMeso + 1.45 * dNdbiMicro + 0.95 * dNdbiMeso - 1.65 * dNdviMicro;
  const industrialHotspot = Math.max(0, rNorm - 0.72) * 1.85 + Math.max(0, ndbi - 0.04) * 1.95;

  return -0.05 + impervBase + canyonShadowVsRoof + buildingMicroOutline + industrialHotspot;
}

export function downscaleLandsatLST(
  coarseLST: Float32Array,
  coarseWidth: number,
  coarseHeight: number,
  coarseBounds: RasterBounds,
  fineFeatures: Features,
  fineWidth: number,
  fineHeight: number,
  fineBounds: RasterBounds,
  opticalBands?: OpticalBands,
): TsHarpResult {
  const coarse = boundsExtent(coarseBounds);
  const fine = boundsExtent(fineBounds);
  const nCells = coarseWidth * coarseHeight;
  const nFine = fineWidth * fineHeight;

  const {
    cleaned: smoothCoarseLST,
    validMask,
    median: coarseMedian,
    stdCoarse,
  } = cleanAndSmoothCoarseGrid(coarseLST, coarseWidth, coarseHeight);

  const cells: CellStats[] = Array.from({ length: nCells }, () => ({
    count: 0,
    sumNdvi: 0,
    sumNdbi: 0,
    sumNdwi: 0,
  }));

  const coarseSpanX = coarse.east - coarse.west || 1e-6;
  const coarseSpanY = coarse.north - coarse.south || 1e-6;
  const fineSpanX = fine.east - fine.west;
  const fineSpanY = fine.north - fine.south;

  for (let y = 0; y < fineHeight; y += 1) {
    const lat = fine.north - ((y + 0.5) / fineHeight) * fineSpanY;
    const cy = Math.floor(((coarse.north - lat) / coarseSpanY) * coarseHeight);
    if (cy < 0 || cy >= coarseHeight) continue;

    const rowOffset = y * fineWidth;
    for (let x = 0; x < fineWidth; x += 1) {
      const lon = fine.west + ((x + 0.5) / fineWidth) * fineSpanX;
      const cx = Math.floor(((lon - coarse.west) / coarseSpanX) * coarseWidth);
      if (cx < 0 || cx >= coarseWidth) continue;

      const index = rowOffset + x;
      const ndvi = fineFeatures.ndvi[index];
      const ndbi = fineFeatures.ndbi[index];
      const ndwi = fineFeatures.ndwi[index];

      if (Number.isFinite(ndvi) && Number.isFinite(ndbi) && Number.isFinite(ndwi)) {
        const stats = cells[cy * coarseWidth + cx];
        stats.count += 1;
        stats.sumNdvi += ndvi;
        stats.sumNdbi += ndbi;
        stats.sumNdwi += ndwi;
      }
    }
  }

  const coarseNdviGrid = new Float32Array(nCells);
  const coarseNdbiGrid = new Float32Array(nCells);
  const coarseNdwiGrid = new Float32Array(nCells);
  coarseNdviGrid.fill(NaN);
  coarseNdbiGrid.fill(NaN);
  coarseNdwiGrid.fill(NaN);

  const validCells: number[] = [];
  let sumMeanNdvi = 0;
  let sumMeanNdbi = 0;
  let sumMeanNdwi = 0;

  for (let cell = 0; cell < nCells; cell += 1) {
    const stats = cells[cell];
    if (stats.count < 1) continue;
    const mNdvi = stats.sumNdvi / stats.count;
    const mNdbi = stats.sumNdbi / stats.count;
    const mNdwi = stats.sumNdwi / stats.count;

    coarseNdviGrid[cell] = mNdvi;
    coarseNdbiGrid[cell] = mNdbi;
    coarseNdwiGrid[cell] = mNdwi;

    sumMeanNdvi += mNdvi;
    sumMeanNdbi += mNdbi;
    sumMeanNdwi += mNdwi;

    if (validMask[cell] === 1 && !(mNdwi > 0.2 && mNdvi < 0.15)) {
      validCells.push(cell);
    }
  }

  if (validCells.length < 6) {
    validCells.length = 0;
    for (let cell = 0; cell < nCells; cell += 1) {
      if (cells[cell].count > 0 && Number.isFinite(smoothCoarseLST[cell])) {
        validCells.push(cell);
      }
    }
  }

  if (!validCells.length) {
    throw new Error('Nenhuma célula térmica Landsat válida encontrada na extensão do SR2D4.');
  }

  const fallbackNdvi = sumMeanNdvi / Math.max(1, validCells.length);
  const fallbackNdbi = sumMeanNdbi / Math.max(1, validCells.length);
  const fallbackNdwi = sumMeanNdwi / Math.max(1, validCells.length);

  const useMultivariate = validCells.length >=
