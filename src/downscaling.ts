// src/downscaling.ts

/**
 * Aplica o algoritmo TsHARP (Regressão Linear) para fazer o downscaling da Temperatura.
 * Cruzamos o detalhe do NDVI (1m) com a Temperatura (LST).
 */
export function applyTsHARP(ndvi1m: Float32Array, lstBase: Float32Array): {
  lstDownscaled: Float32Array;
  slope: number;
  intercept: number;
} {
  const totalPixels = ndvi1m.length;
  
  // Array que vai guardar a nossa nova temperatura de 1 metro
  const lstDownscaled = new Float32Array(totalPixels);

  console.log("📐 A iniciar o treino do modelo TsHARP (Regressão Linear)...");

  // --- 1. Calcular as Médias ---
  let sumNdvi = 0;
  let sumLst = 0;
  let validPixels = 0;

  for (let i = 0; i < totalPixels; i++) {
    // Ignoramos píxeis vazios, água ou nuvens extremas (NDVI < 0)
    if (ndvi1m[i] > 0 && !isNaN(lstBase[i])) {
      sumNdvi += ndvi1m[i];
      sumLst += lstBase[i];
      validPixels++;
    }
  }

  const meanNdvi = sumNdvi / validPixels;
  const meanLst = sumLst / validPixels;

  // --- 2. Calcular o 'a' (Declive) e 'b' (Interseção) ---
  let numerador = 0;
  let denominador = 0;

  for (let i = 0; i < totalPixels; i++) {
    if (ndvi1m[i] > 0 && !isNaN(lstBase[i])) {
      const diffNdvi = ndvi1m[i] - meanNdvi;
      const diffLst = lstBase[i] - meanLst;
      
      numerador += (diffNdvi * diffLst);
      denominador += (diffNdvi * diffNdvi);
    }
  }

  // O declive (a) diz-nos o quanto a temperatura cai por cada ponto de NDVI
  const slope = denominador !== 0 ? numerador / denominador : 0;
  const intercept = meanLst - (slope * meanNdvi);

  console.log(`📊 Equação TsHARP encontrada: Temperatura = (${slope.toFixed(2)} * NDVI) + ${intercept.toFixed(2)}`);

  // --- 3. Aplicar o Downscaling (Fusão) ---
  for (let i = 0; i < totalPixels; i++) {
    // Aplicamos a fórmula da temperatura a TODOS os 17 milhões de píxeis de 1 metro
    lstDownscaled[i] = (slope * ndvi1m[i]) + intercept;
  }

  return {
    lstDownscaled,
    slope,
    intercept
  };
}