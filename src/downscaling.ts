// src/downscaling.ts

export type TsHarpResult = {
  lstDownscaled: Float32Array;
  slope: number;
  intercept: number;
  r2: number;
  sharpened: false;
  validCount: number;
};

/**
 * Diagnóstico TsHARP seguro para uma única grade.
 *
 * TsHARP exige LST coarse e variável óptica fine, com agregação/reamostragem
 * explícita e adição do residual coarse. Como a aplicação recebe hoje uma
 * única grade, não há informação térmica independente para criar novos
 * pixels. O retorno conserva a LST de entrada e expõe apenas a regressão
 * diagnóstica; isso evita o erro de transformar NDVI em temperatura absoluta.
 */
export function applyTsHARP(
  ndvi: Float32Array,
  lstBase: Float32Array,
): TsHarpResult {
  if (ndvi.length !== lstBase.length) {
    throw new Error('NDVI e LST precisam estar na mesma grade para o diagnóstico.');
  }

  let n = 0;
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumYY = 0;
  let sumXY = 0;

  for (let i = 0; i < ndvi.length; i += 1) {
    const x = ndvi[i];
    const y = lstBase[i];
    // Água e alvos sem vegetação não devem definir a relação NDVI–LST.
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0.1 || x > 0.95) continue;
    n += 1;
    sumX += x;
    sumY += y;
    sumXX += x * x;
    sumYY += y * y;
    sumXY += x * y;
  }

  if (n < 10) {
    throw new Error('Amostra insuficiente de pixels de solo/vegetação para ajustar TsHARP.');
  }

  const denominator = n * sumXX - sumX * sumX;
  const slope = Math.abs(denominator) > 1e-12 ? (n * sumXY - sumX * sumY) / denominator : 0;
  const intercept = (sumY - slope * sumX) / n;
  const ssTot = sumYY - (sumY * sumY) / n;
  const ssReg = slope * (sumXY - (sumX * sumY) / n);
  const r2 = ssTot > 1e-12 ? Math.max(0, Math.min(1, ssReg / ssTot)) : 0;

  // Sem LST coarse separada, o produto válido é a própria LST observada.
  // Não aplicamos a regressão pixel a pixel: isso criaria falsos extremos.
  const lstDownscaled = new Float32Array(lstBase);

  return { lstDownscaled, slope, intercept, r2, sharpened: false, validCount: n };
}
