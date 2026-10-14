// Índices espectrais do SR2D4 em resolução fina.
// NDWI usa Green/NIR (McFeeters), não NIR/SWIR; este último par produz NDMI
// e é exatamente o oposto do NDBI quando ambas as fórmulas usam o mesmo SWIR.
export type OpticalIndices = {
  ndvi: Float32Array;
  ndbi: Float32Array;
  ndwi: Float32Array;
};

function normalizedDifference(a: number, b: number) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
  const denominator = a + b;
  return Math.abs(denominator) > 1e-8 ? (a - b) / denominator : NaN;
}

export function calculateOpticalIndices(
  bandRed: Float32Array,
  bandNir: Float32Array,
  bandSwir: Float32Array,
  bandGreen?: Float32Array,
): OpticalIndices {
  if (bandRed.length !== bandNir.length || bandRed.length !== bandSwir.length ||
      (bandGreen && bandRed.length !== bandGreen.length)) {
    throw new Error('As bandas ópticas precisam ter a mesma grade.');
  }
  const ndvi = new Float32Array(bandRed.length);
  const ndbi = new Float32Array(bandRed.length);
  const ndwi = new Float32Array(bandRed.length);
  for (let i = 0; i < bandRed.length; i += 1) {
    const red = bandRed[i];
    const nir = bandNir[i];
    const swir = bandSwir[i];
    ndvi[i] = normalizedDifference(nir, red);
    ndbi[i] = normalizedDifference(swir, nir);
    // If no confidently identified Green band is available, do not silently
    // relabel NDMI as NDWI: keep NDWI unavailable and let the model fall back.
    ndwi[i] = bandGreen ? normalizedDifference(bandGreen[i], nir) : NaN;
  }
  return { ndvi, ndbi, ndwi };
}
