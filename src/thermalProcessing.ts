// src/thermalProcessing.ts

export type ThermalInputMode = 'landsat-c2-st-b10' | 'celsius';

export type ThermalDecodeResult = {
  lstCelsius: Float32Array;
  validCount: number;
  min: number;
  max: number;
};

/**
 * Decodifica uma banda térmica real.
 *
 * Landsat Collection 2 Level-2 ST_B10 usa:
 *   ST[K] = DN * 0.00341802 + 149.0
 *
 * O resultado é convertido para °C. Não existe conversão fisicamente válida
 * de Red/NIR/SWIR para LST por normalização min-max; por isso este módulo
 * não aceita mais uma banda óptica como proxy térmica.
 */
export function decodeThermalInput(
  raw: Float32Array,
  mode: ThermalInputMode,
): ThermalDecodeResult {
  const lstCelsius = new Float32Array(raw.length);
  let validCount = 0;
  let min = Infinity;
  let max = -Infinity;

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

    // Faixa de controle ampla para superfície terrestre; evita propagar
    // fill values e valores impossíveis para a regressão/UHI.
    if (!Number.isFinite(value) || value < -80 || value > 100) {
      lstCelsius[i] = NaN;
      continue;
    }

    lstCelsius[i] = value;
    validCount += 1;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }

  if (validCount === 0) {
    throw new Error('Nenhum pixel térmico válido foi encontrado.');
  }

  return { lstCelsius, validCount, min, max };
}
