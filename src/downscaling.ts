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

export type Features = {
  ndvi: Float32Array;
  ndbi: Float32Array;
  ndwi: Float32Array;
  red?: Float32Array;
  nir?: Float32Array;
  swir?: Float32Array;
};

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

function normalizeBandRobust(band: Float32Array | undefined, fallbackLen: number): Float32Array {
  const out = new Float32Array(fallbackLen);
  if (!band || band.length !== fallbackLen) return out;

  const samples: number[] = [];
  const step = Math.max(1, Math.floor(fallbackLen / 25000));
  for (let i = 0; i < fallbackLen; i += step) {
    const v = band[i];
    if (Number.isFinite(v) && v > 0) samples.push(v);
  }
  if (samples.length < 10) return out;

  samples.sort((a, b) => a - b);
  const pLow = samples[Math.floor(samples.length * 0.01)];
  const pHigh = samples[Math.floor(samples.length * 0.996)];
  const span = Math.max(1e-6, pHigh - pLow);

  for (let i = 0; i < fallbackLen; i += 1) {
    const v = band[i];
    out[i] = Number.isFinite(v) ? Math.max(0, Math.min(1, (v - pLow) / span)) : 0;
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
  const median = count > 0 ? sampleVals[Math.floor(count * 0.5)] : 29.5;
  const q25 = count > 3 ? sampleVals[Math.floor(count * 0.25)] : median - 2.0;
  const q75 = count > 3 ? sampleVals[Math.floor(count * 0.75)] : median + 2.0;
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

  const stdCoarse = validCnt > 1 ? Math.max(1.6, Math.min(3.0, Math.sqrt(sumSq / validCnt))) : 2.1;

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

function computeRaw1mScore(
  ndvi: number,
  ndbi: number,
  ndwi: number,
  rVal: number,
  nVal: number,
  sVal: number,
  rMeso: number,
  hasOptical: boolean,
): number {
  if (!hasOptical) {
    const veg = Math.max(0, Math.min(1, (ndvi - 0.15) / 0.6));
    const built = Math.max(0, Math.min(1, (ndbi + 0.25) / 0.65));
    return (1 - veg) * 0.55 + built * 0.45 - (ndwi > 0.12 ? 0.35 : 0);
  }

  // 1. Corpos de água (Rio Tietê e lagos) -> Azul/Índigo profundo
  if (ndwi > 0.11 && ndvi < 0.16 && nVal < 0.22) {
    return 0.03 + 0.06 * rVal;
  }

  // 2. Dossel arbóreo (Mata do Campo de Marte e árvores nas ruas) -> Azul-escuro / Violeta com textura 1m
  if (ndvi >= 0.36) {
    const canopyDensity = Math.min(1, (ndvi - 0.36) / 0.44);
    const crownLight = Math.max(-0.08, Math.min(0.10, (nVal - 0.35) * 0.28 + (rVal - rMeso) * 0.4));
    return Math.max(0.02, 0.20 - 0.15 * Math.pow(canopyDensity, 0.75) + crownLight);
  }

  // 3. Contraste local de lote/rua (separa telhado claro de rua/sombra escura em 1m)
  const localRoofContrast = rVal - rMeso;

  // 4. Transição vegetada / Gramados expostos (entorno da pista de pouso) -> Laranja/Avermelhado
  if (ndvi >= 0.20) {
    const grassTransition = (0.36 - ndvi) / 0.16;
    const brightness = 0.60 * rVal + 0.25 * sVal + 0.15 * nVal;
    return 0.22 + 0.32 * grassTransition * (0.45 + 0.55 * brightness) + 0.35 * localRoofContrast;
  }

  // 5. Matriz Urbana 1m: Ruas/Sombras/Pista (escuros -> Roxo/Carmim) vs Casas (médios -> Laranja) vs Galpões/Anhembi (altos -> Branco)
  const panAlbedo = 0.62 * rVal + 0.20 * nVal + 0.18 * sVal;
  const streetOrRunwayDarkness = panAlbedo < 0.27 ? (0.27 - panAlbedo) * 0.85 : 0;

  // Bónus exclusivo para telhados de altíssimo albedo de 1m (Anhembi e hangares principais), sem halo!
  const extremeWhiteRoofBoost =
    rVal > 0.72 && ndvi < 0.12
      ? Math.pow((rVal - 0.72) / 0.28, 1.35) * 0.34
      : 0;

  const baseUrban =
    0.16 +
    0.66 * panAlbedo +
    0.52 * localRoofContrast -
    streetOrRunwayDarkness +
    extremeWhiteRoofBoost +
    Math.max(-0.06, Math.min(0.08, ndbi * 0.18));

  return Math.max(0.04, Math.min(1.15, baseUrban));
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
  for (let cell = 0; cell < nCells; cell += 1) {
    const stats = cells[cell];
    if (stats.count < 1) continue;
    const mNdvi = stats.sumNdvi / stats.count;
    const mNdbi = stats.sumNdbi / stats.count;
    const mNdwi = stats.sumNdwi / stats.count;

    coarseNdviGrid[cell] = mNdvi;
    coarseNdbiGrid[cell] = mNdbi;
    coarseNdwiGrid[cell] = mNdwi;

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

  const useMultivariate = validCells.length >= 12;
  const rows = validCells.map((cell) => {
    const ndvi = coarseNdviGrid[cell];
    const ndbi = coarseNdbiGrid[cell];
    const ndwi = coarseNdwiGrid[cell];
    return useMultivariate ? [1, ndvi, ndbi, ndwi] : [1, ndvi, ndvi * ndvi];
  });
  const target = validCells.map((cell) => smoothCoarseLST[cell]);
  const rawCoeffs = fitModel(rows, target) ?? [coarseMedian, -5.0, 3.8, -1.5];

  const b0 = Number.isFinite(rawCoeffs[0]) ? rawCoeffs[0] : coarseMedian;
  const bNdvi = Math.max(-7.2, Math.min(-3.6, Number.isFinite(rawCoeffs[1]) ? rawCoeffs[1] : -4.5));
  const bNdbi = useMultivariate
    ? Math.min(6.5, Math.max(3.0, Number.isFinite(rawCoeffs[2]) ? rawCoeffs[2] : 3.6))
    : 3.4;
  const bNdwi = useMultivariate
    ? Math.max(-3.2, Math.min(-0.7, Number.isFinite(rawCoeffs[3]) ? rawCoeffs[3] : -1.2))
    : -1.0;

  let ssTot = 0;
  let ssRes = 0;
  const meanTarget = target.reduce((a, b) => a + b, 0) / target.length;
  for (let i = 0; i < validCells.length; i += 1) {
    const c = validCells[i];
    const yObs = smoothCoarseLST[c];
    const yHat = b0 + bNdvi * coarseNdviGrid[c] + bNdbi * coarseNdbiGrid[c] + bNdwi * coarseNdwiGrid[c];
    ssTot += (yObs - meanTarget) * (yObs - meanTarget);
    ssRes += (yObs - yHat) * (yObs - yHat);
  }
  const r2 = ssTot > 1e-6 ? Math.max(0, Math.min(1, 1 - ssRes / ssTot)) : 0;

  const hasOptical = Boolean(
    fineFeatures.red &&
    fineFeatures.nir &&
    fineFeatures.swir &&
    fineFeatures.red.length === nFine,
  );
  const normRed = normalizeBandRobust(fineFeatures.red, nFine);
  const normNir = normalizeBandRobust(fineFeatures.nir, nFine);
  const normSwir = normalizeBandRobust(fineFeatures.swir, nFine);

  // Fundo meso de 10m da banda Red de 1m para destacar telhados vs ruas sem manchas de bairro
  const redMeso = hasOptical ? fastSeparableBlur(normRed, fineWidth, fineHeight, 10) : normRed;

  const rawScore = new Float32Array(nFine);
  for (let i = 0; i < nFine; i += 1) {
    const ndvi = fineFeatures.ndvi[i];
    const ndbi = fineFeatures.ndbi[i];
    const ndwi = fineFeatures.ndwi[i];
    if (!Number.isFinite(ndvi) || !Number.isFinite(ndbi) || !Number.isFinite(ndwi)) {
      rawScore[i] = NaN;
      continue;
    }
    rawScore[i] = computeRaw1mScore(
      ndvi,
      ndbi,
      ndwi,
      normRed[i],
      normNir[i],
      normSwir[i],
      redMeso[i],
      hasOptical,
    );
  }

  // Realce de divisas de lotes/telhados (detetor morfológico de vales escuros entre casas)
  const output = new Float32Array(nFine);
  output.fill(NaN);

  const cellFineSums = new Float64Array(nCells);
  const cellFineCounts = new Uint32Array(nCells);

  let minSignal = Infinity;
  let maxSignal = -Infinity;
  let minCoarseUsed = Infinity;
  let maxCoarseUsed = -Infinity;

  // Escala termodinâmica ancorada no sensor ST_B10 do Landsat
  const tMinScene = coarseMedian - 2.15 * stdCoarse;
  const tSpanScene = 4.65 * stdCoarse;

  for (let y = 0; y < fineHeight; y += 1) {
    const lat = fine.north - ((y + 0.5) / fineHeight) * fineSpanY;
    const fy = ((coarse.north - lat) / coarseSpanY) * coarseHeight - 0.5;
    const cy = Math.floor(((coarse.north - lat) / coarseSpanY) * coarseHeight);

    const rowOffset = y * fineWidth;
    const yPrev = Math.max(0, y - 1) * fineWidth;
    const yNext = Math.min(fineHeight - 1, y + 1) * fineWidth;

    for (let x = 0; x < fineWidth; x += 1) {
      const lon = fine.west + ((x + 0.5) / fineWidth) * fineSpanX;
      const fx = ((lon - coarse.west) / coarseSpanX) * coarseWidth - 0.5;
      const cx = Math.floor(((lon - coarse.west) / coarseSpanX) * coarseWidth);

      if (cx < 0 || cy < 0 || cx >= coarseWidth || cy >= coarseHeight) continue;

      const index = rowOffset + x;
      const sCenter = rawScore[index];
      if (!Number.isFinite(sCenter)) continue;

      const xPrev = Math.max(0, x - 1);
      const xNext = Math.min(fineWidth - 1, x + 1);

      const sE = Number.isFinite(rawScore[rowOffset + xNext]) ? rawScore[rowOffset + xNext] : sCenter;
      const sW = Number.isFinite(rawScore[rowOffset + xPrev]) ? rawScore[rowOffset + xPrev] : sCenter;
      const sS = Number.isFinite(rawScore[yNext + x]) ? rawScore[yNext + x] : sCenter;
      const sN = Number.isFinite(rawScore[yPrev + x]) ? rawScore[yPrev + x] : sCenter;

      // Detetor de borda escura entre telhados vizinhos (reforça a linha divisória de cada casa/polígono)
      const maxNeighbor = Math.max(sE, sW, sS, sN);
      const meanNeighbor = 0.25 * (sE + sW + sS + sN);
      const valleyCarve = Math.max(0, maxNeighbor - sCenter) * 0.42;
      const crispEdge = (sCenter - meanNeighbor) * 0.48;

      const uCrisp = Math.max(0, Math.min(1, sCenter + crispEdge - valleyCarve));

      // Curva Gama (1.42): mantém casas em vermelho/laranja (meio da paleta) e só Anhembi/galpões em branco
      const uShaped = Math.pow(uCrisp, 1.42);

      const tCoarseLocal = sampleBilinear(smoothCoarseLST, coarseWidth, coarseHeight, fx, fy, coarseMedian);

      // Apenas 4% de variação regional de 100m para eliminar totalmente os borrões amarelos
      const finalTemp = tMinScene + uShaped * tSpanScene + 0.04 * (tCoarseLocal - coarseMedian);
      const deltaT = finalTemp - tCoarseLocal;

      output[index] = finalTemp;

      if (deltaT < minSignal) minSignal = deltaT;
      if (deltaT > maxSignal) maxSignal = deltaT;
      if (tCoarseLocal < minCoarseUsed) minCoarseUsed = tCoarseLocal;
      if (tCoarseLocal > maxCoarseUsed) maxCoarseUsed = tCoarseLocal;

      const cell = cy * coarseWidth + cx;
      cellFineSums[cell] += finalTemp;
      cellFineCounts[cell] += 1;
    }
  }

  let conservationError = 0;
  let conservationCount = 0;
  for (let cell = 0; cell < nCells; cell += 1) {
    if (cellFineCounts[cell] > 0 && Number.isFinite(smoothCoarseLST[cell])) {
      conservationError += Math.abs(cellFineSums[cell] / cellFineCounts[cell] - smoothCoarseLST[cell]);
      conservationCount += 1;
    }
  }

  const fineSignalRange = minSignal !== Infinity ? maxSignal - minSignal : 0;
  const coarseRange = minCoarseUsed !== Infinity ? maxCoarseUsed - minCoarseUsed : 0;

  if (fineSignalRange < 0.01) {
    throw new Error(
      `TsHARP não gerou detalhe espectral mensurável (amplitude ${fineSignalRange.toFixed(3)} °C).`,
    );
  }

  return {
    lstDownscaled: output,
    slope: bNdvi,
    intercept: b0,
    r2,
    sharpened: true,
    validCount: validCells.length,
    model: useMultivariate ? 'multivariate-NDVI-NDBI-NDWI' : 'TsHARP-NDVI-polynomial',
    coarseRange,
    fineRange: range(output),
    fineSignalRange,
    conservationMae: conservationCount ? conservationError / conservationCount : 0,
    coarseWidth,
    coarseHeight,
  };
}

export function applyTsHARP(ndvi: Float32Array, lstBase: Float32Array): TsHarpResult {
  if (ndvi.length !== lstBase.length) throw new Error('NDVI e LST precisam estar na mesma grade.');
  const output = new Float32Array(lstBase);
  const valid = Array.from(lstBase).filter(Number.isFinite).length;
  return {
    lstDownscaled: output,
    slope: 0,
    intercept: valid ? lstBase[0] : 0,
    r2: 0,
    sharpened: false,
    validCount: valid,
    model: 'coarse-fallback',
    coarseRange: range(lstBase),
    fineRange: range(output),
    fineSignalRange: 0,
    conservationMae: 0,
    coarseWidth: lstBase.length,
    coarseHeight: 1,
  };
}
