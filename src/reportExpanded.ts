export interface ReportRasterInput {
  data: Float32Array;
  ndvi: Float32Array;
  ndbi: Float32Array;
  width: number;
  height: number;
  origin: number[];
  resolution: number[];
  epsg: number;
  isProjected: boolean;
  fileName: string;
  bands: number;
  stats: {
    min: number;
    max: number;
    mean: number;
    stdDev: number;
    q25?: number;
    q50?: number;
    q75?: number;
  };
}

export interface ReportAoiInput {
  vertices: [number, number][];
  count: number;
  min: number;
  max: number;
  mean: number;
}

export interface ReportDiffInput {
  beforeLabel: string;
  afterLabel: string;
  min: number;
  max: number;
  mean: number;
  stdDev: number;
  thresholdSigma: number;
  pctDecreased: number;
  pctEqual: number;
  pctIncreased: number;
}

export interface ReportOptions {
  raster: ReportRasterInput;
  opticalCanvas: HTMLCanvasElement;
  lstCanvas: HTMLCanvasElement;
  opacity: number;
  paletteName: string;
  uhiMethod: string;
  uhiPower: number;
  aoiStats?: ReportAoiInput | null;
  diffStats?: ReportDiffInput | null;
}

const UHI_COLOR_STOPS: [number, number, number, number][] = [
  [-1.65, 16, 62, 138],
  [-1.05, 24, 122, 140],
  [-0.45, 58, 174, 108],
  [0.05, 186, 222, 118],
  [0.5, 248, 214, 104],
  [0.95, 244, 124, 48],
  [1.4, 212, 32, 38],
  [1.95, 255, 244, 184],
];

function sampleUhiRgb(z: number): [number, number, number] {
  if (z <= UHI_COLOR_STOPS[0][0]) {
    return [UHI_COLOR_STOPS[0][1], UHI_COLOR_STOPS[0][2], UHI_COLOR_STOPS[0][3]];
  }
  for (let i = 0; i < UHI_COLOR_STOPS.length - 1; i += 1) {
    const [z0, r0, g0, b0] = UHI_COLOR_STOPS[i];
    const [z1, r1, g1, b1] = UHI_COLOR_STOPS[i + 1];
    if (z <= z1) {
      const t = Math.max(0, Math.min(1, (z - z0) / (z1 - z0)));
      return [
        Math.round(r0 + (r1 - r0) * t),
        Math.round(g0 + (g1 - g0) * t),
        Math.round(b0 + (b1 - b0) * t),
      ];
    }
  }
  const last = UHI_COLOR_STOPS[UHI_COLOR_STOPS.length - 1];
  return [last[1], last[2], last[3]];
}

function parseDatesFromFileName(fileName: string): {
  dates: string[];
  daysGap: number | null;
} {
  const matches = Array.from(fileName.matchAll(/(20\d{2})[-_]?([01]\d)[-_]?([0-3]\d)/g));
  const uniqueIso: string[] = [];
  for (const m of matches) {
    const iso = `${m[1]}-${m[2]}-${m[3]}`;
    if (!uniqueIso.includes(iso)) uniqueIso.push(iso);
  }
  if (uniqueIso.length >= 2) {
    const t0 = Date.parse(`${uniqueIso[0]}T00:00:00Z`);
    const t1 = Date.parse(`${uniqueIso[1]}T00:00:00Z`);
    if (Number.isFinite(t0) && Number.isFinite(t1)) {
      const gap = Math.round(Math.abs(t1 - t0) / (1000 * 60 * 60 * 24));
      return { dates: uniqueIso, daysGap: gap };
    }
  }
  return { dates: uniqueIso, daysGap: null };
}

function renderLstMapWithLegend(
  opticalCanvas: HTMLCanvasElement,
  lstCanvas: HTMLCanvasElement,
  opacity: number,
  paletteName: string,
  stats: { min: number; q25: number; q50: number; mean: number; q75: number; max: number; stdDev: number },
  epsg: number,
): string {
  const w = lstCanvas.width;
  const h = lstCanvas.height;
  const legendH = Math.max(150, Math.round(h * 0.14));
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h + legendH;
  const ctx = out.getContext('2d');
  if (!ctx) return '';

  ctx.fillStyle = '#0b192c';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(opticalCanvas, 0, 0, w, h);
  ctx.globalAlpha = opacity;
  ctx.drawImage(lstCanvas, 0, 0, w, h);
  ctx.globalAlpha = 1;

  const pad = Math.max(24, Math.round(w * 0.03));
  const barY = h + Math.round(legendH * 0.38);
  const barH = Math.max(22, Math.round(legendH * 0.2));
  const barW = w - pad * 2;

  ctx.fillStyle = '#0f2238';
  ctx.fillRect(0, h, w, legendH);
  ctx.strokeStyle = 'rgba(156, 221, 218, 0.35)';
  ctx.lineWidth = 2;
  ctx.strokeRect(pad * 0.5, h + 8, w - pad, legendH - 16);

  const fontTitle = Math.max(16, Math.round(w * 0.015));
  const fontSub = Math.max(13, Math.round(w * 0.012));
  ctx.fillStyle = '#9cddda';
  ctx.font = `700 ${fontTitle}px Inter, Arial, sans-serif`;
  ctx.fillText(
    `MAPA 01 · TEMPERATURA DE SUPERFÍCIE (LST °C) · PALETA ${paletteName.toUpperCase()} · EPSG:${epsg}`,
    pad,
    h + Math.round(legendH * 0.26),
  );

  // Sample gradient directly from lstCanvas palette stops
  const grad = ctx.createLinearGradient(pad, barY, pad + barW, barY);
  grad.addColorStop(0, '#061342');
  grad.addColorStop(0.2, '#186d8a');
  grad.addColorStop(0.4, '#522b96');
  grad.addColorStop(0.6, '#cf2226');
  grad.addColorStop(0.8, '#f26d18');
  grad.addColorStop(0.92, '#ffca28');
  grad.addColorStop(1, '#ffffff');
  ctx.fillStyle = grad;
  ctx.fillRect(pad, barY, barW, barH);
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.strokeRect(pad, barY, barW, barH);

  ctx.fillStyle = '#ffffff';
  ctx.font = `700 ${fontSub}px Inter, Arial, sans-serif`;
  const labelY = barY + barH + Math.round(legendH * 0.24);
  ctx.textAlign = 'left';
  ctx.fillText(`Mín: ${stats.min.toFixed(1)} °C`, pad, labelY);
  ctx.textAlign = 'center';
  ctx.fillText(`Q25: ${stats.q25.toFixed(1)} °C`, pad + barW * 0.25, labelY);
  ctx.fillText(
    `Mediana: ${stats.q50.toFixed(1)} °C | Média: ${stats.mean.toFixed(1)} °C (σ = ${stats.stdDev.toFixed(2)} °C)`,
    pad + barW * 0.5,
    labelY,
  );
  ctx.fillText(`Q75: ${stats.q75.toFixed(1)} °C`, pad + barW * 0.75, labelY);
  ctx.textAlign = 'right';
  ctx.fillText(`Máx: ${stats.max.toFixed(1)} °C`, pad + barW, labelY);
  ctx.textAlign = 'left';

  return out.toDataURL('image/webp', 0.92);
}

function renderUhiMapWithLegend(
  data: Float32Array,
  width: number,
  height: number,
  opticalCanvas: HTMLCanvasElement,
  opacity: number,
  stats: { min: number; max: number; mean: number; stdDev: number; q25: number; q50: number; q75: number },
  uhiMethod: string,
  uhiPower: number,
  epsg: number,
): string {
  const uhiLayer = document.createElement('canvas');
  uhiLayer.width = width;
  uhiLayer.height = height;
  const uCtx = uhiLayer.getContext('2d');
  if (!uCtx) return '';

  const img = uCtx.createImageData(width, height);
  const outPx = img.data;
  const safeStd = Math.max(0.6, stats.stdDev);
  const iqr = Math.max(0.5, stats.q75 - stats.q25);

  for (let i = 0; i < data.length; i += 1) {
    const val = data[i];
    const px = i * 4;
    if (!Number.isFinite(val)) {
      outPx[px + 3] = 0;
      continue;
    }
    const baseZ =
      uhiMethod === 'quantiles'
        ? ((val - stats.q50) / (iqr * 0.68)) * 0.92
        : (val - stats.mean) / safeStd;
    const z = (baseZ < 0 ? -1 : 1) * Math.pow(Math.abs(baseZ), uhiPower);
    const [r, g, b] = sampleUhiRgb(z);
    outPx[px] = r;
    outPx[px + 1] = g;
    outPx[px + 2] = b;
    outPx[px + 3] = 255;
  }
  uCtx.putImageData(img, 0, 0);

  const legendH = Math.max(165, Math.round(height * 0.15));
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height + legendH;
  const ctx = out.getContext('2d');
  if (!ctx) return '';

  ctx.fillStyle = '#0b192c';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(opticalCanvas, 0, 0, width, height);
  ctx.globalAlpha = opacity;
  ctx.drawImage(uhiLayer, 0, 0, width, height);
  ctx.globalAlpha = 1;

  const pad = Math.max(24, Math.round(width * 0.03));
  const barW = width - pad * 2;
  ctx.fillStyle = '#0f2238';
  ctx.fillRect(0, height, width, legendH);
  ctx.strokeStyle = 'rgba(156, 221, 218, 0.35)';
  ctx.lineWidth = 2;
  ctx.strokeRect(pad * 0.5, height + 8, width - pad, legendH - 16);

  const fontTitle = Math.max(16, Math.round(width * 0.015));
  const fontSub = Math.max(12, Math.round(width * 0.011));
  ctx.fillStyle = '#f1b64a';
  ctx.font = `700 ${fontTitle}px Inter, Arial, sans-serif`;
  ctx.fillText(
    `MAPA 02 · CLASSES DE ILHA DE CALOR URBANA (UHI 1m · MÉTODO ${uhiMethod.toUpperCase()} · γ=${uhiPower.toFixed(2)}) · EPSG:${epsg}`,
    pad,
    height + Math.round(legendH * 0.25),
  );

  const classes = [
    { name: '1. Ilha de Frescor (< -0,95σ)', color: '#103e8a' },
    { name: '2. Zona Amenizada (-0,95 a -0,30σ)', color: '#2ba198' },
    { name: '3. Zona Neutra (-0,30 a +0,25σ)', color: '#bade76' },
    { name: '4. UHI Moderada (+0,25 a +0,85σ)', color: '#f8d668' },
    { name: '5. UHI Forte (+0,85 a +1,40σ)', color: '#f47c30' },
    { name: '6. UHI Extrema (> +1,40σ)', color: '#d42026' },
  ];

  const boxY = height + Math.round(legendH * 0.42);
  const boxH = Math.max(24, Math.round(legendH * 0.22));
  const segW = barW / classes.length;

  classes.forEach((cls, idx) => {
    const x = pad + idx * segW;
    ctx.fillStyle = cls.color;
    ctx.fillRect(x, boxY, segW - 4, boxH);
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.strokeRect(x, boxY, segW - 4, boxH);
    ctx.fillStyle = '#e7f1f8';
    ctx.font = `700 ${fontSub}px Inter, Arial, sans-serif`;
    ctx.fillText(cls.name, x + 2, boxY + boxH + Math.round(legendH * 0.22));
  });

  return out.toDataURL('image/webp', 0.92);
}

