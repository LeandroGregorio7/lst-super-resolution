import type { RasterBounds } from './rasterGeo';
import { boundsExtent } from './rasterGeo';

export type TsHarpResult = {
  lstDownscaled: Float32Array;
  slope: number;
  intercept: number;
  r2: number;
  sharpened: boolean;
  validCount: number;
  model: 'TsHARP-NDVI-polynomial' | 'multivariate-NDVI-NDBI-NDWI' | 'coarse-fallback';
};

type Features = { ndvi: Float32Array; ndbi: Float32Array; ndwi: Float32Array };

type CellStats = { count: number; sumNdvi: number; sumNdbi: number; sumNdwi: number; sumNdvi2: number };

function solveRidge(matrix: number[][], vector: number[], ridge = 1e-6) {
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

function fitModel(rows: number[][], target: number[]) {
  const size = rows[0]?.length ?? 0;
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

/**
 * TsHARP com fusão coarse-to-fine:
 * 1. agrega o NDVI/NDWI/NDBI nativo do SR2D4 para cada célula Landsat;
 * 2. ajusta LST coarse por NDVI (polinômio clássico) ou por NDVI+NDBI+NDWI;
 * 3. aplica a função ao NDVI fino do SR2D4;
 * 4. calcula o residual observado em cada célula Landsat e o adiciona ao mapa fino;
 * 5. a média do resultado dentro de cada célula térmica é preservada.
 *
 * A saída tem exatamente a grade e a resolução do GeoTIFF SR2D4. Isso é
 * sharpening espacial estimado, não criação de observações térmicas independentes.
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
  const cells: CellStats[] = Array.from({ length: nCells }, () => ({ count: 0, sumNdvi: 0, sumNdbi: 0, sumNdwi: 0, sumNdvi2: 0 }));
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
    fineCell[index] = cell;
    const ndvi = fineFeatures.ndvi[index];
    const ndbi = fineFeatures.ndbi[index];
    const ndwi = fineFeatures.ndwi[index];
    if (Number.isFinite(ndvi) && Number.isFinite(ndbi) && Number.isFinite(ndwi)) {
      const stats = cells[cell];
      stats.count += 1;
      stats.sumNdvi += ndvi;
      stats.sumNdbi += ndbi;
      stats.sumNdwi += ndwi;
      stats.sumNdvi2 += ndvi * ndvi;
    }
  }

  const validCells: number[] = [];
  const means = Array.from({ length: nCells }, () => [NaN, NaN, NaN]);
  for (let cell = 0; cell < nCells; cell += 1) {
    const stats = cells[cell];
    const temperature = coarseLST[cell];
    if (!Number.isFinite(temperature) || stats.count < 1) continue;
    const ndvi = stats.sumNdvi / stats.count;
    const ndbi = stats.sumNdbi / stats.count;
    const ndwi = stats.sumNdwi / stats.count;
    means[cell] = [ndvi, ndbi, ndwi];
    // TsHARP excludes open water from the scene relationship. Water is still
    // retained in the output through the coarse residual, but cannot define
    // the vegetation-temperature regression.
    const likelyWater = ndwi > 0.25 && ndvi < 0.25;
    if (!likelyWater) validCells.push(cell);
  }

  if (!validCells.length) throw new Error('Nenhuma célula térmica Landsat válida após a máscara e a exclusão de água do ajuste TsHARP.');

  const useMultivariate = validCells.length >= 8;
  const rows = validCells.map((cell) => {
    const [ndvi, ndbi, ndwi] = means[cell];
    return useMultivariate ? [1, ndvi, ndbi, ndwi] : [1, ndvi, ndvi * ndvi];
  });
  const target = validCells.map((cell) => coarseLST[cell]);
  const coefficients = fitModel(rows, target);
  if (!coefficients) throw new Error('Não foi possível ajustar a relação LST–índices na grade Landsat.');

  const prediction = (index: number) => {
    const ndvi = fineFeatures.ndvi[index];
    const ndbi = fineFeatures.ndbi[index];
    const ndwi = fineFeatures.ndwi[index];
    if (!Number.isFinite(ndvi) || !Number.isFinite(ndbi) || !Number.isFinite(ndwi)) return NaN;
    return useMultivariate
      ? coefficients[0] + coefficients[1] * ndvi + coefficients[2] * ndbi + coefficients[3] * ndwi
      : coefficients[0] + coefficients[1] * ndvi + coefficients[2] * ndvi * ndvi;
  };

  const residuals = new Float32Array(nCells);
  residuals.fill(NaN);
  let targetSum = 0;
  let targetSq = 0;
  let residualSq = 0;
  for (let cell = 0; cell < nCells; cell += 1) {
    const temperature = coarseLST[cell];
    const [ndvi, ndbi, ndwi] = means[cell];
    if (!Number.isFinite(temperature) || !Number.isFinite(ndvi)) continue;
    const coarsePrediction = useMultivariate
      ? coefficients[0] + coefficients[1] * ndvi + coefficients[2] * ndbi + coefficients[3] * ndwi
      : coefficients[0] + coefficients[1] * ndvi + coefficients[2] * ndvi * ndvi;
    residuals[cell] = temperature - coarsePrediction;
    targetSum += temperature;
    targetSq += temperature * temperature;
    residualSq += residuals[cell] * residuals[cell];
  }

  const output = new Float32Array(fineWidth * fineHeight);
  output.fill(NaN);
  for (let index = 0; index < output.length; index += 1) {
    const cell = fineCell[index];
    const finePrediction = prediction(index);
    if (cell < 0 || !Number.isFinite(finePrediction) || !Number.isFinite(residuals[cell])) continue;
    output[index] = finePrediction + residuals[cell];
  }

  const count = validCells.length;
  const mean = targetSum / Math.max(1, count);
  const ssTot = targetSq - count * mean * mean;
  const r2 = ssTot > 1e-9 ? Math.max(0, Math.min(1, 1 - residualSq / ssTot)) : 0;
  return {
    lstDownscaled: output,
    slope: coefficients[1] ?? 0,
    intercept: coefficients[0] ?? 0,
    r2,
    sharpened: true,
    validCount: count,
    model: useMultivariate ? 'multivariate-NDVI-NDBI-NDWI' : 'TsHARP-NDVI-polynomial',
  };
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
  return { lstDownscaled: new Float32Array(lstBase), slope, intercept, r2: ssTot > 1e-12 ? Math.max(0, Math.min(1, ssReg / ssTot)) : 0, sharpened: false, validCount: n, model: 'coarse-fallback' };
}
