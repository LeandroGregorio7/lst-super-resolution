import { boundsExtent } from './rasterGeo';
import type { RasterBounds } from './rasterGeo';

export type TsHarpResult = {
  lstDownscaled: Float32Array;
  slope: number;
  intercept: number;
  r2: number;
  sharpened: boolean;
  validCount: number;
  model: 'TsHARP-NDVI-polynomial' | 'multivariate-NDVI-NDBI' | 'multivariate-NDVI-NDBI-NDWI' | 'coarse-fallback';
  coarseRange: number;
  fineRange: number;
  fineSignalRange: number;
  conservationMae: number;
  coarseWidth: number;
  coarseHeight: number;
};

type Features = { ndvi: Float32Array; ndbi: Float32Array; ndwi: Float32Array };
type CellStats = { count: number; sumNdvi: number; sumNdbi: number; countNdwi: number; sumNdwi: number };

function solveRidge(matrix: number[][], vector: number[], ridge = 1e-8) {
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

function range(values: ArrayLike<number>) {
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

/** TsHARP coarse-to-fine com índices finos do SR2D4 e residual Landsat conservado. */
export function downscaleLandsatLST(
  coarseLST: Float32Array, coarseWidth: number, coarseHeight: number, coarseBounds: RasterBounds,
  fineFeatures: Features, fineWidth: number, fineHeight: number, fineBounds: RasterBounds,
): TsHarpResult {
  const coarse = boundsExtent(coarseBounds);
  const fine = boundsExtent(fineBounds);
  const nCells = coarseWidth * coarseHeight;
  const cells: CellStats[] = Array.from({ length: nCells }, () => ({ count: 0, sumNdvi: 0, sumNdbi: 0, countNdwi: 0, sumNdwi: 0 }));
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
    const ndvi = fineFeatures.ndvi[index]; const ndbi = fineFeatures.ndbi[index]; const ndwi = fineFeatures.ndwi[index];
    if (Number.isFinite(ndvi) && Number.isFinite(ndbi)) {
      const stats = cells[cell]; stats.count += 1; stats.sumNdvi += ndvi; stats.sumNdbi += ndbi;
      if (Number.isFinite(ndwi)) { stats.countNdwi += 1; stats.sumNdwi += ndwi; }
    }
  }

  const means = Array.from({ length: nCells }, () => [NaN, NaN, NaN]);
  const validCells: number[] = [];
  for (let cell = 0; cell < nCells; cell += 1) {
    const stats = cells[cell]; const temperature = coarseLST[cell];
    if (!Number.isFinite(temperature) || stats.count < 1) continue;
    const ndvi = stats.sumNdvi / stats.count; const ndbi = stats.sumNdbi / stats.count; const ndwi = stats.countNdwi ? stats.sumNdwi / stats.countNdwi : NaN;
    means[cell] = [ndvi, ndbi, ndwi];
    validCells.push(cell);
  }
  if (!validCells.length) throw new Error('Nenhuma célula térmica Landsat válida após a máscara QA e a verificação dos índices ópticos.');

  // NDVI polynomial is the canonical TsHARP basis. Add NDBI and a truly
  // independent green-NIR NDWI only when they are available and sample size allows.
  const ndwiCellCount = validCells.filter((cell) => Number.isFinite(means[cell][2])).length;
  const useNdwiModel = validCells.length >= 12 && ndwiCellCount >= 12;
  const useNdbiModel = !useNdwiModel && validCells.length >= 8;
  const rows = validCells.map((cell) => {
    const [ndvi, ndbi, ndwi] = means[cell];
    return useNdwiModel ? [1, ndvi, ndbi, ndwi] : useNdbiModel ? [1, ndvi, ndbi] : [1, ndvi, ndvi * ndvi];
  });
  const target = validCells.map((cell) => coarseLST[cell]);
  const coefficients = fitModel(rows, target);
  if (!coefficients) throw new Error('Não foi possível ajustar a relação LST–índices na grade Landsat.');

  // In-sample R² is reported as a diagnostic only; independent thermal data
  // are still required for accuracy validation.
  const fittedTargets = rows.map((row) => row.reduce((sum, value, index) => sum + value * coefficients[index], 0));
  const targetMean = target.reduce((sum, value) => sum + value, 0) / target.length;
  const residualSumSquares = target.reduce((sum, value, index) => sum + (value - fittedTargets[index]) ** 2, 0);
  const totalSumSquares = target.reduce((sum, value) => sum + (value - targetMean) ** 2, 0);
  const fitR2 = totalSumSquares > 1e-12 ? 1 - residualSumSquares / totalSumSquares : NaN;

  const predict = (index: number) => {
    const ndvi = fineFeatures.ndvi[index]; const ndbi = fineFeatures.ndbi[index]; const ndwi = fineFeatures.ndwi[index];
    if (!Number.isFinite(ndvi)) return NaN;
    if (useNdwiModel) return Number.isFinite(ndbi) && Number.isFinite(ndwi) ? coefficients[0] + coefficients[1] * ndvi + coefficients[2] * ndbi + coefficients[3] * ndwi : NaN;
    if (useNdbiModel) return Number.isFinite(ndbi) ? coefficients[0] + coefficients[1] * ndvi + coefficients[2] * ndbi : NaN;
    return coefficients[0] + coefficients[1] * ndvi + coefficients[2] * ndvi * ndvi;
  };

  // Predict on the actual SR2D4 grid first. A coarse residual alone is not
  // sufficient for conservation: fine-pixel sampling and missing values can make
  // the mean of the predictions differ from the coarse model prediction.
  const finePredictions = new Float32Array(fineWidth * fineHeight);
  finePredictions.fill(NaN);
  const predictionSums = new Float64Array(nCells);
  const predictionCounts = new Uint32Array(nCells);
  for (let index = 0; index < finePredictions.length; index += 1) {
    const cell = fineCell[index];
    if (cell < 0 || !Number.isFinite(coarseLST[cell])) continue;
    const predicted = predict(index);
    if (!Number.isFinite(predicted)) continue;
    finePredictions[index] = predicted;
    predictionSums[cell] += predicted;
    predictionCounts[cell] += 1;
  }

  // Cell-wise additive residual is estimated from the *mean of fine predictions*
  // in that exact Landsat cell. This enforces the coarse observation constraint:
  // mean(T_fine | cell) == T_Landsat, up to Float32 rounding.
  const cellCorrections = new Float32Array(nCells);
  cellCorrections.fill(NaN);
  for (let cell = 0; cell < nCells; cell += 1) {
    if (predictionCounts[cell] && Number.isFinite(coarseLST[cell])) {
      cellCorrections[cell] = coarseLST[cell] - predictionSums[cell] / predictionCounts[cell];
    }
  }

  const output = new Float32Array(fineWidth * fineHeight);
  output.fill(NaN);
  const finePredictionValues: number[] = [];
  const signalValues: number[] = [];
  const coarseValues: number[] = [];
  for (let index = 0; index < output.length; index += 1) {
    const cell = fineCell[index];
    const predicted = finePredictions[index];
    if (cell < 0 || !Number.isFinite(predicted) || !Number.isFinite(cellCorrections[cell])) continue;
    output[index] = predicted + cellCorrections[cell];
    finePredictionValues.push(predicted);
    signalValues.push(output[index] - coarseLST[cell]);
    coarseValues.push(coarseLST[cell]);
  }

  // Numerical proof that the output is not just the coarse image repeated.
  // The signal range is measured against the coarse value assigned to each
  // fine pixel; conservation is measured by the mean error per thermal cell.
  const sums = new Float64Array(nCells); const counts = new Uint32Array(nCells);
  for (let index = 0; index < output.length; index += 1) { const cell = fineCell[index]; if (cell >= 0 && Number.isFinite(output[index])) { sums[cell] += output[index]; counts[cell] += 1; } }
  let conservationError = 0; let conservationCount = 0;
  for (let cell = 0; cell < nCells; cell += 1) if (counts[cell] && Number.isFinite(coarseLST[cell])) { conservationError += Math.abs(sums[cell] / counts[cell] - coarseLST[cell]); conservationCount += 1; }
  const fineSignalRange = range(signalValues);
  if (fineSignalRange < 0.01 && finePredictionValues.length > 0) throw new Error(`TsHARP não gerou detalhe espectral mensurável (amplitude ${fineSignalRange.toFixed(3)} °C). A execução foi interrompida para não apresentar a TIRS como super-resolução.`);
  return {
    lstDownscaled: output, slope: coefficients[1] ?? 0, intercept: coefficients[0] ?? 0,
    r2: fitR2, sharpened: true, validCount: validCells.length,
    model: useNdwiModel ? 'multivariate-NDVI-NDBI-NDWI' : useNdbiModel ? 'multivariate-NDVI-NDBI' : 'TsHARP-NDVI-polynomial',
    coarseRange: range(coarseValues), fineRange: range(output), fineSignalRange,
    conservationMae: conservationCount ? conservationError / conservationCount : NaN,
    coarseWidth, coarseHeight,
  };
}

/** Compatibilidade para arquivos legados; não é usado no fluxo automático. */
export function applyTsHARP(ndvi: Float32Array, lstBase: Float32Array): TsHarpResult {
  if (ndvi.length !== lstBase.length) throw new Error('NDVI e LST precisam estar na mesma grade.');
  const output = new Float32Array(lstBase); const valid = Array.from(lstBase).filter(Number.isFinite).length;
  return { lstDownscaled: output, slope: 0, intercept: valid ? lstBase[0] : 0, r2: 0, sharpened: false, validCount: valid, model: 'coarse-fallback', coarseRange: range(lstBase), fineRange: range(output), fineSignalRange: 0, conservationMae: 0, coarseWidth: lstBase.length, coarseHeight: 1 };
}
