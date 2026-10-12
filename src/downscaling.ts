import type { RasterBounds } from './rasterGeo';
import { boundsExtent } from './rasterGeo';

export type TsHarpResult = {
  lstDownscaled: Float32Array;
  slope: number;
  intercept: number;
  r2: number;
  sharpened: boolean;
  validCount: number;
};

type Features = { ndvi: Float32Array; ndbi: Float32Array; ndwi: Float32Array };

function solveRidge(matrix: number[][], vector: number[], ridge = 1e-5) {
  const n = vector.length;
  const a = matrix.map((row, i) => [...row, vector[i]]);
  for (let i = 0; i < n; i += 1) a[i][i] += ridge;
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
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

function featureVector(features: Features, index: number): number[] {
  return [1, features.ndvi[index], features.ndbi[index], features.ndwi[index]];
}

/**
 * Downscaling conservativo: a regressão é ajustada entre LST Landsat coarse e
 * médias dos preditores SR2D4 na mesma célula. O residual observado de cada
 * célula Landsat é devolvido a todos os pixels finos daquela célula, de modo que
 * a média fina continue compatível com a observação térmica coarse.
 */
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
  const sums = Array.from({ length: nCells }, () => [0, 0, 0, 0, 0]);
  const fineCell = new Int32Array(fineWidth * fineHeight);
  fineCell.fill(-1);
  for (let y = 0; y < fineHeight; y += 1) for (let x = 0; x < fineWidth; x += 1) {
    const lon = fine.west + (x + 0.5) / fineWidth * (fine.east - fine.west);
    const lat = fine.north - (y + 0.5) / fineHeight * (fine.north - fine.south);
    const cx = Math.floor((lon - coarse.west) / (coarse.east - coarse.west) * coarseWidth);
    const cy = Math.floor((coarse.north - lat) / (coarse.north - coarse.south) * coarseHeight);
    if (cx < 0 || cy < 0 || cx >= coarseWidth || cy >= coarseHeight) continue;
    const cell = cy * coarseWidth + cx;
    const index = y * fineWidth + x;
    const values = featureVector(fineFeatures, index);
    fineCell[index] = cell;
    if (values.slice(1).every(Number.isFinite)) {
      sums[cell][0] += 1;
      sums[cell][1] += values[1];
      sums[cell][2] += values[2];
      sums[cell][3] += values[3];
      sums[cell][4] += values[0];
    }
  }

  const normal = Array.from({ length: 4 }, () => Array(4).fill(0));
  const target = Array(4).fill(0);
  const coarseMeans = new Float32Array(nCells * 3);
  coarseMeans.fill(NaN);
  let validCount = 0;
  let targetSum = 0;
  let targetSq = 0;
  for (let cell = 0; cell < nCells; cell += 1) {
    const temperature = coarseLST[cell];
    const count = sums[cell][0];
    if (!Number.isFinite(temperature) || count < 4) continue;
    const mean = [sums[cell][1] / count, sums[cell][2] / count, sums[cell][3] / count];
    coarseMeans[cell * 3] = mean[0]; coarseMeans[cell * 3 + 1] = mean[1]; coarseMeans[cell * 3 + 2] = mean[2];
    const row = [1, ...mean];
    for (let i = 0; i < 4; i += 1) { target[i] += row[i] * temperature; for (let j = 0; j < 4; j += 1) normal[i][j] += row[i] * row[j]; }
    validCount += 1; targetSum += temperature; targetSq += temperature * temperature;
  }
  if (validCount === 0) throw new Error('Nenhum pixel térmico Landsat coincide com a área e os preditores ópticos válidos do SR2D4.');
  if (validCount < 8) {
    // Fallback conservador: não ajusta uma regressão multivariada instável.
    // Transfere a LST coarse para a grade fina por célula, sem fabricar detalhe.
    const fallback = new Float32Array(fineWidth * fineHeight);
    fallback.fill(NaN);
    for (let i = 0; i < fallback.length; i += 1) {
      const cell = fineCell[i];
      if (cell >= 0 && Number.isFinite(coarseLST[cell])) fallback[i] = coarseLST[cell];
    }
    return { lstDownscaled: fallback, slope: 0, intercept: targetSum / validCount, r2: 0, sharpened: false, validCount };
  }
  const coefficients = solveRidge(normal, target);
  if (!coefficients) throw new Error('Não foi possível ajustar a relação térmica multivariada.');

  const output = new Float32Array(fineWidth * fineHeight);
  output.fill(NaN);
  const residuals = new Float32Array(nCells);
  residuals.fill(NaN);
  for (let cell = 0; cell < nCells; cell += 1) {
    const count = sums[cell][0];
    const temperature = coarseLST[cell];
    if (!Number.isFinite(temperature) || count < 4) continue;
    const mean = [coarseMeans[cell * 3], coarseMeans[cell * 3 + 1], coarseMeans[cell * 3 + 2]];
    const predicted = coefficients[0] + coefficients[1] * mean[0] + coefficients[2] * mean[1] + coefficients[3] * mean[2];
    residuals[cell] = temperature - predicted;
  }
  for (let i = 0; i < output.length; i += 1) {
    const cell = fineCell[i];
    if (cell < 0 || !Number.isFinite(residuals[cell])) continue;
    const values = featureVector(fineFeatures, i);
    const predicted = coefficients[0] + coefficients[1] * values[1] + coefficients[2] * values[2] + coefficients[3] * values[3];
    output[i] = predicted + residuals[cell];
  }
  const mean = targetSum / validCount;
  const ssTot = targetSq - validCount * mean * mean;
  let ssErr = 0;
  for (let cell = 0; cell < nCells; cell += 1) if (Number.isFinite(coarseLST[cell]) && Number.isFinite(residuals[cell])) ssErr += residuals[cell] ** 2;
  const r2 = ssTot > 1e-9 ? Math.max(0, Math.min(1, 1 - ssErr / ssTot)) : 0;
  return { lstDownscaled: output, slope: coefficients[1], intercept: coefficients[0], r2, sharpened: true, validCount };
}

/** Compatibilidade para arquivos antigos: sem LST coarse separada, não inventa detalhe térmico. */
export function applyTsHARP(ndvi: Float32Array, lstBase: Float32Array): TsHarpResult {
  if (ndvi.length !== lstBase.length) throw new Error('NDVI e LST precisam estar na mesma grade.');
  let n = 0; let sumX = 0; let sumY = 0; let sumXX = 0; let sumYY = 0; let sumXY = 0;
  for (let i = 0; i < ndvi.length; i += 1) { const x = ndvi[i]; const y = lstBase[i]; if (!Number.isFinite(x) || !Number.isFinite(y)) continue; n += 1; sumX += x; sumY += y; sumXX += x * x; sumYY += y * y; sumXY += x * y; }
  const denominator = n * sumXX - sumX * sumX;
  const slope = n > 1 && Math.abs(denominator) > 1e-12 ? (n * sumXY - sumX * sumY) / denominator : 0;
  const intercept = n ? (sumY - slope * sumX) / n : 0;
  const ssTot = sumYY - (sumY * sumY) / Math.max(n, 1);
  const ssReg = slope * (sumXY - (sumX * sumY) / Math.max(n, 1));
  return { lstDownscaled: new Float32Array(lstBase), slope, intercept, r2: ssTot > 1e-12 ? Math.max(0, Math.min(1, ssReg / ssTot)) : 0, sharpened: false, validCount: n };
}