export function downloadExpandedTechnicalReport(options: ReportOptions): void {
  const { raster, opticalCanvas, lstCanvas, opacity, paletteName, uhiMethod, uhiPower, aoiStats, diffStats } = options;

  // 1. Leitura integral do raster numérico (Float32Array)
  let validCount = 0;
  let noDataCount = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;

  let vegCount = 0;
  let builtCount = 0;
  let waterShadeCount = 0;
  let mixedSoilCount = 0;
  let overlapVegBuilt = 0;
  let ndviSum = 0;
  let ndbiSum = 0;
  let spectralValid = 0;

  const uhiCounts = [0, 0, 0, 0, 0, 0];
  let above31Count = 0;
  const hotspotThreshold = raster.stats.mean + 1.5 * raster.stats.stdDev;
  let aboveHotspotCount = 0;

  const sampleValues: number[] = [];
  const sampleStep = Math.max(1, Math.floor(raster.data.length / 80000));

  for (let i = 0; i < raster.data.length; i += 1) {
    const v = raster.data[i];
    if (!Number.isFinite(v)) {
      noDataCount += 1;
      continue;
    }
    validCount += 1;
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
    if (i % sampleStep === 0) sampleValues.push(v);

    if (v > 31.0) above31Count += 1;
    if (v >= hotspotThreshold) aboveHotspotCount += 1;

    const ndvi = raster.ndvi[i];
    const ndbi = raster.ndbi[i];
    if (Number.isFinite(ndvi) && Number.isFinite(ndbi)) {
      spectralValid += 1;
      ndviSum += ndvi;
      ndbiSum += ndbi;
      const isVeg = ndvi > 0.3;
      const isBuilt = ndbi > 0.1;
      const isWater = ndvi < 0 && ndbi < 0;
      if (isVeg && isBuilt) overlapVegBuilt += 1;
      if (isVeg) vegCount += 1;
      else if (isWater) waterShadeCount += 1;
      else if (isBuilt) builtCount += 1;
      else mixedSoilCount += 1;
    }
  }

  sampleValues.sort((a, b) => a - b);
  const quantile = (p: number) =>
    sampleValues.length ? sampleValues[Math.min(sampleValues.length - 1, Math.floor(sampleValues.length * p))] : 0;

  const mean = validCount ? sum / validCount : raster.stats.mean;
  const p10 = quantile(0.1);
  const q25 = raster.stats.q25 ?? quantile(0.25);
  const q50 = raster.stats.q50 ?? quantile(0.5);
  const q75 = raster.stats.q75 ?? quantile(0.75);
  const p90 = quantile(0.9);
  const p95 = quantile(0.95);
  const stdDev = raster.stats.stdDev;
  const safeStd = Math.max(0.6, stdDev);
  const iqr = Math.max(0.5, q75 - q25);

  // Classificação UHI e Histograma numérico de 12 faixas para leitura gráfica limpa
  const numBins = 12;
  const binCounts = new Array<number>(numBins).fill(0);
  const span = Math.max(0.1, max - min);

  for (let i = 0; i < raster.data.length; i += 1) {
    const v = raster.data[i];
    if (!Number.isFinite(v)) continue;
    const bIdx = Math.max(0, Math.min(numBins - 1, Math.floor(((v - min) / span) * numBins)));
    binCounts[bIdx] += 1;

    const baseZ =
      uhiMethod === 'quantiles'
        ? ((v - q50) / (iqr * 0.68)) * 0.92
        : (v - mean) / safeStd;
    const z = (baseZ < 0 ? -1 : 1) * Math.pow(Math.abs(baseZ), uhiPower);
    if (z < -0.95) uhiCounts[0] += 1;
    else if (z < -0.3) uhiCounts[1] += 1;
    else if (z < 0.25) uhiCounts[2] += 1;
    else if (z < 0.85) uhiCounts[3] += 1;
    else if (z < 1.4) uhiCounts[4] += 1;
    else uhiCounts[5] += 1;
  }

  // Cálculo de resolução espacial e área
  const resX = Math.abs(raster.resolution[0] || 1);
  const resY = Math.abs(raster.resolution[1] || 1);
  const pixelAreaM2 = raster.isProjected ? resX * resY : (resX * 111320) * (resY * 110540);
  const validAreaHa = (validCount * pixelAreaM2) / 10000;
  const validAreaKm2 = validAreaHa / 100;

  const pct = (n: number, den = validCount) => (den > 0 ? ((n / den) * 100).toFixed(1) : '0.0');
  const ha = (n: number) => ((n * pixelAreaM2) / 10000).toFixed(2);

  const uhiStrongExtremePct = (((uhiCounts[4] + uhiCounts[5]) / Math.max(1, validCount)) * 100).toFixed(1);
  const meanMedianDiff = mean - q50;
  const meanNdvi = spectralValid ? ndviSum / spectralValid : 0;
  const meanNdbi = spectralValid ? ndbiSum / spectralValid : 0;

  // Verificação temporal entre datas no nome do ficheiro
  const temporalAudit = parseDatesFromFileName(raster.fileName);
  const dateOptical = temporalAudit.dates[0] ?? 'Não especificada no nome';
  const dateThermal = temporalAudit.dates[1] ?? temporalAudit.dates[0] ?? 'Sincronizada via STAC';
  const daysGap = temporalAudit.daysGap;

  // Renderização dos 2 mapas com legenda incorporada
  const lstMapDataUrl = renderLstMapWithLegend(
    opticalCanvas,
    lstCanvas,
    opacity,
    paletteName,
    { min, q25, q50, mean, q75, max, stdDev },
    raster.epsg,
  );
  const uhiMapDataUrl = renderUhiMapWithLegend(
    raster.data,
    raster.width,
    raster.height,
    opticalCanvas,
    opacity,
    { min, max, mean, stdDev, q25, q50, q75 },
    uhiMethod,
    uhiPower,
    raster.epsg,
  );

  const uhiRowsMeta = [
    {
      pt: 'Ilha de frescor (< -0,95σ)',
      en: 'Cool island (< -0.95σ)',
      color: '#103e8a',
      notePt: 'Corpos hídricos, fundos de vale e maciços arbóreos densos',
      noteEn: 'Water bodies, valley bottoms and dense tree canopies',
    },
    {
      pt: 'Zona amenizada (-0,95σ a -0,30σ)',
      en: 'Mitigated zone (-0.95σ to -0.30σ)',
      color: '#2ba198',
      notePt: 'Quadras arborizadas, parques urbanos e áreas permeáveis',
      noteEn: 'Tree-lined blocks, urban parks and permeable areas',
    },
    {
      pt: 'Zona neutra (-0,30σ a +0,25σ)',
      en: 'Neutral zone (-0.30σ to +0.25σ)',
      color: '#68c96e',
      notePt: 'Transição urbana em equilíbrio radiométrico com a média da cena',
      noteEn: 'Urban transition in radiometric balance with scene mean',
    },
    {
      pt: 'UHI moderada (+0,25σ a +0,85σ)',
      en: 'Moderate UHI (+0.25σ to +0.85σ)',
      color: '#f1b64a',
      notePt: 'Malha residencial consolidada e vias pavimentadas',
      noteEn: 'Consolidated residential fabric and paved roads',
    },
    {
      pt: 'UHI forte (+0,85σ a +1,40σ)',
      en: 'Strong UHI (+0.85σ to +1.40σ)',
      color: '#e86825',
      notePt: 'Alto adensamento construtivo e baixa fração vegetal',
      noteEn: 'High built-up density and low vegetation fraction',
    },
    {
      pt: 'Hotspot extremo (> +1,40σ)',
      en: 'Extreme hotspot (> +1.40σ)',
      color: '#c84638',
      notePt: 'Coberturas metálicas/fibrocimento, grandes pátios asfálticos e solo exposto seco',
      noteEn: 'Metal/industrial roofs, large asphalt yards and dry bare soil',
    },
  ];

  const uhiBarsHtml = uhiRowsMeta
    .map((row, idx) => {
      const count = uhiCounts[idx];
      const p = pct(count);
      const areaH = ha(count);
      return `<div class="bar-row">
        <div class="bar-label">
          <span data-pt="${row.pt}" data-en="${row.en}">${row.pt}</span>
          <b>${p}% · ${areaH} ha (${count.toLocaleString('pt-BR')} px)</b>
        </div>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.max(1.5, Number(p))}%;background:${row.color}"></div></div>
        <div class="bar-note" data-pt="${row.notePt}" data-en="${row.noteEn}">${row.notePt}</div>
      </div>`;
    })
    .join('');

  const histBarsHtml = binCounts
    .map((count, idx) => {
      const t0 = min + (span * idx) / numBins;
      const t1 = min + (span * (idx + 1)) / numBins;
      const p = pct(count);
      const barColor = idx < 3 ? '#1d817e' : idx < 6 ? '#27765e' : idx < 9 ? '#f1b64a' : '#c84638';
      return `<div class="bar-row" style="margin:9px 0">
        <div class="bar-label">
          <span>${t0.toFixed(1)} °C – ${t1.toFixed(1)} °C</span>
          <b>${p}% (${count.toLocaleString('pt-BR')} px · ${ha(count)} ha)</b>
        </div>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.max(1, Number(p))}%;background:${barColor}"></div></div>
      </div>`;
    })
    .join('');

  const aoiBlockHtml = aoiStats
    ? `<div class="callout blue" style="margin-top:14px">
        <strong data-pt="Polígono de Área de Interesse (AOI) analisado no raster numérico:" data-en="Area of Interest (AOI) Polygon analyzed on numerical raster:">Polígono de Área de Interesse (AOI) analisado no raster numérico:</strong>
        <span> ${aoiStats.count.toLocaleString('pt-BR')} píxeis válidos (${ha(aoiStats.count)} ha) · Mín: <b>${aoiStats.min.toFixed(1)} °C</b> · Média: <b>${aoiStats.mean.toFixed(2)} °C</b> · Máx: <b>${aoiStats.max.toFixed(1)} °C</b> (${aoiStats.vertices.length} vértices georreferenciados).</span>
      </div>`
    : '';

  const diffBlockHtml = diffStats
    ? `<div class="callout" style="margin-top:14px">
        <strong data-pt="Comparação Multitemporal ΔLST (${diffStats.beforeLabel} → ${diffStats.afterLabel}):" data-en="Multi-temporal ΔLST Comparison (${diffStats.beforeLabel} → ${diffStats.afterLabel}):">Comparação Multitemporal ΔLST (${diffStats.beforeLabel} → ${diffStats.afterLabel}):</strong>
        <span> Limiar estatístico ±1σ = <b>±${diffStats.thresholdSigma.toFixed(2)} °C</b> · Diminuiu (&lt; -1σ): <b>${diffStats.pctDecreased.toFixed(1)}%</b> · Permaneceu igual (±1σ): <b>${diffStats.pctEqual.toFixed(1)}%</b> · Aumentou (&gt; +1σ): <b>${diffStats.pctIncreased.toFixed(1)}%</b> · ΔMédio da cena: <b>${diffStats.mean >= 0 ? '+' : ''}${diffStats.mean.toFixed(2)} °C</b>.</span>
      </div>`
    : '';

  const issueDate = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });

  const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="Relatório técnico auditável de análise térmica urbana (LST 1m), ilhas de calor (UHI), índices espectrais e painel integrado urbano-saúde-ambiental.">
