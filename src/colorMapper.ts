// src/colorMapper.ts

export type PaletteType = 'ironbow' | 'spectral' | 'jet' | 'grayscale' | 'magma' | 'viridis' | 'coolwarm' | 'terrain' | 'custom' | 'uhi';

export function renderLstToCanvas(
  lstData: Float32Array, width: number, height: number, canvas: HTMLCanvasElement,
  palette: PaletteType = 'ironbow', customColors: string[] = ['#000080', '#0000ff', '#00ff00', '#ffff00', '#ff0000']
) {
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const imageData = ctx.createImageData(width, height);
  const data = imageData.data;
  let min = Infinity, max = -Infinity;
  let sum = 0, count = 0;

  for (let i = 0; i < lstData.length; i++) {
    const val = lstData[i];
    if (!isNaN(val) && isFinite(val)) {
      if (val < min) min = val;
      if (val > max) max = val;
      sum += val;
      count++;
    }
  }

  const range = max - min || 1;
  const mean = count > 0 ? sum / count : 0;

  // Cálculo do Desvio Padrão (σ) para o modo UHI
  let sumSqDiff = 0;
  for (let i = 0; i < lstData.length; i++) {
    const val = lstData[i];
    if (!isNaN(val) && isFinite(val)) {
      sumSqDiff += Math.pow(val - mean, 2);
    }
  }
  const stdDev = count > 0 ? Math.sqrt(sumSqDiff / count) : 1;

  const customRgb = customColors.map(hexToRgb);

  for (let i = 0; i < lstData.length; i++) {
    const val = lstData[i];
    const idx = i * 4;

    if (isNaN(val) || !isFinite(val)) { data[idx + 3] = 0; continue; }

    const normalized = Math.min(Math.max((val - min) / range, 0), 1);
    const color = getThermalColor(val, normalized, palette, customRgb, mean, stdDev);

    data[idx] = color.r; data[idx + 1] = color.g; data[idx + 2] = color.b; data[idx + 3] = 255;
  }
  ctx.putImageData(imageData, 0, 0);
  return { min, max, mean, stdDev };
}

function hexToRgb(hex: string) {
  const r = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return r ? { r: parseInt(r[1], 16), g: parseInt(r[2], 16), b: parseInt(r[3], 16) } : { r:0, g:0, b:0 };
}

