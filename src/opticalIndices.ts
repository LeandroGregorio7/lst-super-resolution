// src/opticalIndices.ts

/**
 * Módulo de Extração de Parâmetros Ópticos (1m) do SR2D4
 */
export function calculateOpticalIndices(
  bandRed: Float32Array,  // Banda 4 (Vermelho)
  bandNir: Float32Array,  // Banda 8 (NIR)
  bandSwir: Float32Array  // Banda 11 (SWIR)
): { ndvi: Float32Array, ndbi: Float32Array } {
  
  const totalPixels = bandRed.length;
  
  const ndviArray = new Float32Array(totalPixels);
  const ndbiArray = new Float32Array(totalPixels);

  for (let i = 0; i < totalPixels; i++) {
    const red = bandRed[i];
    const nir = bandNir[i];
    const swir = bandSwir[i];

    // 1. Cálculo do NDVI: Vegetação
    if (nir + red === 0) {
      ndviArray[i] = 0; 
    } else {
      ndviArray[i] = (nir - red) / (nir + red);
    }

    // 2. Cálculo do NDBI: Área Construída / Solo Exposto
    if (swir + nir === 0) {
      ndbiArray[i] = 0;
    } else {
      ndbiArray[i] = (swir - nir) / (swir + nir);
    }
  }

  return { ndvi: ndviArray, ndbi: ndbiArray };
}