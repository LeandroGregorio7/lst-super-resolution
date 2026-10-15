// src/thermalProcessing.ts

export type ThermalInputMode = 'landsat-c2-st-b10' | 'celsius';

export type ThermalDecodeResult = {
  lstCelsius: Float32Array;
  validCount: number;
  min: number;
  max: number;
};

/**
 * Decodifica a banda térmica (Landsat Collection 2 Level-2 ST_B10)
 * com compressão radiométrica suave (Soft-Shoulder) nas caudas do histograma,
 * evitando platôs chapados ("borrões") nas zonas muito quentes ou muito frias.
 *
 * Escala oficial USGS:
 *   ST[K] = DN * 0.00341802 + 149.0
 *   LST[°C] = ST[K] - 273.15
 */
export function decodeThermalInput(
  raw: Float32Array,
  mode: ThermalInputMode,
): ThermalDecodeResult {
  const lstCelsius = new Float32Array(raw.length);
  const tempValues: number[] = [];

  // 1ª Passagem: Decodificação física e filtro de limites terrestres
  for (let i = 0; i < raw.length; i += 1) {
    const dn = raw[i];
    let value: number;

    if (!Number.isFinite(dn) || dn <= 0 || dn === 65535) {
      value = NaN;
    } else if (mode === 'landsat-c2-st-b10') {
      const kelvin = dn * 0.00341802 + 149.0;
      value = kelvin - 273.15;
    } else {
      value = dn;
    }

    if (!Number.isFinite(value) || value < 2 || value > 62) {
      lstCelsius[i] = NaN;
      continue;
    }

    lstCelsius[i] = value;
    tempValues.push(value);
  }

  if (tempValues.length === 0) {
    throw new Error('Nenhum pixel térmico válido foi encontrado.');
  }

  // 2ª Passagem: Estatística robusta (Mediana e IQR) e compressão Soft-Shoulder
  tempValues.sort((a, b) => a - b);
  const n = tempValues.length;
  const median = tempValues[Math.floor(n * 0.5)];
  const q25 = tempValues[Math.floor(n * 0.25)];
  const q75 = tempValues[Math.floor(n * 0.75)];
  const iqr = Math.max(1.2, q75 - q25);

  // Limite onde começa a compressão suave (preserva 100% da linearidade no miolo)
  const knee = 1.35 * iqr;
  //Teto máximo de compressão suave nas caudas (impede platô chapado)
  const tailSpan = 0.85 * iqr;
  // Corte de anomalias severas (borda de nuvem / erro grosseiro de emissividade)
  const hardOutlierCut = 2.8 * iqr;

  let validCount = 0;
  let min = Infinity;
  let max = -Infinity;

  for (let i = 0; i < lstCelsius.length; i += 1) {
    const val = lstCelsius[i];
    if (!Number.isFinite(val)) continue;

    const diff = val - median;
    const absDiff = Math.abs(diff);

    // Se for contaminação severa de nuvem/sombra, marca como NaN para o inpainting corrigir
    if (absDiff > hardOutlierCut) {
      lstCelsius[i] = NaN;
      continue;
    }

    // Se passar do joelho (knee), comprime suavemente via tanh sem achatar o gradiente interno
    let adjusted = val;
    if (absDiff > knee) {
      const sign = diff >= 0 ? 1 : -1;
      const excess = absDiff - knee;
      adjusted = median + sign * (knee + tailSpan * Math.tanh(excess / tailSpan));
    }

    lstCelsius[i] = adjusted;
    validCount += 1;
    if (adjusted < min) min = adjusted;
    if (adjusted > max) max = adjusted;
  }

  if (validCount === 0) {
    throw new Error('Nenhum pixel térmico válido restou após filtragem radiométrica.');
  }

  return { lstCelsius, validCount, min, max };
}
