// src/thermalProcessing.ts

export type ThermalInputMode = 'landsat-c2-st-b10' | 'celsius';

export type ThermalDecodeResult = {
  lstCelsius: Float32Array;
  validCount: number;
  min: number;
  max: number;
};

/**
 * Decodifica uma banda térmica real (Landsat Collection 2 Level-2 ST_B10)
 * e remove outliers radiométricos de borda de nuvem e falhas de emissividade ASTER GED.
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

  // 1ª Passagem: Decodificação física e corte de limites terrestres realistas
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

    // Filtra valores fisicamente impossíveis ou contaminação severa de nuvem alta (< 2°C ou > 62°C)
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

  // 2ª Passagem: Corte estatístico robusto (IQR / Percentis P1 a P99)
  // Elimina bordas frias de sombra/nuvem não pegas pelo QA_PIXEL e picos metálicos espúrios
  tempValues.sort((a, b) => a - b);
  const n = tempValues.length;
  const q25 = tempValues[Math.floor(n * 0.25)];
  const q75 = tempValues[Math.floor(n * 0.75)];
  const iqr = Math.max(1.5, q75 - q25);

  const p01 = tempValues[Math.floor(n * 0.01)];
  const p99 = tempValues[Math.floor(n * 0.99)];

  const lowerBound = Math.max(p01, q25 - 2.2 * iqr);
  const upperBound = Math.min(p99, q75 + 2.2 * iqr);

  let validCount = 0;
  let min = Infinity;
  let max = -Infinity;

  for (let i = 0; i < lstCelsius.length; i += 1) {
    const val = lstCelsius[i];
    if (!Number.isFinite(val)) continue;

    if (val < lowerBound - 1.5 || val > upperBound + 1.5) {
      // Descarta pixel anômalo de borda de nuvem para que o interpolador preencha suavemente
      lstCelsius[i] = NaN;
      continue;
    }

    const clamped = Math.max(lowerBound, Math.min(upperBound, val));
    lstCelsius[i] = clamped;
    validCount += 1;
    if (clamped < min) min = clamped;
    if (clamped > max) max = clamped;
  }

  if (validCount === 0) {
    throw new Error('Nenhum pixel térmico válido restou após filtragem de ruído.');
  }

  return { lstCelsius, validCount, min, max };
}