function getThermalColor(rawVal: number, v: number, palette: PaletteType, customRgb: {r:number,g:number,b:number}[], mean: number, stdDev: number): { r: number; g: number; b: number } {
  // 📊 Modo UHI (Análise Estatística de Ilha de Calor por Desvio Padrão)
  if (palette === 'uhi') {
    if (rawVal < mean) return { r: 26, g: 150, b: 65 };                // Normal / Frio (Verde)
    if (rawVal < mean + 0.5 * stdDev) return { r: 254, g: 224, b: 139 }; // Ilha Leve (Amarelo)
    if (rawVal < mean + 1.5 * stdDev) return { r: 253, g: 141, b: 60 };  // Ilha Moderada (Laranja)
    return { r: 215, g: 25, b: 28 };                                    // Ilha Extrema (Vermelho)
  }

  if (palette === 'grayscale') {
    const cv = Math.round(v * 255); return { r: cv, g: cv, b: cv };
  }

  const stops = palette === 'spectral' ? [
    { p: 0.0, r: 94, g: 79, b: 162 }, { p: 0.2, r: 50, g: 136, b: 189 },
    { p: 0.4, r: 102, g: 194, b: 165 }, { p: 0.6, r: 253, g: 212, b: 134 },
    { p: 0.8, r: 244, g: 109, b: 67 }, { p: 1.0, r: 158, g: 1, b: 66 }
  ] : palette === 'jet' ? [
    { p: 0.0, r: 0, g: 0, b: 130 }, { p: 0.25, r: 0, g: 255, b: 255 },
    { p: 0.5, r: 0, g: 255, b: 0 }, { p: 0.75, r: 255, g: 255, b: 0 }, { p: 1.0, r: 255, g: 0, b: 0 }
  ] : palette === 'magma' ? [
    { p: 0.0, r: 0, g: 0, b: 4 }, { p: 0.2, r: 52, g: 15, b: 75 },
    { p: 0.4, r: 123, g: 32, b: 107 }, { p: 0.6, r: 202, g: 70, b: 74 },
    { p: 0.8, r: 251, g: 140, b: 60 }, { p: 1.0, r: 252, g: 253, b: 191 }
  ] : palette === 'viridis' ? [
    { p: 0.0, r: 68, g: 1, b: 84 }, { p: 0.25, r: 59, g: 82, b: 139 },
    { p: 0.5, r: 33, g: 145, b: 140 }, { p: 0.75, r: 94, g: 201, b: 98 }, { p: 1.0, r: 253, g: 231, b: 37 }
  ] : palette === 'coolwarm' ? [
    { p: 0.0, r: 59, g: 76, b: 192 }, { p: 0.5, r: 221, g: 221, b: 221 }, { p: 1.0, r: 180, g: 4, b: 38 }
  ] : palette === 'terrain' ? [
    { p: 0.0, r: 34, g: 94, b: 168 }, { p: 0.35, r: 83, g: 168, b: 93 }, { p: 0.65, r: 220, g: 190, b: 104 }, { p: 1.0, r: 139, g: 38, b: 31 }
  ] : palette === 'custom' ? customRgb.map((c, i) => ({ p: i / Math.max(customRgb.length - 1, 1), ...c }))
  : [
    { p: 0.0, r: 0, g: 0, b: 130 }, { p: 0.25, r: 120, g: 0, b: 120 },
    { p: 0.5, r: 204, g: 0, b: 0 }, { p: 0.75, r: 255, g: 204, b: 0 }, { p: 1.0, r: 255, g: 255, b: 255 }
  ];

  if (v <= 0) return stops[0];
  if (v >= 1) return stops[stops.length-1];

  for (let i = 0; i < stops.length - 1; i++) {
    if (v >= stops[i].p && v <= stops[i+1].p) {
      const t = (v - stops[i].p) / (stops[i+1].p - stops[i].p);
      return {
        r: Math.round(stops[i].r + t * (stops[i+1].r - stops[i].r)),
        g: Math.round(stops[i].g + t * (stops[i+1].g - stops[i].g)),
        b: Math.round(stops[i].b + t * (stops[i+1].b - stops[i].b))
      };
    }
  }
  return stops[0];
}

export function renderRGBBasemapToCanvas(
  band1: Float32Array, band2: Float32Array, band3: Float32Array, width: number, height: number, canvas: HTMLCanvasElement
) {
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d'); if (!ctx) return;
  const imageData = ctx.createImageData(width, height);
  const data = imageData.data;

  const stretch = (band: Float32Array) => {
    const samples: number[] = [];
    for (let i = 0; i < band.length; i += Math.max(1, Math.floor(band.length / 5000))) {
      if (Number.isFinite(band[i])) samples.push(band[i]);
    }
    if (!samples.length) return { min: 0, max: 1 };
    samples.sort((a, b) => a - b);
    const low = samples[Math.floor(samples.length * 0.02)];
    const high = samples[Math.floor(samples.length * 0.98)] || low + 1;
    return { min: low, max: high > low ? high : low + 1 };
  };
  const redStretch = stretch(band1); const greenStretch = stretch(band2); const blueStretch = stretch(band3);
  const scale = (value: number, limits: { min: number; max: number }) => Math.round(Math.min(Math.max((value - limits.min) / (limits.max - limits.min), 0), 1) * 255);

  for (let i = 0; i < band1.length; i++) {
    const idx = i * 4;
    if (band1[i] <= 0 || isNaN(band1[i])) { data[idx+3] = 0; continue; }
    data[idx] = scale(band1[i], redStretch);
    data[idx+1] = scale(band2[i], greenStretch);
    data[idx+2] = scale(band3[i], blueStretch);
    data[idx+3] = 255; 
  }
  ctx.putImageData(imageData, 0, 0);
}
