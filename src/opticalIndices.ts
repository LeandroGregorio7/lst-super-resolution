// Índices espectrais do SR2D4 em resolução fina.
export type OpticalIndices = { ndvi: Float32Array; ndbi: Float32Array; ndmi: Float32Array };

function normalizedDifference(a: number, b: number) {
  const denominator = a + b;
  return Math.abs(denominator) > 1e-8 ? (a - b) / denominator : NaN;
}

export function calculateOpticalIndices(
  bandRed: Float32Array,
  bandNir: Float32Array,
  bandSwir: Float32Array,
): OpticalIndices {
  if (bandRed.length !== bandNir.length || bandRed.length !== bandSwir.length) throw new Error('As bandas ópticas precisam ter a mesma grade.');
  const ndvi = new Float32Array(bandRed.length);
  const ndbi = new Float32Array(bandRed.length);
  const ndmi = new Float32Array(bandRed.length);
  for (let i = 0; i < bandRed.length; i += 1) {
    const red = bandRed[i];
    const nir = bandNir[i];
    const swir = bandSwir[i];
    ndvi[i] = normalizedDifference(nir, red);
    ndbi[i] = normalizedDifference(swir, nir);
    ndmi[i] = normalizedDifference(nir, swir);
  }
  return { ndvi, ndbi, ndmi };
}