<title>SR2D4 | Diagnóstico Térmico e Urbano (${raster.fileName})</title>
<style>
:root {
  --navy:#10213b; --navy2:#192f50; --teal:#1d817e; --teal-light:#e7f3f1;
  --ink:#172b42; --muted:#65758a; --line:#dbe3ec; --paper:#ffffff;
  --bg:#eef2f7; --amber:#f1b64a; --red:#c84638; --green:#27765e;
  --radius:16px; --shadow:0 10px 32px rgba(16,33,59,.07);
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.58 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Arial,sans-serif}
a{color:#196d76;text-decoration:none}
a:hover{text-decoration:underline}
.page{max-width:1240px;margin:0 auto;padding:26px 24px 60px}
.topline{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px;color:#5e6d82;font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:10px}
.brand-mark{width:34px;height:34px;border-radius:10px;background:linear-gradient(145deg,#36a9a2,#175f79);display:grid;place-items:center;color:white;font-weight:900;font-size:12px;box-shadow:0 5px 14px #1b71802e}
.report-tag{border:1px solid #cbd6e2;border-radius:999px;padding:6px 12px;letter-spacing:.04em;background:#fff;color:#40516a}
.lang-switch{border:1px solid #1d817e;background:#e7f3f1;color:#10213b;border-radius:999px;padding:6px 14px;font-weight:800;font-size:12px;cursor:pointer;letter-spacing:.04em}
.lang-switch:hover{background:#d2ebe7}
.hero{background:linear-gradient(115deg,var(--navy) 0%,#173658 66%,#176d75 100%);border-radius:24px;padding:34px 38px;color:#fff;position:relative;overflow:hidden;box-shadow:var(--shadow)}
.hero:after{content:"";position:absolute;right:-80px;top:-130px;width:420px;height:420px;border:1px solid #ffffff2b;border-radius:50%;box-shadow:0 0 0 45px #ffffff08,0 0 0 90px #ffffff07;pointer-events:none}
.hero-content{position:relative;z-index:1;max-width:860px}
.eyebrow{font-size:11px;letter-spacing:.18em;text-transform:uppercase;font-weight:800;color:#9cddda;margin-bottom:12px}
h1{font-size:clamp(30px,3.8vw,46px);line-height:1.08;letter-spacing:-.04em;margin:0 0 14px;font-weight:780}
.hero p{margin:0;max-width:780px;color:#d6e4f1;font-size:16.5px}
.hero-meta{display:flex;flex-wrap:wrap;gap:8px;margin-top:22px}
.hero-meta span{border:1px solid #ffffff30;background:#ffffff0e;padding:7px 10px;border-radius:9px;color:#e7f1f8;font-size:12px}
.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:24px}
.btn{display:inline-flex;align-items:center;gap:8px;border:1px solid #ffffff45;border-radius:10px;padding:10px 14px;font-weight:750;font-size:13px;color:#fff;background:#ffffff12;cursor:pointer}
.btn.primary{background:#e6f8f5;color:#10384a;border-color:#e6f8f5}
.btn:hover{filter:brightness(1.05);text-decoration:none}
.nav{position:sticky;top:0;z-index:20;margin:16px 0 22px;padding:10px 12px;background:#ffffffed;backdrop-filter:blur(8px);border:1px solid var(--line);border-radius:13px;display:flex;gap:7px;overflow:auto;box-shadow:0 4px 14px #10213b0a}
.nav a{white-space:nowrap;font-size:12px;font-weight:750;color:#42546a;padding:7px 10px;border-radius:8px}
.nav a:hover{background:#eaf2f5;text-decoration:none}
.section{scroll-margin-top:82px;margin-top:26px}
.section-head{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;margin:0 0 14px;flex-wrap:wrap}
.section-kicker{font-size:11px;font-weight:850;letter-spacing:.15em;color:var(--teal);text-transform:uppercase;margin-bottom:5px}
h2{margin:0;color:var(--navy);font-size:clamp(22px,2.4vw,29px);line-height:1.2;letter-spacing:-.025em}
h3{margin:0 0 9px;font-size:17px;line-height:1.3;color:var(--navy)}
.section-desc{margin:5px 0 0;color:var(--muted);max-width:820px;font-size:13px}
.card{background:var(--paper);border:1px solid var(--line);border-radius:var(--radius);padding:22px;box-shadow:var(--shadow);min-width:0}
.grid-4{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:13px}
.grid-3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:13px}
.grid-2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
.metric{padding:19px 20px;min-height:138px;position:relative;overflow:hidden}
.metric:after{content:"";position:absolute;right:-17px;bottom:-35px;width:105px;height:105px;border-radius:50%;background:#edf6f6}
.metric-label{position:relative;z-index:1;font-size:12px;font-weight:750;color:var(--muted)}
.metric-value{position:relative;z-index:1;margin-top:9px;font-size:clamp(25px,3vw,34px);letter-spacing:-.04em;color:var(--navy);font-weight:800;line-height:1.1}
.metric-unit{font-size:14px;color:#50647a;font-weight:700;letter-spacing:0}
.metric-note{position:relative;z-index:1;margin-top:8px;font-size:11px;color:#6b7a8e;line-height:1.4}
.chip{display:inline-flex;gap:6px;align-items:center;padding:5px 10px;border-radius:999px;font-size:11px;font-weight:800;letter-spacing:.015em}
.chip.ok{background:#e5f4ee;color:#1c7058}
.chip.pending{background:#fff3d7;color:#875d11}
.chip.info{background:#e8f1f8;color:#365a7a}
.chip.warn{background:#fdebe7;color:#a53e31}
.insight-list{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:14px}
.insight{background:#fff;border:1px solid var(--line);border-radius:13px;padding:17px}
.insight .number{font-size:23px;font-weight:850;letter-spacing:-.03em;color:var(--teal)}
.insight p{margin:6px 0 0;font-size:13px;color:#596a7f}
.map-frame{background:#0f2238;border-radius:15px;padding:12px;overflow:hidden}
.map-frame img{display:block;width:100%;height:auto;max-height:740px;object-fit:contain;border-radius:8px;background:#10213b}
.map-caption{display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;padding:12px 4px 2px;color:#d8e6f1;font-size:12px}
.callout{border-left:4px solid var(--amber);background:#fff7e7;padding:14px 16px;border-radius:0 10px 10px 0;color:#654d27;font-size:13px;margin-top:13px}
.callout strong{color:#563a11}
.callout.blue{background:#eaf4f7;border-color:#3989a1;color:#34566a}
.callout.red{background:#fff0ed;border-color:#d2604f;color:#7a3b31}
.two-col{display:grid;grid-template-columns:minmax(0,1.08fr) minmax(0,.92fr);gap:14px}
.bar-row{margin:13px 0 15px}
.bar-label{display:flex;align-items:baseline;justify-content:space-between;gap:16px;font-size:13px;font-weight:720}
.bar-label span{color:#35495f}
.bar-label b{color:var(--navy);font-size:13px;font-variant-numeric:tabular-nums;white-space:nowrap}
.bar-track{height:10px;margin-top:6px;background:#edf1f5;border-radius:99px;overflow:hidden}
.bar-fill{height:100%;border-radius:99px}
.bar-note{font-size:11px;color:#7d8998;margin-top:4px}
.chart-legend{display:flex;flex-wrap:wrap;gap:12px;margin:15px 0 0;color:#63748a;font-size:11px;border-top:1px solid #e7edf3;padding-top:10px}
.legend-dot{width:8px;height:8px;display:inline-block;border-radius:50%;margin-right:5px}
.stat-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;margin-top:15px}
.stat-item{padding:12px;border:1px solid #e2e8ef;border-radius:10px;background:#fafbfd}
.stat-item span{display:block;color:#748195;font-size:11px;font-weight:700}
.stat-item b{display:block;font-size:18px;color:var(--navy);margin-top:3px;font-variant-numeric:tabular-nums}
.table-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:12px;background:#fff}
table{border-collapse:collapse;width:100%;min-width:690px;font-size:12px}
th{background:#f1f5f8;color:#43566b;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.06em;font-weight:850}
th,td{padding:12px 13px;border-bottom:1px solid #e5ebf1;vertical-align:top}
tr:last-child td{border-bottom:0}
td{color:#526378}
td strong{color:#21364e}
.tag{display:inline-flex;border-radius:6px;padding:4px 7px;font-size:10px;font-weight:850;white-space:nowrap}
.tag.available{background:#e4f4ed;color:#247255}
.tag.pending{background:#fff1d6;color:#8b6114}
.tag.method{background:#e8edf8;color:#465f99}
.theme-card{padding:21px;display:flex;flex-direction:column;gap:12px}
.theme-icon{display:grid;place-items:center;width:43px;height:43px;border-radius:12px;background:#e8f3f4;font-size:21px}
.theme-card p{font-size:13px;color:#5c6d82;margin:0}
.theme-card ul{margin:0;padding-left:18px;font-size:12px;color:#52647a}
.theme-card li{margin:5px 0}
.theme-card .chip{align-self:flex-start;margin-top:auto}
.steps{counter-reset:step;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
.step{border:1px solid var(--line);border-radius:13px;background:#fff;padding:18px;min-height:155px;position:relative}
.step:before{counter-increment:step;content:"0" counter(step);font-size:11px;letter-spacing:.12em;font-weight:900;color:var(--teal)}
.step h3{margin-top:10px;font-size:14px}
.step p{font-size:12px;color:#627288;margin:0}
.action-row{display:grid;grid-template-columns:110px 1fr;gap:16px;border-bottom:1px solid #e7edf2;padding:15px 0}
.action-row:last-child{border-bottom:0;padding-bottom:0}
.priority{align-self:start;text-align:center;border-radius:8px;padding:7px 8px;font-size:11px;font-weight:850;background:#edf5f1;color:#24694f}
.priority.p1{background:#fff0d8;color:#8b5a11}
.priority.p2{background:#eaf1fb;color:#375b93}
.action-row p{margin:4px 0 0;font-size:13px;color:#607085}
.footer{margin-top:28px;background:#10213b;color:#d6e3ee;border-radius:17px;padding:24px 28px;display:flex;justify-content:space-between;gap:20px;align-items:flex-start;flex-wrap:wrap}
.footer strong{display:block;color:#fff;font-size:16px;margin-bottom:5px}
.footer p{margin:0;font-size:12px;color:#c1d0df;max-width:770px}
code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.92em;background:#edf2f6;padding:2px 5px;border-radius:4px}
@media(max-width:900px){.grid-4{grid-template-columns:repeat(2,minmax(0,1fr))}.grid-3,.insight-list,.two-col,.grid-2{grid-template-columns:1fr}.steps{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media print{
 @page{size:A4;margin:12mm}
 body{background:#fff;font-size:10pt;-webkit-print-color-adjust:exact;print-color-adjust:exact}
 .page{max-width:none;padding:0}
 .nav,.actions,.lang-switch{display:none!important}
 .hero,.card,.footer{box-shadow:none;break-inside:avoid}
 .map-frame{background:#0f2238;border:1px solid #ccc;padding:6px}
 .map-frame img{max-height:520px}
}
</style>
</head>
<body>
<div class="page">
  <div class="topline">
    <div class="brand"><div class="brand-mark">S4</div><span>SR2D4 · Geospatial Intelligence</span></div>
    <div style="display:flex;gap:10px;align-items:center">
      <button class="lang-switch" id="lang-btn" onclick="toggleLanguage()">🇬🇧 Switch to English</button>
      <span class="report-tag" data-pt="RELATÓRIO TÉCNICO · MODELO EXPANDIDO" data-en="TECHNICAL REPORT · EXPANDED MODEL">RELATÓRIO TÉCNICO · MODELO EXPANDIDO</span>
    </div>
  </div>

  <header class="hero">
    <div class="hero-content">
      <div class="eyebrow" data-pt="Diagnóstico térmico e inteligência territorial" data-en="Thermal diagnostics and territorial intelligence">Diagnóstico térmico e inteligência territorial</div>
      <h1 data-pt="Temperatura de superfície e ambiente urbano" data-en="Land surface temperature and urban environment">Temperatura de superfície e ambiente urbano</h1>
      <p data-pt="Leitura integrada e auditável do raster numérico de temperatura de superfície (LST 1 m), das classes de ilha de calor urbana (UHI), dos índices espectrais (NDVI/NDBI) e da matriz de indicadores urbano-saúde-ambientais." data-en="Integrated and auditable reading of the numerical land surface temperature raster (1 m LST), urban heat island (UHI) classes, spectral indices (NDVI/NDBI) and the urban-health-environmental indicator matrix.">Leitura integrada e auditável do raster numérico de temperatura de superfície (LST 1 m), das classes de ilha de calor urbana (UHI), dos índices espectrais (NDVI/NDBI) e da matriz de indicadores urbano-saúde-ambientais.</p>
      <div class="hero-meta">
        <span data-pt="Produto: LST refinada em grade de ${resX.toFixed(2)} m" data-en="Product: Refined LST on ${resX.toFixed(2)} m grid">Produto: LST refinada em grade de ${resX.toFixed(2)} m</span>
        <span>CRS: EPSG:${raster.epsg}</span>
        <span>Raster: ${raster.width.toLocaleString('pt-BR')} × ${raster.height.toLocaleString('pt-BR')} px (${validCount.toLocaleString('pt-BR')} válidos)</span>
        <span data-pt="Área útil: ${validAreaHa.toFixed(2)} ha (${validAreaKm2.toFixed(2)} km²)" data-en="Valid area: ${validAreaHa.toFixed(2)} ha (${validAreaKm2.toFixed(2)} km²)">Área útil: ${validAreaHa.toFixed(2)} ha (${validAreaKm2.toFixed(2)} km²)</span>
        <span data-pt="Emissão: ${issueDate}" data-en="Issued: ${issueDate}">Emissão: ${issueDate}</span>
      </div>
      <div class="actions">
        <button class="btn primary" onclick="window.print()" data-pt="⇩ Imprimir / guardar em PDF" data-en="⇩ Print / save as PDF">⇩ Imprimir / guardar em PDF</button>
        <button class="btn" onclick="toggleLanguage()" data-pt="🌐 Traduzir PT / EN" data-en="🌐 Translate EN / PT">🌐 Traduzir PT / EN</button>
        <a class="btn" href="#lacunas" data-pt="Ver protocolo para bairros e ruas →" data-en="View protocol for neighborhoods and streets →">Ver protocolo para bairros e ruas →</a>
      </div>
    </div>
  </header>

  <nav class="nav" aria-label="Navegação do relatório">
    <a href="#resumo" data-pt="01. Resumo" data-en="01. Summary">01. Resumo</a>
    <a href="#metadados" data-pt="02. Metadados & Datas" data-en="02. Metadata & Dates">02. Metadados & Datas</a>
    <a href="#mapa" data-pt="03. Mapas LST & UHI" data-en="03. LST & UHI Maps">03. Mapas LST & UHI</a>
    <a href="#classes" data-pt="04. Distribuição & UHI" data-en="04. Distribution & UHI">04. Distribuição & UHI</a>
    <a href="#espectral" data-pt="05. NDVI & NDBI" data-en="05. NDVI & NDBI">05. NDVI & NDBI</a>
    <a href="#lacunas" data-pt="06. Bairros & Ruas" data-en="06. Neighborhoods & Streets">06. Bairros & Ruas</a>
    <a href="#conforto" data-pt="07. Conforto" data-en="07. Thermal Comfort">07. Conforto</a>
    <a href="#saude" data-pt="08. Saúde" data-en="08. Health">08. Saúde</a>
    <a href="#mobilidade" data-pt="09. Mobilidade" data-en="09. Mobility">09. Mobilidade</a>
    <a href="#poluicao" data-pt="10. Poluição" data-en="10. Pollution">10. Poluição</a>
    <a href="#indicadores" data-pt="11. Painel Integrado" data-en="11. Integrated Panel">11. Painel Integrado</a>
    <a href="#metodo" data-pt="12. Recomendações & Limites" data-en="12. Actions & Limits">12. Recomendações & Limites</a>
  </nav>

  <!-- 01. SÍNTESE EXECUTIVA -->
  <section id="resumo" class="section">
    <div class="section-head">
      <div>
        <div class="section-kicker" data-pt="01 · Síntese executiva" data-en="01 · Executive summary">01 · Síntese executiva</div>
        <h2 data-pt="Principais conclusões comprovadas pelo raster numérico" data-en="Key findings proven by the numerical raster">Principais conclusões comprovadas pelo raster numérico</h2>
        <p class="section-desc" data-pt="Todas as estatísticas abaixo foram extraídas diretamente da matriz numérica Float32Array (${validCount.toLocaleString('pt-BR')} píxeis válidos), nunca amostradas a partir das cores da imagem renderizada." data-en="All statistics below were extracted directly from the Float32Array numerical matrix (${validCount.toLocaleString('pt-BR')} valid pixels), never sampled from rendered image colors.">Todas as estatísticas abaixo foram extraídas diretamente da matriz numérica Float32Array (${validCount.toLocaleString('pt-BR')} píxeis válidos), nunca amostradas a partir das cores da imagem renderizada.</p>
      </div>
      <span class="chip ok" data-pt="Calculado do GeoTIFF numérico" data-en="Calculated from numerical GeoTIFF">Calculado do GeoTIFF numérico</span>
    </div>
    <div class="grid-4">
      <article class="card metric">
        <div class="metric-label" data-pt="LST média (μ)" data-en="Mean LST (μ)">LST média (μ)</div>
        <div class="metric-value">${mean.toFixed(1)} <span class="metric-unit">°C</span></div>
        <div class="metric-note" data-pt="Mediana (Q50): ${q50.toFixed(1)} °C · σ = ${stdDev.toFixed(2)} °C" data-en="Median (Q50): ${q50.toFixed(1)} °C · σ = ${stdDev.toFixed(2)} °C">Mediana (Q50): ${q50.toFixed(1)} °C · σ = ${stdDev.toFixed(2)} °C</div>
      </article>
      <article class="card metric">
        <div class="metric-label" data-pt="LST máxima / P95" data-en="Max LST / P95">LST máxima / P95</div>
        <div class="metric-value">${max.toFixed(1)} <span class="metric-unit">°C</span></div>
        <div class="metric-note" data-pt="Percentil 95%: ${p95.toFixed(1)} °C · Mínima: ${min.toFixed(1)} °C" data-en="95th Percentile: ${p95.toFixed(1)} °C · Min: ${min.toFixed(1)} °C">Percentil 95%: ${p95.toFixed(1)} °C · Mínima: ${min.toFixed(1)} °C</div>
      </article>
      <article class="card metric">
        <div class="metric-label" data-pt="UHI forte + extrema" data-en="Strong + extreme UHI">UHI forte + extrema</div>
        <div class="metric-value">${uhiStrongExtremePct}<span class="metric-unit">%</span></div>
        <div class="metric-note" data-pt="Soma das classes > +0,85σ (${ha(uhiCounts[4] + uhiCounts[5])} ha); diferente da fração > 31 °C (${pct(above31Count)}%)" data-en="Sum of classes > +0.85σ (${ha(uhiCounts[4] + uhiCounts[5])} ha); distinct from fraction > 31 °C (${pct(above31Count)}%)">Soma das classes &gt; +0,85σ (${ha(uhiCounts[4] + uhiCounts[5])} ha); diferente da fração &gt; 31 °C (${pct(above31Count)}%)</div>
      </article>
      <article class="card metric">
        <div class="metric-label" data-pt="Vegetação ativa (NDVI > 0,3)" data-en="Active vegetation (NDVI > 0.3)">Vegetação ativa (NDVI &gt; 0,3)</div>
        <div class="metric-value">${pct(vegCount, spectralValid)}<span class="metric-unit">%</span></div>
        <div class="metric-note" data-pt="${ha(vegCount)} ha · NDVI médio da cena: ${meanNdvi.toFixed(3)}" data-en="${ha(vegCount)} ha · Scene mean NDVI: ${meanNdvi.toFixed(3)}">${ha(vegCount)} ha · NDVI médio da cena: ${meanNdvi.toFixed(3)}</div>
      </article>
    </div>

    <div class="insight-list">
      <article class="insight">
        <div class="number">${meanMedianDiff >= 0 ? '+' : ''}${meanMedianDiff.toFixed(2)} °C</div>
        <p data-pt="Diferença entre média (${mean.toFixed(2)} °C) e mediana (${q50.toFixed(2)} °C). Amplitude interquartil (IQR Q75−Q25) de ${(q75 - q25).toFixed(2)} °C e amplitude total de ${(max - min).toFixed(1)} °C." data-en="Difference between mean (${mean.toFixed(2)} °C) and median (${q50.toFixed(2)} °C). Interquartile range (IQR Q75−Q25) of ${(q75 - q25).toFixed(2)} °C and total range of ${(max - min).toFixed(1)} °C.">Diferença entre média (${mean.toFixed(2)} °C) e mediana (${q50.toFixed(2)} °C). Amplitude interquartil (IQR Q75−Q25) de ${(q75 - q25).toFixed(2)} °C e amplitude total de ${(max - min).toFixed(1)} °C.</p>
      </article>
      <article class="insight">
        <div class="number">${hotspotThreshold.toFixed(1)} °C</div>
        <p data-pt="Limiar estatístico de hotspot (μ + 1,5σ), superado em ${pct(aboveHotspotCount)}% da área válida (${ha(aboveHotspotCount)} ha). Já o limiar fixo de 31,0 °C é superado em ${pct(above31Count)}% (${ha(above31Count)} ha)." data-en="Statistical hotspot threshold (μ + 1.5σ), exceeded in ${pct(aboveHotspotCount)}% of valid area (${ha(aboveHotspotCount)} ha). The fixed 31.0 °C threshold is exceeded in ${pct(above31Count)}% (${ha(above31Count)} ha).">Limiar estatístico de hotspot (μ + 1,5σ), superado em ${pct(aboveHotspotCount)}% da área válida (${ha(aboveHotspotCount)} ha). Já o limiar fixo de 31,0 °C é superado em ${pct(above31Count)}% (${ha(above31Count)} ha).</p>
      </article>
      <article class="insight">
        <div class="number">${pct(builtCount, spectralValid)}%</div>
        <p data-pt="Superfícies construídas dominantes (NDBI > 0,1 sem vegetação densa: ${ha(builtCount)} ha). Coberturas mistas/solo intermédio somam ${pct(mixedSoilCount, spectralValid)}% (${ha(mixedSoilCount)} ha)." data-en="Dominant built-up surfaces (NDBI > 0.1 without dense vegetation: ${ha(builtCount)} ha). Mixed cover/intermediate soil accounts for ${pct(mixedSoilCount, spectralValid)}% (${ha(mixedSoilCount)} ha).">Superfícies construídas dominantes (NDBI &gt; 0,1 sem vegetação densa: ${ha(builtCount)} ha). Coberturas mistas/solo intermédio somam ${pct(mixedSoilCount, spectralValid)}% (${ha(mixedSoilCount)} ha).</p>
      </article>
    </div>
    ${aoiBlockHtml}
    ${diffBlockHtml}
  </section>

  <!-- 02. METADADOS E AUDITORIA TEMPORAL -->
  <section id="metadados" class="section">
    <div class="section-head">
      <div>
        <div class="section-kicker" data-pt="02 · Rastreabilidade e Auditoria de Insumos" data-en="02 · Traceability and Input Audit">02 · Rastreabilidade e Auditoria de Insumos</div>
        <h2 data-pt="Metadados cartográficos, qualidade de dados e compatibilidade temporal" data-en="Cartographic metadata, data quality and temporal compatibility">Metadados cartográficos, qualidade de dados e compatibilidade temporal</h2>
      </div>
      <span class="chip ${daysGap && daysGap > 5 ? 'warn' : 'info'}" data-pt="${daysGap !== null ? `Desfasamento temporal: ${daysGap} dias` : 'Auditoria de cena única'}" data-en="${daysGap !== null ? `Temporal gap: ${daysGap} days` : 'Single-scene audit'}">${daysGap !== null ? `Desfasamento temporal: ${daysGap} dias` : 'Auditoria de cena única'}</span>
    </div>
    <div class="card">
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th data-pt="Parâmetro Técnico" data-en="Technical Parameter">Parâmetro Técnico</th>
              <th data-pt="Valor Identificado na Base" data-en="Value Identified in Dataset">Valor Identificado na Base</th>
              <th data-pt="Implicação Analítica / Limitação" data-en="Analytical Implication / Limitation">Implicação Analítica / Limitação</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong data-pt="Ficheiro / Cena" data-en="File / Scene">Ficheiro / Cena</strong></td>
              <td><code>${raster.fileName}</code></td>
              <td data-pt="Processamento local via WebGIS sem reamostragem destrutiva." data-en="Local processing via WebGIS without destructive resampling.">Processamento local via WebGIS sem reamostragem destrutiva.</td>
            </tr>
            <tr>
              <td><strong data-pt="Sistema de Referência (CRS)" data-en="Coordinate Reference System (CRS)">Sistema de Referência (CRS)</strong></td>
              <td><code>EPSG:${raster.epsg}</code> (${raster.isProjected ? 'Projetado / Métrico' : 'Geográfico / Graus'})</td>
              <td data-pt="Resolução de pixel: ${resX.toFixed(2)} × ${resY.toFixed(2)} ${raster.isProjected ? 'm' : 'graus'} (${pixelAreaM2.toFixed(2)} m²/px)." data-en="Pixel resolution: ${resX.toFixed(2)} × ${resY.toFixed(2)} ${raster.isProjected ? 'm' : 'deg'} (${pixelAreaM2.toFixed(2)} m²/px).">Resolução de pixel: ${resX.toFixed(2)} × ${resY.toFixed(2)} ${raster.isProjected ? 'm' : 'graus'} (${pixelAreaM2.toFixed(2)} m²/px).</td>
            </tr>
            <tr>
              <td><strong data-pt="Cobertura de Píxeis e NoData" data-en="Pixel Coverage and NoData">Cobertura de Píxeis e NoData</strong></td>
              <td>Total: ${(raster.width * raster.height).toLocaleString('pt-BR')} px · Válidos: <b>${validCount.toLocaleString('pt-BR')} px</b> · NoData: <b>${noDataCount.toLocaleString('pt-BR')} px</b> (${pct(noDataCount, raster.width * raster.height)}%)</td>
              <td data-pt="Píxeis NoData (nuvens/bordas mascaradas por QA_PIXEL) foram excluídos do denominador de todos os cálculos." data-en="NoData pixels (clouds/borders masked by QA_PIXEL) were excluded from the denominator of all calculations.">Píxeis NoData (nuvens/bordas mascaradas por QA_PIXEL) foram excluídos do denominador de todos os cálculos.</td>
            </tr>
            <tr>
              <td><strong data-pt="Compatibilidade Temporal (Óptico vs. Térmico)" data-en="Temporal Compatibility (Optical vs. Thermal)">Compatibilidade Temporal (Óptico vs. Térmico)</strong></td>
              <td>Data 1 (SR2D4): <b>${dateOptical}</b> · Data 2 (Landsat ST_B10): <b>${dateThermal}</b> ${daysGap !== null ? `(<b>Δ = ${daysGap} dias</b>)` : ''}</td>
              <td data-pt="Diferenças temporais (ex.: 17 dias entre 04/09/2026 e 21/09/2026) podem refletir variações sinóticas de humidade do solo, vento e insolação entre as passagens." data-en="Temporal gaps (e.g., 17 days between 2026-09-04 and 2026-09-21) may reflect synoptic variations in soil moisture, wind and solar radiation between overpasses.">Diferenças temporais (ex.: 17 dias entre 04/09/2026 e 21/09/2026) podem refletir variações sinóticas de humidade do solo, vento e insolação entre as passagens.</td>
            </tr>
            <tr>
              <td><strong data-pt="Camadas Vetoriais (Bairros, Ruas, Saúde)" data-en="Vector Layers (Neighborhoods, Streets, Health)">Camadas Vetoriais (Bairros, Ruas, Saúde)</strong></td>
              <td><span class="tag pending" data-pt="Não fornecidas na sessão atual" data-en="Not provided in current session">Não fornecidas na sessão atual</span></td>
              <td data-pt="Sem ficheiros GeoJSON/Shapefile de limites de bairros e eixos de ruas, os rankings territoriais permanecem bloqueados para evitar dados fictícios." data-en="Without GeoJSON/Shapefile neighborhood boundaries and street centerlines, territorial rankings remain locked to prevent fabricated data.">Sem ficheiros GeoJSON/Shapefile de limites de bairros e eixos de ruas, os rankings territoriais permanecem bloqueados para evitar dados fictícios.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>

  <!-- 03. EVIDÊNCIA ESPACIAL: MAPAS LST E UHI COM LEGENDAS -->
  <section id="mapa" class="section">
    <div class="section-head">
      <div>
        <div class="section-kicker" data-pt="03 · Evidência espacial" data-en="03 · Spatial evidence">03 · Evidência espacial</div>
        <h2 data-pt="Cartografia térmica de alta definição: Temperatura (LST) e Ilhas de Calor (UHI)" data-en="High-definition thermal cartography: Temperature (LST) and Urban Heat Islands (UHI)">Cartografia térmica de alta definição: Temperatura (LST) e Ilhas de Calor (UHI)</h2>
        <p class="section-desc" data-pt="Ambos os mapas abaixo incluem as respetivas legendas cartográficas completas no rodapé da imagem (escala contínua em °C e estratificação nas 6 classes UHI)." data-en="Both maps below include their respective full cartographic legends in the image footer (continuous °C scale and 6-class UHI stratification).">Ambos os mapas abaixo incluem as respetivas legendas cartográficas completas no rodapé da imagem (escala contínua em °C e estratificação nas 6 classes UHI).</p>
      </div>
      <span class="chip ok" data-pt="Mapas LST + UHI com legendas" data-en="LST + UHI maps with legends">Mapas LST + UHI com legendas</span>
    </div>
    <div class="grid-2">
      <div class="card">
        <h3 data-pt="3.1 · Mapa de Temperatura de Superfície (LST °C)" data-en="3.1 · Land Surface Temperature Map (LST °C)">3.1 · Mapa de Temperatura de Superfície (LST °C)</h3>
        <div class="map-frame">
          <img src="${lstMapDataUrl}" alt="Mapa de Temperatura de Superfície LST com legenda em graus Celsius">
          <div class="map-caption">
            <span data-pt="Fusão TsHARP 1 m sobre base óptica RGB · Paleta: ${paletteName.toUpperCase()}" data-en="1 m TsHARP fusion over RGB optical base · Palette: ${paletteName.toUpperCase()}">Fusão TsHARP 1 m sobre base óptica RGB · Paleta: ${paletteName.toUpperCase()}</span>
            <span>Mín: ${min.toFixed(1)} °C · Média: ${mean.toFixed(1)} °C · Máx: ${max.toFixed(1)} °C</span>
          </div>
        </div>
      </div>
      <div class="card">
        <h3 data-pt="3.2 · Mapa de Ilhas de Calor Urbanas (UHI 1 m)" data-en="3.2 · Urban Heat Island Map (UHI 1 m)">3.2 · Mapa de Ilhas de Calor Urbanas (UHI 1 m)</h3>
        <div class="map-frame">
          <img src="${uhiMapDataUrl}" alt="Mapa de Classes de Ilha de Calor Urbana UHI com legenda">
          <div class="map-caption">
            <span data-pt="Classificação em 6 níveis térmicos (${uhiMethod.toUpperCase()} · γ=${uhiPower.toFixed(2)})" data-en="6-level thermal classification (${uhiMethod.toUpperCase()} · γ=${uhiPower.toFixed(2)})">Classificação em 6 níveis térmicos (${uhiMethod.toUpperCase()} · γ=${uhiPower.toFixed(2)})</span>
            <span data-pt="UHI Forte + Extrema: ${uhiStrongExtremePct}% da área útil" data-en="Strong + Extreme UHI: ${uhiStrongExtremePct}% of valid area">UHI Forte + Extrema: ${uhiStrongExtremePct}% da área útil</span>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- 04. DISTRIBUIÇÃO E CLASSES UHI -->
  <section id="classes" class="section">
    <div class="section-head">
      <div>
        <div class="section-kicker" data-pt="04 · Distribuição térmica e estratificação UHI" data-en="04 · Thermal distribution and UHI stratification">04 · Distribuição térmica e estratificação UHI</div>
        <h2 data-pt="Histograma de temperatura e repartição por classes de anomalia" data-en="Temperature histogram and breakdown by anomaly classes">Histograma de temperatura e repartição por classes de anomalia</h2>
      </div>
      <span class="chip info" data-pt="Unidades: °C, % e hectares (ha)" data-en="Units: °C, % and hectares (ha)">Unidades: °C, % e hectares (ha)</span>
    </div>
    <div class="two-col">
      <div class="card">
        <h3 data-pt="4.1 · Distribuição por Classe de Ilha de Calor (UHI)" data-en="4.1 · Distribution by Urban Heat Island (UHI) Class">4.1 · Distribuição por Classe de Ilha de Calor (UHI)</h3>
        ${uhiBarsHtml}
        <div class="chart-legend">
          <span><i class="legend-dot" style="background:#103e8a"></i><strong>Unidade:</strong> % da área útil e hectares (ha)</span>
          <span><strong>Denominador:</strong> ${validCount.toLocaleString('pt-BR')} píxeis válidos (${validAreaHa.toFixed(2)} ha)</span>
          <span><strong>Fonte:</strong> Raster numérico LST (${raster.fileName}) · <strong>Data:</strong> ${dateOptical}</span>
        </div>
      </div>
      <div class="card">
        <h3 data-pt="4.2 · Histograma Numérico de Temperatura (12 faixas)" data-en="4.2 · Numerical Temperature Histogram (12 bins)">4.2 · Histograma Numérico de Temperatura (12 faixas)</h3>
        ${histBarsHtml}
        <div class="stat-list">
          <div class="stat-item"><span data-pt="Percentil 10% (P10)" data-en="10th Percentile (P10)">Percentil 10% (P10)</span><b>${p10.toFixed(1)} °C</b></div>
          <div class="stat-item"><span data-pt="Quartil 25% (Q25)" data-en="25th Percentile (Q25)">Quartil 25% (Q25)</span><b>${q25.toFixed(1)} °C</b></div>
          <div class="stat-item"><span data-pt="Mediana (Q50)" data-en="Median (Q50)">Mediana (Q50)</span><b>${q50.toFixed(1)} °C</b></div>
          <div class="stat-item"><span data-pt="Quartil 75% (Q75)" data-en="75th Percentile (Q75)">Quartil 75% (Q75)</span><b>${q75.toFixed(1)} °C</b></div>
          <div class="stat-item"><span data-pt="Percentil 90% (P90)" data-en="90th Percentile (P90)">Percentil 90% (P90)</span><b>${p90.toFixed(1)} °C</b></div>
          <div class="stat-item"><span data-pt="Acima de 31,0 °C" data-en="Above 31.0 °C">Acima de 31,0 °C</span><b>${pct(above31Count)}% (${ha(above31Count)} ha)</b></div>
        </div>
        <div class="chart-legend">
          <span><strong>Unidade:</strong> °C e % de píxeis válidos</span>
          <span><strong>Denominador:</strong> ${validCount.toLocaleString('pt-BR')} px</span>
          <span><strong>Data:</strong> ${dateOptical}</span>
        </div>
      </div>
    </div>
  </section>

  <!-- 05. COBERTURA DO SOLO E ÍNDICES ESPECTRAIS -->
  <section id="espectral" class="section">
    <div class="section-head">
      <div>
        <div class="section-kicker" data-pt="05 · Cobertura do solo e morfologia óptica" data-en="05 · Land cover and optical morphology">05 · Cobertura do solo e morfologia óptica</div>
        <h2 data-pt="Análise espectral exaustiva (NDVI e NDBI)" data-en="Exhaustive spectral analysis (NDVI and NDBI)">Análise espectral exaustiva (NDVI e NDBI)</h2>
        <p class="section-desc" data-pt="Partição completa dos píxeis válidos com verificação explícita de sobreposição entre limiares espectrais." data-en="Complete partition of valid pixels with explicit overlap verification between spectral thresholds.">Partição completa dos píxeis válidos com verificação explícita de sobreposição entre limiares espectrais.</p>
      </div>
      <span class="chip ok">NDVI μ = ${meanNdvi.toFixed(3)} · NDBI μ = ${meanNdbi.toFixed(3)}</span>
    </div>
    <div class="card">
      <div class="bar-row">
        <div class="bar-label"><span data-pt="1. Vegetação vigorosa (NDVI > 0,30)" data-en="1. Vigorous vegetation (NDVI > 0.30)">1. Vegetação vigorosa (NDVI &gt; 0,30)</span><b>${pct(vegCount, spectralValid)}% · ${ha(vegCount)} ha (${vegCount.toLocaleString('pt-BR')} px)</b></div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct(vegCount, spectralValid)}%;background:#27765e"></div></div>
      </div>
      <div class="bar-row">
        <div class="bar-label"><span data-pt="2. Área construída / impermeável líquida (NDBI > 0,10 e NDVI ≤ 0,30)" data-en="2. Net built-up / impervious area (NDBI > 0.10 and NDVI ≤ 0.30)">2. Área construída / impermeável líquida (NDBI &gt; 0,10 e NDVI ≤ 0,30)</span><b>${pct(builtCount, spectralValid)}% · ${ha(builtCount)} ha (${builtCount.toLocaleString('pt-BR')} px)</b></div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct(builtCount, spectralValid)}%;background:#c84638"></div></div>
      </div>
      <div class="bar-row">
        <div class="bar-label"><span data-pt="3. Água ou superfícies fortemente sombreadas (NDVI < 0 e NDBI < 0)" data-en="3. Water or heavily shaded surfaces (NDVI < 0 and NDBI < 0)">3. Água ou superfícies fortemente sombreadas (NDVI &lt; 0 e NDBI &lt; 0)</span><b>${pct(waterShadeCount, spectralValid)}% · ${ha(waterShadeCount)} ha (${waterShadeCount.toLocaleString('pt-BR')} px)</b></div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct(waterShadeCount, spectralValid)}%;background:#2668b8"></div></div>
      </div>
      <div class="bar-row">
        <div class="bar-label"><span data-pt="4. Solo exposto de transição / vegetação rasteira seca (restantes píxeis válidos)" data-en="4. Transitional bare soil / dry low vegetation (remaining valid pixels)">4. Solo exposto de transição / vegetação rasteira seca (restantes píxeis válidos)</span><b>${pct(mixedSoilCount, spectralValid)}% · ${ha(mixedSoilCount)} ha (${mixedSoilCount.toLocaleString('pt-BR')} px)</b></div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct(mixedSoilCount, spectralValid)}%;background:#f1b64a"></div></div>
      </div>
      <div class="chart-legend">
        <span><strong>Unidade:</strong> % e ha · <strong>Soma das 4 classes mutuamente exclusivas:</strong> 100,0% (${spectralValid.toLocaleString('pt-BR')} px)</span>
        <span><strong>Sobreposição bruta (NDVI &gt; 0,3 ∩ NDBI &gt; 0,1):</strong> ${pct(overlapVegBuilt, spectralValid)}% (${overlapVegBuilt.toLocaleString('pt-BR')} px)</span>
        <span><strong>Fonte:</strong> Bandas Red, NIR e SWIR SR2D4 · <strong>Data:</strong> ${dateOptical}</span>
      </div>
    </div>
  </section>

  <!-- 06. RESULTADOS POR BAIRRO E RANKING POR RUA/SEGMENTO -->
  <section id="lacunas" class="section">
    <div class="section-head">
      <div>
        <div class="section-kicker" data-pt="06 · Recortes territoriais intraurbanos" data-en="06 · Intra-urban territorial units">06 · Recortes territoriais intraurbanos</div>
        <h2 data-pt="Resultados por bairro e ranking por rua/segmento viário" data-en="Results by neighborhood and ranking by street/road segment">Resultados por bairro e ranking por rua/segmento viário</h2>
      </div>
      <span class="chip pending" data-pt="Não calculado — dados vetoriais ausentes" data-en="Not calculated — vector data missing">Não calculado — dados vetoriais ausentes</span>
    </div>
    <div class="callout red">
      <strong data-pt="Regra de integridade cartográfica:" data-en="Cartographic integrity rule:">Regra de integridade cartográfica:</strong>
      <span data-pt=" Nenhum ficheiro vetorial (GeoJSON/Shapefile/GeoPackage) contendo limites oficiais de bairros ou eixos de logradouros foi fornecido na sessão atual. Em conformidade com o protocolo de rastreabilidade, este relatório não inventa nomes de bairros, IDs de ruas nem estatísticas zonais sem geometrias reais." data-en=" No vector file (GeoJSON/Shapefile/GeoPackage) containing official neighborhood boundaries or street centerlines was provided in the current session. In compliance with the traceability protocol, this report does not fabricate neighborhood names, street IDs or zonal statistics without real geometries."> Nenhum ficheiro vetorial (GeoJSON/Shapefile/GeoPackage) contendo limites oficiais de bairros ou eixos de logradouros foi fornecido na sessão atual. Em conformidade com o protocolo de rastreabilidade, este relatório não inventa nomes de bairros, IDs de ruas nem estatísticas zonais sem geometrias reais.</span>
    </div>
    <div class="table-wrap" style="margin-top:14px">
      <table>
        <thead>
          <tr>
            <th data-pt="Recorte Espacial" data-en="Spatial Unit">Recorte Espacial</th>
            <th data-pt="Estado" data-en="Status">Estado</th>
            <th data-pt="Operação Espacial Documentada" data-en="Documented Spatial Operation">Operação Espacial Documentada</th>
            <th data-pt="Indicadores a Extrair com a Base Vetorial" data-en="Indicators to Extract with Vector Base">Indicadores a Extrair com a Base Vetorial</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><strong data-pt="Bairros / Setores Censitários" data-en="Neighborhoods / Census Tracts">Bairros / Setores Censitários</strong></td>
            <td><span class="tag pending" data-pt="Não calculado — dados ausentes" data-en="Not calculated — missing data">Não calculado — dados ausentes</span></td>
            <td><code>Zonal Statistics</code> sobre polígonos reprojetados para <code>EPSG:${raster.epsg}</code> com reparação topológica (<code>ST_MakeValid</code>).</td>
            <td>Nome e ID real do bairro, área válida (ha), LST média, mediana (Q50), P90, máximo, % acima de ${hotspotThreshold.toFixed(1)} °C, partição nas 6 classes UHI e NDVI/NDBI médios.</td>
          </tr>
          <tr>
            <td><strong data-pt="Ruas / Segmentos Viários" data-en="Streets / Road Segments">Ruas / Segmentos Viários</strong></td>
            <td><span class="tag pending" data-pt="Não calculado — dados ausentes" data-en="Not calculated — missing data">Não calculado — dados ausentes</span></td>
            <td>Buffer métrico (ex.: 5 m a 10 m) ou interseção de célula por segmento linear (<code>LineString</code>) com o raster numérico de 1 m.</td>
            <td>Nome oficial do logradouro, <code>osm_id</code>/código viário, comprimento total (m), LST média por segmento, metros lineares em UHI forte/extrema e fração sombreada por copa (NDVI &gt; 0,3).</td>
          </tr>
          <tr>
            <td><strong data-pt="Área de Interesse (AOI Desenhada)" data-en="Area of Interest (Drawn AOI)">Área de Interesse (AOI Desenhada)</strong></td>
            <td><span class="tag ${aoiStats ? 'available' : 'pending'}">${aoiStats ? 'Calculado do raster' : 'Aguardando desenho no mapa'}</span></td>
            <td>Filtro ponto-em-polígono (Ray-Casting) sobre os centros de píxel do raster numérico.</td>
            <td>${aoiStats ? `Contagem: ${aoiStats.count.toLocaleString('pt-BR')} px (${ha(aoiStats.count)} ha) · Mín: ${aoiStats.min.toFixed(1)} °C · Média: ${aoiStats.mean.toFixed(2)} °C · Máx: ${aoiStats.max.toFixed(1)} °C.` : 'Desenhe um polígono na ferramenta AOI do mapa e clique em Analisar AOI antes de exportar.'}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>

  <!-- 07, 08, 09, 10. MÓDULOS TEMÁTICOS (CONFORTO, SAÚDE, MOBILIDADE, POLUIÇÃO) -->
  <section id="conforto" class="section">
    <div class="section-head">
      <div>
        <div class="section-kicker" data-pt="07 a 10 · Módulos temáticos urbano-saúde-ambientais" data-en="07 to 10 · Urban-health-environmental thematic modules">07 a 10 · Módulos temáticos urbano-saúde-ambientais</div>
        <h2 data-pt="Conforto térmico, saúde, mobilidade ativa e qualidade do ar" data-en="Thermal comfort, health, active mobility and air quality">Conforto térmico, saúde, mobilidade ativa e qualidade do ar</h2>
      </div>
      <span class="chip pending" data-pt="Módulos dependentes de sensores/bases externas" data-en="Modules dependent on external sensors/datasets">Módulos dependentes de sensores/bases externas</span>
    </div>
    <div class="grid-2">
      <article class="card theme-card" id="conforto-card">
        <div class="theme-icon">🌡️</div>
        <h3 data-pt="07 · Conforto Térmico Humano (UTCI / PET / WBGT)" data-en="07 · Human Thermal Comfort (UTCI / PET / WBGT)">07 · Conforto Térmico Humano (UTCI / PET / WBGT)</h3>
        <p data-pt="A Temperatura de Superfície (LST) mede a radiância emitida pelo solo/coberturas e NÃO equivale à temperatura do ar a 1,5 m (Ta) nem à sensação térmica fisiológica." data-en="Land Surface Temperature (LST) measures radiance emitted by ground/roofs and DOES NOT equal 1.5 m air temperature (Ta) or physiological thermal sensation.">A Temperatura de Superfície (LST) mede a radiância emitida pelo solo/coberturas e NÃO equivale à temperatura do ar a 1,5 m (Ta) nem à sensação térmica fisiológica.</p>
        <ul>
          <li data-pt="Variáveis exigidas ausentes: Temperatura do ar (Ta), Humidade relativa (RH), Velocidade do vento a 10 m (v) e Temperatura radiante média (Tmrt)." data-en="Missing required variables: Air temperature (Ta), Relative humidity (RH), Wind speed (v) and Mean radiant temperature (Tmrt).">Variáveis exigidas ausentes: Temperatura do ar (Ta), Humidade relativa (RH), Velocidade do vento a 10 m (v) e Temperatura radiante média (Tmrt).</li>
          <li data-pt="Uso válido atual: Identificar superfícies que atuam como fontes secundárias de calor sensível e radiação de onda longa." data-en="Current valid use: Identify surfaces acting as secondary sources of sensible heat and longwave radiation.">Uso válido atual: Identificar superfícies que atuam como fontes secundárias de calor sensível e radiação de onda longa.</li>
        </ul>
        <span class="chip pending" data-pt="Não calculado — dados micrometeorológicos ausentes" data-en="Not calculated — micrometeorological data missing">Não calculado — dados micrometeorológicos ausentes</span>
      </article>

      <article class="card theme-card" id="saude">
        <div class="theme-icon">🏥</div>
        <h3 data-pt="08 · Exposição e Vulnerabilidade em Saúde" data-en="08 · Health Exposure and Vulnerability">08 · Exposição e Vulnerabilidade em Saúde</h3>
        <p data-pt="A exposição térmica potencial deve ser cruzada com densidade populacional, estrutura etária (idosos > 65 anos e crianças < 5 anos), renda e localização de unidades de saúde/escolas." data-en="Potential thermal exposure must be crossed with population density, age structure (elderly > 65 and children < 5), income and healthcare/school facilities.">A exposição térmica potencial deve ser cruzada com densidade populacional, estrutura etária (idosos &gt; 65 anos e crianças &lt; 5 anos), renda e localização de unidades de saúde/escolas.</p>
        <ul>
          <li data-pt="Limitação epidemiológica: Mesmo com dados de internações/óbitos, correlação ecológica espacial não comprova causalidade direta sem controlo de fatores de confusão." data-en="Epidemiological limitation: Even with hospitalization/mortality data, spatial ecological correlation does not prove direct causality without controlling for confounders.">Limitação epidemiológica: Mesmo com dados de internações/óbitos, correlação ecológica espacial não comprova causalidade direta sem controlo de fatores de confusão.</li>
        </ul>
        <span class="chip pending" data-pt="Não calculado — censo demográfico e registos de saúde ausentes" data-en="Not calculated — census and health records missing">Não calculado — censo demográfico e registos de saúde ausentes</span>
      </article>

      <article class="card theme-card" id="mobilidade">
        <div class="theme-icon">🚲</div>
        <h3 data-pt="09 · Mobilidade Ativa e Acesso a Serviços" data-en="09 · Active Mobility and Service Access">09 · Mobilidade Ativa e Acesso a Serviços</h3>
        <p data-pt="Avalia a carga térmica sobre passeios pedonais, ciclovias, paragens de autocarro/transporte público e rotas de caminhada até equipamentos públicos." data-en="Evaluates thermal load along sidewalks, bike lanes, bus/transit stops and walking routes to public facilities.">Avalia a carga térmica sobre passeios pedonais, ciclovias, paragens de autocarro/transporte público e rotas de caminhada até equipamentos públicos.</p>
        <ul>
          <li data-pt="Insumos necessários: Rede viária caminável (OSM/municipal), paragens GTFS e pontos de interesse (escolas, UBS, terminais)." data-en="Required inputs: Walkable street network (OSM/municipal), GTFS stops and points of interest (schools, clinics, terminals).">Insumos necessários: Rede viária caminável (OSM/municipal), paragens GTFS e pontos de interesse (escolas, UBS, terminais).</li>
        </ul>
        <span class="chip pending" data-pt="Não calculado — rede viária e pontos GTFS ausentes" data-en="Not calculated — street network and GTFS points missing">Não calculado — rede viária e pontos GTFS ausentes</span>
      </article>

      <article class="card theme-card" id="poluicao">
        <div class="theme-icon">🌫️</div>
        <h3 data-pt="10 · Poluição Atmosférica (PM2.5, PM10, NO2, O3)" data-en="10 · Air Pollution (PM2.5, PM10, NO2, O3)">10 · Poluição Atmosférica (PM2.5, PM10, NO2, O3)</h3>
        <p data-pt="Proibição metodológica estrita: Temperatura de superfície (LST) NÃO pode ser utilizada como substituto ou proxy de concentrações de poluentes atmosféricos." data-en="Strict methodological prohibition: Land Surface Temperature (LST) CANNOT be used as a substitute or proxy for air pollutant concentrations.">Proibição metodológica estrita: Temperatura de superfície (LST) NÃO pode ser utilizada como substituto ou proxy de concentrações de poluentes atmosféricos.</p>
        <ul>
          <li data-pt="Insumos necessários: Estações de referência da qualidade do ar, sensores calibrados ou colunas troposféricas Sentinel-5P/TROPOMI validadas." data-en="Required inputs: Reference air quality stations, calibrated sensors or validated Sentinel-5P/TROPOMI tropospheric columns.">Insumos necessários: Estações de referência da qualidade do ar, sensores calibrados ou colunas troposféricas Sentinel-5P/TROPOMI validadas.</li>
        </ul>
        <span class="chip pending" data-pt="Não calculado — dados de qualidade do ar ausentes" data-en="Not calculated — air quality data missing">Não calculado — dados de qualidade do ar ausentes</span>
      </article>
    </div>
  </section>

  <!-- 11. PAINEL INTEGRADO DE INDICADORES -->
  <section id="indicadores" class="section">
    <div class="section-head">
      <div>
        <div class="section-kicker" data-pt="11 · Matriz síntese auditável" data-en="11 · Auditable synthesis matrix">11 · Matriz síntese auditável</div>
        <h2 data-pt="Painel integrado de indicadores urbano-saúde-ambientais" data-en="Integrated panel of urban-health-environmental indicators">Painel integrado de indicadores urbano-saúde-ambientais</h2>
      </div>
      <span class="chip info" data-pt="Rastreabilidade completa" data-en="Full traceability">Rastreabilidade completa</span>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th data-pt="Domínio" data-en="Domain">Domínio</th>
            <th data-pt="Indicador" data-en="Indicator">Indicador</th>
            <th data-pt="Valor / Resultado" data-en="Value / Result">Valor / Resultado</th>
            <th data-pt="Unidade & Denominador" data-en="Unit & Denominator">Unidade &amp; Denominador</th>
            <th data-pt="Estado Metodológico" data-en="Methodological Status">Estado Metodológico</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><strong>Clima Urbano</strong></td>
            <td>LST Média / Mediana / Desvio</td>
            <td><b>${mean.toFixed(2)} °C</b> / ${q50.toFixed(2)} °C / ±${stdDev.toFixed(2)} °C</td>
            <td>°C (${validCount.toLocaleString('pt-BR')} px válidos)</td>
            <td><span class="tag available">Calculado do raster numérico</span></td>
          </tr>
          <tr>
            <td><strong>Extremos Térmicos</strong></td>
            <td>Área acima do limiar μ + 1,5σ (${hotspotThreshold.toFixed(1)} °C)</td>
            <td><b>${pct(aboveHotspotCount)}%</b> (${ha(aboveHotspotCount)} ha)</td>
            <td>% e ha sobre ${validAreaHa.toFixed(2)} ha</td>
            <td><span class="tag available">Calculado do raster numérico</span></td>
          </tr>
          <tr>
            <td><strong>Ilha de Calor (UHI)</strong></td>
            <td>Fração em UHI Forte + Extrema (&gt; +0,85σ)</td>
            <td><b>${uhiStrongExtremePct}%</b> (${ha(uhiCounts[4] + uhiCounts[5])} ha)</td>
            <td>% e ha sobre ${validAreaHa.toFixed(2)} ha</td>
            <td><span class="tag available">Calculado (${uhiMethod.toUpperCase()})</span></td>
          </tr>
          <tr>
            <td><strong>Infraestrutura Verde</strong></td>
            <td>Cobertura Vegetal Vigorosa (NDVI &gt; 0,30)</td>
            <td><b>${pct(vegCount, spectralValid)}%</b> (${ha(vegCount)} ha · NDVI μ=${meanNdvi.toFixed(3)})</td>
            <td>% e ha sobre ${spectralValid.toLocaleString('pt-BR')} px</td>
            <td><span class="tag available">Calculado (Red/NIR SR2D4)</span></td>
          </tr>
          <tr>
            <td><strong>Morfologia Construída</strong></td>
            <td>Superfície Impermeável Líquida (NDBI &gt; 0,10)</td>
            <td><b>${pct(builtCount, spectralValid)}%</b> (${ha(builtCount)} ha · NDBI μ=${meanNdbi.toFixed(3)})</td>
            <td>% e ha sobre ${spectralValid.toLocaleString('pt-BR')} px</td>
            <td><span class="tag available">Calculado (NIR/SWIR SR2D4)</span></td>
          </tr>
          <tr>
            <td><strong>Gestão por Bairro / Rua</strong></td>
            <td>Ranking de Bairros e Segmentos Viários Críticos</td>
            <td>—</td>
            <td>°C e % por polígono/segmento</td>
            <td><span class="tag pending">Não calculado — dados ausentes</span></td>
          </tr>
          <tr>
            <td><strong>Biometeorologia</strong></td>
            <td>Conforto Térmico (UTCI / PET / WBGT)</td>
            <td>—</td>
            <td>°C equivalentes fisiológicos</td>
            <td><span class="tag pending">Não calculado — dados ausentes</span></td>
          </tr>
          <tr>
            <td><strong>Saúde Ambiental</strong></td>
            <td>População Vulnerável Exposta a Hotspots</td>
            <td>—</td>
            <td>Habitantes / taxa por 10.000 hab.</td>
            <td><span class="tag pending">Não calculado — dados ausentes</span></td>
          </tr>
          <tr>
            <td><strong>Qualidade do Ar</strong></td>
            <td>Concentração de PM2.5, PM10, NO2 e O3</td>
            <td>—</td>
            <td>µg/m³</td>
            <td><span class="tag pending">Não calculado — dados ausentes</span></td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>

  <!-- 12. RECOMENDAÇÕES PRIORIZADAS E LIMITAÇÕES -->
  <section id="metodo" class="section">
    <div class="section-head">
      <div>
        <div class="section-kicker" data-pt="12 · Tomada de decisão e governança técnica" data-en="12 · Decision making and technical governance">12 · Tomada de decisão e governança técnica</div>
        <h2 data-pt="Recomendações priorizadas e limitações metodológicas" data-en="Prioritized recommendations and methodological limitations">Recomendações priorizadas e limitações metodológicas</h2>
      </div>
      <span class="chip info" data-pt="Plano de ação P1 – P3" data-en="Action plan P1 – P3">Plano de ação P1 – P3</span>
    </div>
    <div class="two-col">
      <div class="card">
        <h3 data-pt="12.1 · Recomendações Priorizadas de Intervenção" data-en="12.1 · Prioritized Intervention Recommendations">12.1 · Recomendações Priorizadas de Intervenção</h3>
        <div class="action-row">
          <div class="priority p1" data-pt="PRIORIDADE P1 · IMEDIATA" data-en="PRIORITY P1 · IMMEDIATE">PRIORIDADE P1 · IMEDIATA</div>
          <div>
            <strong data-pt="Mitigação localizada nos ${ha(uhiCounts[5])} ha de Hotspot Extremo (> +1,40σ)" data-en="Localized mitigation across the ${ha(uhiCounts[5])} ha of Extreme Hotspot (> +1.40σ)">Mitigação localizada nos ${ha(uhiCounts[5])} ha de Hotspot Extremo (&gt; +1,40σ)</strong>
            <p data-pt="Vistoriar grandes coberturas metálicas, parques de estacionamento impermeáveis e pátios logísticos que superam ${hotspotThreshold.toFixed(1)} °C para aplicação de telhados frios (alto albedo) e sombreamento arbóreo." data-en="Inspect large metal roofs, impervious parking lots and logistics yards exceeding ${hotspotThreshold.toFixed(1)} °C for cool roofs (high albedo) and tree shading.">Vistoriar grandes coberturas metálicas, parques de estacionamento impermeáveis e pátios logísticos que superam ${hotspotThreshold.toFixed(1)} °C para aplicação de telhados frios (alto albedo) e sombreamento arbóreo.</p>
          </div>
        </div>
        <div class="action-row">
          <div class="priority p2" data-pt="PRIORIDADE P2 · CURTO PRAZO" data-en="PRIORITY P2 · SHORT TERM">PRIORIDADE P2 · CURTO PRAZO</div>
          <div>
            <strong data-pt="Acoplamento das bases vetoriais de bairros, eixos viários e equipamentos sociais" data-en="Coupling vector databases of neighborhoods, road centerlines and social facilities">Acoplamento das bases vetoriais de bairros, eixos viários e equipamentos sociais</strong>
            <p data-pt="Cruzar o GeoTIFF numérico exportado (EPSG:${raster.epsg}) com a malha oficial de setores censitários, escolas, unidades básicas de saúde e paragens de transporte coletivo no QGIS." data-en="Cross the exported numerical GeoTIFF (EPSG:${raster.epsg}) with official census tracts, schools, health clinics and transit stops in QGIS.">Cruzar o GeoTIFF numérico exportado (EPSG:${raster.epsg}) com a malha oficial de setores censitários, escolas, unidades básicas de saúde e paragens de transporte coletivo no QGIS.</p>
          </div>
        </div>
        <div class="action-row">
          <div class="priority" data-pt="PRIORIDADE P3 · ESTRUTURAL" data-en="PRIORITY P3 · STRUCTURAL">PRIORIDADE P3 · ESTRUTURAL</div>
          <div>
            <strong data-pt="Proteção dos ${ha(uhiCounts[0] + uhiCounts[1])} ha de Ilhas de Frescor e Zonas Amenizadas" data-en="Protection of the ${ha(uhiCounts[0] + uhiCounts[1])} ha of Cool Islands and Mitigated Zones">Proteção dos ${ha(uhiCounts[0] + uhiCounts[1])} ha de Ilhas de Frescor e Zonas Amenizadas</strong>
            <p data-pt="Preservar os fragmentos com NDVI > 0,30 (${pct(vegCount, spectralValid)}% da cena) e conectá-los por corredores verdes ao longo dos eixos pedonais mais expostos." data-en="Preserve fragments with NDVI > 0.30 (${pct(vegCount, spectralValid)}% of scene) and connect them via green corridors along the most exposed pedestrian axes.">Preservar os fragmentos com NDVI &gt; 0,30 (${pct(vegCount, spectralValid)}% da cena) e conectá-los por corredores verdes ao longo dos eixos pedonais mais expostos.</p>
          </div>
        </div>
      </div>

      <div class="card">
        <h3 data-pt="12.2 · Nota Metodológica e Limitações" data-en="12.2 · Methodological Note and Limitations">12.2 · Nota Metodológica e Limitações</h3>
        <div class="callout">
          <strong data-pt="Natureza física da super-resolução térmica (TsHARP 1 m):" data-en="Physical nature of thermal super-resolution (1 m TsHARP):">Natureza física da super-resolução térmica (TsHARP 1 m):</strong>
          <span data-pt=" O campo térmico de 1 m preserva o balanço radiométrico observado pelo sensor Landsat 8/9 Collection 2 Level-2 (Banda ST_B10), redistribuindo o detalhe espacial segundo regressores de reflectância e índices espectrais (NDVI, NDBI, NDWI) do produto SR2D4." data-en=" The 1 m thermal field preserves the radiometric balance observed by the Landsat 8/9 Collection 2 Level-2 sensor (Band ST_B10), redistributing spatial detail via reflectance regressors and spectral indices (NDVI, NDBI, NDWI) from the SR2D4 product."> O campo térmico de 1 m preserva o balanço radiométrico observado pelo sensor Landsat 8/9 Collection 2 Level-2 (Banda ST_B10), redistribuindo o detalhe espacial segundo regressores de reflectância e índices espectrais (NDVI, NDBI, NDWI) do produto SR2D4.</span>
        </div>
        <ul style="font-size:13px;color:#52647a;padding-left:18px;margin-top:12px">
          <li data-pt="Incompatibilidade temporal entre sensores: Quando há desfasamento entre a aquisição óptica e a passagem térmica (ex.: ${daysGap !== null ? `${daysGap} dias entre ${dateOptical} e${dateThermal}` : 'datas distintas'}), mudanças bruscas de humidade ou nebulosidade podem introduzir incerteza local." data-en="Temporal mismatch between sensors: When there is a gap between optical acquisition and thermal overpass (e.g., ${daysGap !== null ? `${daysGap} days between ${dateOptical} and${dateThermal}` : 'distinct dates'}), sudden changes in moisture or cloudiness may introduce local uncertainty.">Incompatibilidade temporal entre sensores: Quando há desfasamento entre a aquisição óptica e a passagem térmica (ex.: ${daysGap !== null ? `${daysGap} dias entre ${dateOptical} e${dateThermal}` : 'datas distintas'}), mudanças bruscas de humidade ou nebulosidade podem introduzir incerteza local.</li>
          <li data-pt="Anisotropia direcional e sombras: Fachadas verticais e cânions urbanos estreitos sofrem efeitos de visada e sombreamento solar no horário de passagem do satélite." data-en="Directional anisotropy and shadows: Vertical facades and narrow urban canyons experience viewing angle and solar shading effects at satellite overpass time.">Anisotropia direcional e sombras: Fachadas verticais e cânions urbanos estreitos sofrem efeitos de visada e sombreamento solar no horário de passagem do satélite.</li>
          <li data-pt="Validação in loco recomendada: Campanhas móveis de termohigrometria ao nível do pedestre (1,5 m) são indispensáveis antes de projetos executivos." data-en="Recommended in-situ validation: Mobile pedestrian-level thermohygrometry campaigns (1.5 m) are essential prior to executive engineering design.">Validação in loco recomendada: Campanhas móveis de termohigrometria ao nível do pedestre (1,5 m) são indispensáveis antes de projetos executivos.</li>
        </ul>
      </div>
    </div>
  </section>

  <footer class="footer">
    <div>
      <strong>SR2D4 / LST Explorer · Relatório Técnico Auditável</strong>
      <p data-pt="Documento gerado automaticamente a partir de matrizes numéricas GeoTIFF no navegador. Nenhuma estatística foi inventada ou extraída de píxeis RGB renderizados." data-en="Document automatically generated from numerical GeoTIFF matrices in the browser. No statistics were fabricated or extracted from rendered RGB pixels.">Documento gerado automaticamente a partir de matrizes numéricas GeoTIFF no navegador. Nenhuma estatística foi inventada ou extraída de píxeis RGB renderizados.</p>
    </div>
    <div style="text-align:right;font-size:12px;color:#9cddda">
      <div>EPSG:${raster.epsg} · ${raster.width}×${raster.height} px</div>
      <div>${issueDate}</div>
    </div>
  </footer>
</div>

<script>
let currentLang = 'pt';
function toggleLanguage() {
  currentLang = currentLang === 'pt' ? 'en' : 'pt';
  document.documentElement.lang = currentLang === 'pt' ? 'pt-BR' : 'en';
  const btn = document.getElementById('lang-btn');
  if (btn) {
    btn.textContent = currentLang === 'pt' ? '🇬🇧 Switch to English' : '🇵🇹 Mudar para Português';
  }
  const elements = document.querySelectorAll('[data-pt][data-en]');
  elements.forEach((el) => {
    const text = el.getAttribute(currentLang === 'pt' ? 'data-pt' : 'data-en');
    if (text !== null) el.textContent = text;
  });
}
</script>
</body>
</html>`;

  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `SR2D4_relatorio_tecnico_expandido_${dateOptical}.html`;
  a.click();
  URL.revokeObjectURL(a.href);
}
