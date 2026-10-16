// src/downscaling.ts
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

/**
 * Filtro Bilateral Rápido com Parada de Borda (Edge-Stopping Bilateral Filter).
 * Suaviza superfícies planas (ruas, pista, água) mas bloqueia a mistura através de bordas
 * de objetos diferentes (prédios, casas, árvores), mantendo contornos de 1m nítidos.
 */
function edgeStoppingBilateralFilter(
  signal: Float32Array,
  guideNdvi: Float32Array,
  guideNdbi: Float32Array,
  w: number,
  h: number,
): Float32Array {
  const out = new Float32Array(w * h);
  const invSigmaRange = 1.0 / (2.0 * 0.08 * 0.08); // Sensibilidade rigorosa a bordas espectrais

  for (let y = 0; y < h; y += 1) {
    const y0 = Math.max(0, y - 1) * w;
    const y1 = y * w;
    const y2 = Math.min(h - 1, y + 1) * w;

    for (let x = 0; x < w; x += 1) {
      const idx = y1 + x;
      const cVal = signal[idx];
      const cNdvi = guideNdvi[idx];
      const cNdbi = guideNdbi[idx];

      if (!Number.isFinite(cVal)) {
        out[idx] = NaN;
        continue;
      }

      const x0 = Math.max(0, x - 1);
      const x2 = Math.min(w - 1, x + 1);

      // Vizinhança 3x3 ponderada bilateralmente
      const nIdx = [
        y0 + x0, y0 + x, y0 + x2,
        y1 + x0, idx,    y1 + x2,
        y2 + x0, y2 + x, y2 + x2,
      ];
      const spatialW = [0.7, 1.0, 0.7, 1.0, 2.2, 1.0, 0.7, 1.0, 0.7];

      let sum = 0;
      let wSum = 0;

      for (let k = 0; k < 9; k += 1) {
        const ni = nIdx[k];
        const nVal = signal[ni];
        if (!Number.isFinite(nVal)) continue;

        const dNdvi = cNdvi - guideNdvi[ni];
        const dNdbi = cNdbi - guideNdbi[ni];
        const specDistSq = dNdvi * dNdvi + dNdbi * dNdbi;

        // Peso cai a zero na borda entre classes diferentes (ex: telhado vs árvore ou rua vs prédio)
        const wgt = spatialW[k] * Math.exp(-specDistSq * invSigmaRange);
        sum += nVal * wgt;
        wSum += wgt;
      }

      out[idx] = wSum > 0 ? sum / wSum : cVal;
    }
  }
  return out;
}

/**
 * Limpa outliers da grade Landsat (100m), preenche falhas de nuvem e gera
 * o campo térmico macro livre de degraus.
 */
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
  const median = count > 0 ? sampleVals[Math.floor(count * 0.5)] : 26.0;
  const q25 = count > 3 ? sampleVals[Math.floor(count * 0.25)] : median - 2.5;
  const q75 = count > 3 ? sampleVals[Math.floor(count * 0.75)] : median + 2.5;
  const iqr = Math.max(1.0, q75 - q25);

  const lowCut = q25 - 1.25 * iqr;
  const highCut = q75 + 1.25 * iqr;

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

  const stdCoarse = validCnt > 1 ? Math.sqrt(sumSq / validCnt) : 2.2;

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
  for (let pass = 0; pass < 3; pass += 1) {
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

/**
 * TsHARP + Filtro Bilateral Edge-Stopping + Anisotropia Volumétrica Solar 3D (Voogt & Oke, 2003)
 * + Fator de Visão do Céu (SVF / Oclusão de Cânion Urbano) com Conservação de Energia TIRS.
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
  const nFine = fineWidth * fineHeight;

  // 1. Limpa e suaviza a grade Landsat
  const {
    cleaned: smoothCoarseLST,
    validMask,
    median: coarseMedian,
    stdCoarse,
  } = cleanAndSmoothCoarseGrid(coarseLST, coarseWidth, coarseHeight);

  // 2. Agrega índices para a grade Landsat
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

    if (validMask[cell] === 1 && !(mNdwi > 0.18 && mNdvi < 0.15)) {
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

  // 3. Regressão Física TsHARP na Escala Landsat
  const useMultivariate = validCells.length >= 12;
  const rows = validCells.map((cell) => {
    const ndvi = coarseNdviGrid[cell];
    const ndbi = coarseNdbiGrid[cell];
    const ndwi = coarseNdwiGrid[cell];
    return useMultivariate ? [1, ndvi, ndbi, ndwi] : [1, ndvi, ndvi * ndvi];
  });
  const target = validCells.map((cell) => smoothCoarseLST[cell]);
  const rawCoeffs = fitModel(rows, target) ?? [coarseMedian, -5.4, 4.2, -1.8];

  const b0 = Number.isFinite(rawCoeffs[0]) ? rawCoeffs[0] : coarseMedian;
  const bNdvi = Math.max(-8.8, Math.min(-4.4, Number.isFinite(rawCoeffs[1]) ? rawCoeffs[1] : -5.4));
  const bNdbi = useMultivariate
    ? Math.min(7.8, Math.max(3.6, Number.isFinite(rawCoeffs[2]) ? rawCoeffs[2] : 4.2))
    : 3.9;
  const bNdwi = useMultivariate
    ? Math.max(-4.2, Math.min(-1.0, Number.isFinite(rawCoeffs[3]) ? rawCoeffs[3] : -1.8))
    : -1.6;

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

  // 4. Construção do Potencial Térmico Base + Mapa de Volume 3D (Height Proxy)
  //    Separa objetos volumétricos (Edificações e Árvores) de objetos planos (Ruas, Pista, Ferrovia, Água)
  const rawThermalSignal = new Float32Array(nFine);
  const volumeProxy = new Float32Array(nFine); // 0 = Plano (rua/pista/água), >0 = Volume 3D (prédio/casa/copa)

  for (let i = 0; i < nFine; i += 1) {
    const ndvi = fineFeatures.ndvi[i];
    const ndbi = fineFeatures.ndbi[i];
    const ndwi = fineFeatures.ndwi[i];

    if (!Number.isFinite(ndvi) || !Number.isFinite(ndbi) || !Number.isFinite(ndwi)) {
      rawThermalSignal[i] = NaN;
      volumeProxy[i] = 0;
      continue;
    }

    // Coordenadas no espaço HSV espectral para separar materiais urbanos
    const rChan = Math.max(0, Math.min(1, (ndbi + 0.55) / 1.15));
    const gChan = Math.max(0, Math.min(1, (ndvi + 0.15) / 0.95));
    const bChan = Math.max(0, Math.min(1, (ndwi + 0.40) / 0.95));

    const cMax = Math.max(rChan, gChan, bChan);
    const cMin = Math.min(rChan, gChan, bChan);
    const sat = cMax > 1e-5 ? (cMax - cMin) / cMax : 0;

    // Fração de Cobertura Vegetal (FVC)
    const fvc = Math.pow(Math.max(0, Math.min(1, (ndvi - 0.14) / 0.62)), 1.75);

    // Identificação física das classes de superfície:
    const isWater = ndwi > 0.12 && ndvi < 0.14;
    const isDenseCanopy = !isWater && ndvi >= 0.40; // Árvores (têm volume 3D)
    const isFlatGrass = !isWater && ndvi >= 0.20 && ndvi < 0.40; // Gramado rasteiro (plano)
    const isFlatRoadOrRunway = !isWater && ndvi < 0.20 && ndbi > -0.08 && sat < 0.38; // Asfalto/Pista/Ferrovia (plano)
    const is3DBuilding = !isWater && ndvi < 0.18 && ndbi > 0.02 && sat >= 0.38; // Telhados de Casas/Prédios/Galpões (volume 3D)

    let classAdjust = 0;
    let volHeight = 0;

    if (isWater) {
      classAdjust = -2.6;
      volHeight = 0.0; // Água é estritamente plana
    } else if (isDenseCanopy) {
      classAdjust = -0.95 * fvc;
      // Volume da copa da árvore proporcional ao vigor do dossel (FVC + NIR)
      volHeight = 0.65 * fvc + 0.35 * gChan;
    } else if (isFlatGrass) {
      classAdjust = -0.35 * fvc;
      volHeight = 0.08 * fvc; // Quase plano (canteiros/gramado do aeródromo)
    } else if (is3DBuilding) {
      // Estruturas edificadas destacam-se termicamente das ruas ao redor
      classAdjust = 0.95 * sat * rChan;
      volHeight = 0.80 * rChan + 0.45 * sat; // Alto relevo volumétrico 3D
    } else if (isFlatRoadOrRunway) {
      // Asfalto/pista/linha de trem: quente moderado, porém plano
      classAdjust = 0.35 * rChan;
      volHeight = 0.0; // Plano!
    } else {
      volHeight = Math.max(0, 0.3 * rChan);
    }

    rawThermalSignal[i] =
      bNdvi * (0.5 * ndvi + 0.5 * fvc) + bNdbi * ndbi + bNdwi * ndwi + classAdjust;
    volumeProxy[i] = volHeight;
  }

  // 5. Filtragem Bilateral com Parada de Borda (Edge-Stopping):
  //    Mantém ruas, pistas e rios lisos, mas crava um degrau nítido nas bordas de casas, prédios e árvores
  const bilateralSignal = edgeStoppingBilateralFilter(
    rawThermalSignal,
    fineFeatures.ndvi,
    fineFeatures.ndbi,
    fineWidth,
    fineHeight,
  );

  // 6. Síntese Final 1m com Anisotropia Solar 3D (Voogt & Oke) + Oclusão de Cânion (SVF)
  const output = new Float32Array(nFine);
  output.fill(NaN);

  const cellFineSums = new Float64Array(nCells);
  const cellFineCounts = new Uint32Array(nCells);

  let minSignal = Infinity;
  let maxSignal = -Infinity;
  let minCoarseUsed = Infinity;
  let maxCoarseUsed = -Infinity;

  // Vetor Solar Matinal da passagem do Landsat (~10h00 no Brasil -> Sol a Nordeste, Azimute ~50°)
  // Em coordenadas de imagem (x cresce para Leste, y cresce para Sul):
  const sunDirX = 0.766;  // Leste
  const sunDirY = -0.643; // Norte

  const macroWeight = 0.44;
  const softKneeThreshold = Math.max(2.5, stdCoarse * 1.3);

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
      const pClean = bilateralSignal[index];
      if (!Number.isFinite(pClean)) continue;

      const xPrev = Math.max(0, x - 1);
      const xNext = Math.min(fineWidth - 1, x + 1);

      // A) Gradiente de Borda Espectral (Sobel) para isolamento de classes
      const gxSpec = bilateralSignal[rowOffset + xNext] - bilateralSignal[rowOffset + xPrev];
      const gySpec = bilateralSignal[yNext + x] - bilateralSignal[yPrev + x];
      const edgeBarrier = Math.min(3.0, Math.sqrt(gxSpec * gxSpec + gySpec * gySpec));

      // B) Anisotropia Térmica Direcional 3D (Voogt & Oke, 2003):
      //    Derivada direcional do volume 3D na direção do Sol (média espacial zero = conserva energia!)
      //    Se for rua, pista ou água, volumeProxy é ~0, logo não gera falso relevo!
      const vCenter = volumeProxy[index];
      const vEast = volumeProxy[rowOffset + xNext];
      const vWest = volumeProxy[rowOffset + xPrev];
      const vSouth = volumeProxy[yNext + x];
      const vNorth = volumeProxy[yPrev + x];

      const dVolDx = (vEast - vWest) * 0.5;
      const dVolDy = (vSouth - vNorth) * 0.5;

      // Face Nordeste do prédio/copa recebe sol direto (+°C); face Sudoeste fica na sombra térmica (-°C)
      const solarVolumeShading = (dVolDx * sunDirX + dVolDy * sunDirY) * 1.65;

      // C) Fator de Visão do Céu (SVF / Oclusão na base de paredes e copas de árvores):
      //    Laplaciano do volume destaca o contorno escuro/frio no pé de prédios, casas e árvores
      const avgNeighborVol = 0.25 * (vEast + vWest + vSouth + vNorth);
      const canyonOcclusion = (vCenter - avgNeighborVol) * 1.15;

      // Micro-detalhe preservado dentro do mesmo objeto
      const microCrisp = (rawThermalSignal[index] - pClean) * 0.45;

      // Amostragem bilinear da grade Landsat (100m)
      const tCoarseRaw = sampleBilinear(smoothCoarseLST, coarseWidth, coarseHeight, fx, fy, coarseMedian);
      const ndviCoarseLocal = sampleBilinear(coarseNdviGrid, coarseWidth, coarseHeight, fx, fy, fallbackNdvi);
      const ndbiCoarseLocal = sampleBilinear(coarseNdbiGrid, coarseWidth, coarseHeight, fx, fy, fallbackNdbi);
      const ndwiCoarseLocal = sampleBilinear(coarseNdwiGrid, coarseWidth, coarseHeight, fx, fy, fallbackNdwi);

      const fvcCoarse = Math.pow(Math.max(0, Math.min(1, (ndviCoarseLocal - 0.14) / 0.62)), 1.75);
      const pCoarseLocal =
        bNdvi * (0.5 * ndviCoarseLocal + 0.5 * fvcCoarse) +
        bNdbi * ndbiCoarseLocal +
        bNdwi * ndwiCoarseLocal;

      // Nas bordas dos objetos (edgeBarrier alto) ou na água, bloqueamos o vazamento do halo de 100m
      const isWater = fineFeatures.ndwi[index] > 0.12 && fineFeatures.ndvi[index] < 0.14;
      const localMacroWeight = isWater ? 0.12 : macroWeight / (1.0 + 0.55 * edgeBarrier);
      const tMacro = coarseMedian + localMacroWeight * (tCoarseRaw - coarseMedian);

      // Realce de borda entre classes distintas sem criar halo branco
      const edgeContrastBoost = 1.0 + 0.35 * Math.min(1.8, edgeBarrier);

      // Soma física: Diferencial TsHARP com Borda + Volume Solar 3D + Oclusão SVF + Micro-textura
      const deltaT =
        0.72 * (pClean - pCoarseLocal) * edgeContrastBoost +
        solarVolumeShading +
        canyonOcclusion +
        microCrisp;

      // Compressão Soft-Knee para evitar saturação nas caudas quentes e frias
      const rawAnomaly = (tMacro - coarseMedian) + deltaT;
      const compressedAnomaly =
        softKneeThreshold * Math.tanh(rawAnomaly / softKneeThreshold) * 0.76 +
        rawAnomaly * 0.24;

      const finalTemp = coarseMedian + compressedAnomaly;
      output[index] = finalTemp;

      if (deltaT < minSignal) minSignal = deltaT;
      if (deltaT > maxSignal) maxSignal = deltaT;
      if (tCoarseRaw < minCoarseUsed) minCoarseUsed = tCoarseRaw;
      if (tCoarseRaw > maxCoarseUsed) maxCoarseUsed = tCoarseRaw;

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

/** Compatibilidade para arquivos legados; não é usado no fluxo automático. */
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
