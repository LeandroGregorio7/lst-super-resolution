import React from 'react';
import { downloadFloat32Tiff } from './exportTiff';
import { boundsExtent, type RasterBounds } from './rasterGeo';

export type AoiShapeMode = 'rectangle' | 'square' | 'circle' | 'polygon';

export interface AoiDetailedStats {
  shapeMode: AoiShapeMode;
  vertices: [number, number][];
  count: number;
  areaM2: number;
  areaHa: number;
  min: number;
  max: number;
  mean: number;
  stdDev: number;
  q25: number;
  q50: number;
  q75: number;
  ndviMean: number;
  ndbiMean: number;
  vegPct: number;
  builtPct: number;
  uhiCounts: number[];
  uhiPcts: number[];
  previewDataUrl: string;
  clipWidth: number;
  clipHeight: number;
  clippedFloat32: Float32Array;
  clipOrigin: number[];
}

export interface AoiRasterSource {
  data: Float32Array;
  ndvi: Float32Array;
  ndbi: Float32Array;
  width: number;
  height: number;
  bounds: RasterBounds;
  origin: number[];
  resolution: number[];
  epsg: number;
  isProjected: boolean;
  fileName: string;
  stats: {
    min: number;
    max: number;
    mean: number;
    stdDev: number;
  };
}

export function buildShapeVertices(
  mode: AoiShapeMode,
  p1: [number, number],
  p2: [number, number],
): [number, number][] {
  const [lng1, lat1] = p1;
  const [lng2, lat2] = p2;
  const cosLat = Math.max(0.15, Math.cos(((lat1 + lat2) * 0.5 * Math.PI) / 180));

  if (mode === 'rectangle') {
    const west = Math.min(lng1, lng2);
    const east = Math.max(lng1, lng2);
    const south = Math.min(lat1, lat2);
    const north = Math.max(lat1, lat2);
    return [
      [west, north],
      [east, north],
      [east, south],
      [west, south],
    ];
  }

  if (mode === 'square') {
    const dxMeters = Math.abs(lng2 - lng1) * cosLat;
    const dyMeters = Math.abs(lat2 - lat1);
    const halfSide = Math.max(dxMeters, dyMeters, 1e-5);
    const dLng = halfSide / cosLat;
    const dLat = halfSide;
    return [
      [lng1 - dLng, lat1 + dLat],
      [lng1 + dLng, lat1 + dLat],
      [lng1 + dLng, lat1 - dLat],
      [lng1 - dLng, lat1 - dLat],
    ];
  }

  if (mode === 'circle') {
    const dx = (lng2 - lng1) * cosLat;
    const dy = lat2 - lat1;
    const radius = Math.max(Math.sqrt(dx * dx + dy * dy), 1e-5);
    const steps = 64;
    const pts: [number, number][] = [];
    for (let i = 0; i < steps; i += 1) {
      const angle = (i / steps) * Math.PI * 2;
      const vx = lng1 + (Math.cos(angle) * radius) / cosLat;
      const vy = lat1 + Math.sin(angle) * radius;
      pts.push([vx, vy]);
    }
    return pts;
  }

  return [p1, p2];
}

function pointInPoly(point: [number, number], polygon: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersect =
      yi > point[1] !== yj > point[1] &&
      point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi || Number.EPSILON) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function analyzeAoiDetailed(
  raster: AoiRasterSource,
  vertices: [number, number][],
  shapeMode: AoiShapeMode,
  opticalCanvas: HTMLCanvasElement | null,
  lstCanvas: HTMLCanvasElement | null,
  opacity: number,
): AoiDetailedStats | null {
  if (!raster || vertices.length < 3) return null;
  const ext = boundsExtent(raster.bounds);

  let minLng = Infinity;
  let maxLng = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const [lng, lat] of vertices) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }

  const x0 = Math.max(0, Math.floor(((minLng - ext.west) / (ext.east - ext.west)) * raster.width));
  const x1 = Math.min(raster.width - 1, Math.ceil(((maxLng - ext.west) / (ext.east - ext.west)) * raster.width));
  const y0 = Math.max(0, Math.floor(((ext.north - maxLat) / (ext.north - ext.south)) * raster.height));
  const y1 = Math.min(raster.height - 1, Math.ceil(((ext.north - minLat) / (ext.north - ext.south)) * raster.height));

  if (x1 < x0 || y1 < y0) return null;

  const clipWidth = Math.max(1, x1 - x0 + 1);
  const clipHeight = Math.max(1, y1 - y0 + 1);
  const clippedFloat32 = new Float32Array(clipWidth * clipHeight);
  clippedFloat32.fill(NaN);

  const values: number[] = [];
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  let ndviSum = 0;
  let ndbiSum = 0;
  let vegCount = 0;
  let builtCount = 0;
  let specValid = 0;
  const uhiCounts = [0, 0, 0, 0, 0, 0];
  const sceneMean = raster.stats.mean;
  const sceneStd = Math.max(0.6, raster.stats.stdDev);

  for (let y = y0; y <= y1; y += 1) {
    const lat = ext.north - ((y + 0.5) / raster.height) * (ext.north - ext.south);
    const rowOffset = y * raster.width;
    const clipRowOffset = (y - y0) * clipWidth;
    for (let x = x0; x <= x1; x += 1) {
      const lng = ext.west + ((x + 0.5) / raster.width) * (ext.east - ext.west);
      if (!pointInPoly([lng, lat], vertices)) continue;
      const idx = rowOffset + x;
      const val = raster.data[idx];
      if (!Number.isFinite(val)) continue;

      clippedFloat32[clipRowOffset + (x - x0)] = val;
      values.push(val);
      sum += val;
      if (val < min) min = val;
      if (val > max) max = val;

      const z = (val - sceneMean) / sceneStd;
      if (z < -0.95) uhiCounts[0] += 1;
      else if (z < -0.3) uhiCounts[1] += 1;
      else if (z < 0.25) uhiCounts[2] += 1;
      else if (z < 0.85) uhiCounts[3] += 1;
      else if (z < 1.4) uhiCounts[4] += 1;
      else uhiCounts[5] += 1;

      const ndvi = raster.ndvi[idx];
      const ndbi = raster.ndbi[idx];
      if (Number.isFinite(ndvi) && Number.isFinite(ndbi)) {
        specValid += 1;
        ndviSum += ndvi;
        ndbiSum += ndbi;
        if (ndvi > 0.3) vegCount += 1;
        if (ndbi > 0.1) builtCount += 1;
      }
    }
  }

  if (!values.length) return null;

  const count = values.length;
  const mean = sum / count;
  let sq = 0;
  for (let i = 0; i < count; i += 1) sq += (values[i] - mean) ** 2;
  const stdDev = count > 1 ? Math.sqrt(sq / count) : 0;

  values.sort((a, b) => a - b);
  const q25 = values[Math.floor(count * 0.25)] ?? min;
  const q50 = values[Math.floor(count * 0.5)] ?? mean;
  const q75 = values[Math.floor(count * 0.75)] ?? max;

  const resX = Math.abs(raster.resolution[0] || 1);
  const resY = Math.abs(raster.resolution[1] || 1);
  const pxAreaM2 = raster.isProjected ? resX * resY : resX * 111320 * (resY * 110540);
  const areaM2 = count * pxAreaM2;
  const areaHa = areaM2 / 10000;

  // Render preview image of the clipped AOI
  const previewCanvas = document.createElement('canvas');
  previewCanvas.width = clipWidth;
  previewCanvas.height = clipHeight;
  const pCtx = previewCanvas.getContext('2d');
  if (pCtx && opticalCanvas && lstCanvas) {
    pCtx.fillStyle = '#071317';
    pCtx.fillRect(0, 0, clipWidth, clipHeight);
    pCtx.drawImage(opticalCanvas, x0, y0, clipWidth, clipHeight, 0, 0, clipWidth, clipHeight);
    pCtx.globalAlpha = opacity;
    pCtx.drawImage(lstCanvas, x0, y0, clipWidth, clipHeight, 0, 0, clipWidth, clipHeight);
    pCtx.globalAlpha = 1;

    // Draw polygon border on preview
    pCtx.strokeStyle = '#ffb000';
    pCtx.lineWidth = Math.max(2, Math.round(Math.max(clipWidth, clipHeight) * 0.008));
    pCtx.beginPath();
    vertices.forEach(([lng, lat], idx) => {
      const px = ((lng - ext.west) / (ext.east - ext.west)) * raster.width - x0;
      const py = ((ext.north - lat) / (ext.north - ext.south)) * raster.height - y0;
      if (idx === 0) pCtx.moveTo(px, py);
      else pCtx.lineTo(px, py);
    });
    pCtx.closePath();
    pCtx.stroke();
  }

  const clipOrigin = [
    raster.origin[0] + x0 * raster.resolution[0],
    raster.origin[1] + y0 * raster.resolution[1],
    raster.origin[2] || 0,
  ];

  return {
    shapeMode,
    vertices,
    count,
    areaM2,
    areaHa,
    min,
    max,
    mean,
    stdDev,
    q25,
    q50,
    q75,
    ndviMean: specValid ? ndviSum / specValid : 0,
    ndbiMean: specValid ? ndbiSum / specValid : 0,
    vegPct: specValid ? (vegCount / specValid) * 100 : 0,
    builtPct: specValid ? (builtCount / specValid) * 100 : 0,
    uhiCounts,
    uhiPcts: uhiCounts.map((c) => (c / count) * 100),
    previewDataUrl: previewCanvas.toDataURL('image/png'),
    clipWidth,
    clipHeight,
    clippedFloat32,
    clipOrigin,
  };
}

export function AoiToolbar({
  active,
  shapeMode,
  vertexCount,
  hasAnchor,
  hasStats,
  onSelectShape,
  onFinishPolygon,
  onOpenPopup,
  onClear,
}: {
  active: boolean;
  shapeMode: AoiShapeMode;
  vertexCount: number;
  hasAnchor: boolean;
  hasStats: boolean;
  onSelectShape: (mode: AoiShapeMode) => void;
  onFinishPolygon: () => void;
  onOpenPopup: () => void;
  onClear: () => void;
}) {
  if (!active && vertexCount < 3) return null;

  const shapes: { id: AoiShapeMode; icon: string; label: string }[] = [
    { id: 'rectangle', icon: '▭', label: 'Retângulo' },
    { id: 'square', icon: '◻', label: 'Quadrado' },
    { id: 'circle', icon: '◯', label: 'Círculo' },
    { id: 'polygon', icon: '⬠', label: 'Polígono' },
  ];

  const hintText = !active
    ? 'AOI pronta · Clique em Ver Pop-up da AOI ou desenhe outra forma'
    : shapeMode === 'polygon'
      ? `Polígono: clique nos pontos do mapa (${vertexCount} pts) e clique em ✓ Concluir`
      : hasAnchor
        ? 'Mova o mouse e clique no 2º ponto para fechar a forma e abrir a análise'
        : `Modo ${shapes.find((s) => s.id === shapeMode)?.label}: clique no 1º ponto no mapa`;

  return (
    <div
      style={{
        position: 'absolute',
        bottom: '22px',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 9,
        background: 'rgba(7, 19, 23, 0.95)',
        border: '1.5px solid #ffb000',
        borderRadius: '14px',
        padding: '10px 14px',
        boxShadow: '0 12px 32px rgba(0,0,0,0.55)',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        minWidth: '340px',
        maxWidth: '92vw',
        backdropFilter: 'blur(8px)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '11px', fontWeight: 800, color: '#ffb000', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          ⌗ Ferramenta AOI · Escolha o formato:
        </span>
        <span style={{ fontSize: '11px', color: '#9cddda' }}>{hintText}</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
        {shapes.map((s) => {
          const isSelected = active && shapeMode === s.id;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => onSelectShape(s.id)}
              style={{
                padding: '6px 12px',
                borderRadius: '8px',
                border: isSelected ? '1.5px solid #ffb000' : '1px solid rgba(121,226,220,0.28)',
                background: isSelected ? 'rgba(255, 176, 0, 0.22)' : 'rgba(255,255,255,0.05)',
                color: isSelected ? '#ffd166' : '#e2f1f0',
                fontWeight: 700,
                fontSize: '12px',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              <span style={{ fontSize: '14px' }}>{s.icon}</span>
              <span>{s.label}</span>
            </button>
          );
        })}

        {active && shapeMode === 'polygon' && vertexCount >= 3 && (
          <button
            type="button"
            onClick={onFinishPolygon}
            style={{
              padding: '6px 12px',
              borderRadius: '8px',
              border: '1.5px solid #34d399',
              background: 'rgba(52, 211, 153, 0.2)',
              color: '#6ee7b7',
              fontWeight: 800,
              fontSize: '12px',
              cursor: 'pointer',
            }}
          >
            ✓ Concluir e Analisar
          </button>
        )}

        {(vertexCount >= 3 || hasStats) && (
          <button
            type="button"
            onClick={onOpenPopup}
            style={{
              padding: '6px 12px',
              borderRadius: '8px',
              border: '1.5px solid #38bdf8',
              background: 'rgba(56, 189, 248, 0.22)',
              color: '#bae6fd',
              fontWeight: 800,
              fontSize: '12px',
              cursor: 'pointer',
            }}
          >
            📊 Abrir Pop-up AOI
          </button>
        )}

        <button
          type="button"
          onClick={onClear}
          style={{
            padding: '6px 10px',
            borderRadius: '8px',
            border: '1px solid rgba(244, 63, 94, 0.45)',
            background: 'rgba(244, 63, 94, 0.15)',
            color: '#fda4af',
            fontWeight: 700,
            fontSize: '12px',
            cursor: 'pointer',
            marginLeft: 'auto',
          }}
        >
          ✕ Limpar
        </button>
      </div>
    </div>
  );
}

export function AoiAnalysisModal({
  open,
  stats,
  raster,
  onClose,
}: {
  open: boolean;
  stats: AoiDetailedStats | null;
  raster: AoiRasterSource | null;
  onClose: () => void;
}) {
  if (!open || !stats || !raster) return null;

  const shapeLabel: Record<AoiShapeMode, string> = {
    rectangle: 'Retângulo',
    square: 'Quadrado',
    circle: 'Círculo',
    polygon: 'Polígono Livre',
  };

  const uhiLabels = [
    { name: 'Ilha de Frescor (< -0,95σ)', color: '#38bdf8' },
    { name: 'Zona Amenizada (-0,95 a -0,30σ)', color: '#34d399' },
    { name: 'Zona Neutra (-0,30 a +0,25σ)', color: '#a3e635' },
    { name: 'UHI Moderada (+0,25 a +0,85σ)', color: '#facc15' },
    { name: 'UHI Forte (+0,85 a +1,40σ)', color: '#fb923c' },
    { name: 'Hotspot Extremo (> +1,40σ)', color: '#f43f5e' },
  ];

  const downloadAoiCardPng = async () => {
    const img = new Image();
    img.src = stats.previewDataUrl;
    await new Promise<void>((res) => {
      img.onload = () => res();
      img.onerror = () => res();
    });

    const w = Math.max(680, img.width + 60);
    const imgDrawH = Math.min(540, Math.max(260, Math.round(((w - 60) * img.height) / Math.max(1, img.width))));
    const imgDrawW = Math.round((imgDrawH * img.width) / Math.max(1, img.height));
    const footerH = 230;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = imgDrawH + footerH + 70;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.fillStyle = '#071317';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = '#ffb000';
    ctx.font = '700 20px Arial, sans-serif';
    ctx.fillText(`SR2D4 / LST EXPLORER · RECORTE AOI (${shapeLabel[stats.shapeMode].toUpperCase()})`, 28, 36);

    const imgX = Math.round((w - imgDrawW) / 2);
    ctx.drawImage(img, imgX, 52, imgDrawW, imgDrawH);
    ctx.strokeStyle = '#ffb000';
    ctx.lineWidth = 2;
    ctx.strokeRect(imgX, 52, imgDrawW, imgDrawH);

    const fy = imgDrawH + 68;
    ctx.fillStyle = '#0d1f26';
    ctx.fillRect(24, fy, w - 48, footerH - 16);
    ctx.strokeStyle = 'rgba(121,226,220,0.45)';
    ctx.strokeRect(24, fy, w - 48, footerH - 16);

    ctx.fillStyle = '#ffffff';
    ctx.font = '700 18px Arial, sans-serif';
    ctx.fillText(
      `Mín: ${stats.min.toFixed(1)} °C   |   Média: ${stats.mean.toFixed(2)} °C   |   Mediana: ${stats.q50.toFixed(2)} °C   |   Máx: ${stats.max.toFixed(1)} °C   |   σ = ${stats.stdDev.toFixed(2)} °C`,
      42,
      fy + 36,
    );

    ctx.fillStyle = '#9cddda';
    ctx.font = '600 15px Arial, sans-serif';
    ctx.fillText(
      `Área útil: ${stats.areaHa.toFixed(2)} ha (${stats.areaM2.toFixed(0)} m² · ${stats.count.toLocaleString('pt-BR')} px) · Q25: ${stats.q25.toFixed(1)} °C · Q75: ${stats.q75.toFixed(1)} °C`,
      42,
      fy + 68,
    );
    ctx.fillText(
      `Índices Espectrais na AOI: NDVI médio = ${stats.ndviMean.toFixed(3)} (Veg: ${stats.vegPct.toFixed(1)}%) · NDBI médio = ${stats.ndbiMean.toFixed(3)} (Construído: ${stats.builtPct.toFixed(1)}%)`,
      42,
      fy + 96,
    );

    const grad = ctx.createLinearGradient(42, fy + 116, w - 42, fy + 116);
    grad.addColorStop(0, '#061342');
    grad.addColorStop(0.25, '#186d8a');
    grad.addColorStop(0.5, '#961774');
    grad.addColorStop(0.75, '#f26d18');
    grad.addColorStop(1, '#ffca28');
    ctx.fillStyle = grad;
    ctx.fillRect(42, fy + 116, w - 84, 24);
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.strokeRect(42, fy + 116, w - 84, 24);

    ctx.fillStyle = '#ffffff';
    ctx.font = '700 14px Arial, sans-serif';
    ctx.fillText(`${stats.min.toFixed(1)} °C`, 42, fy + 162);
    ctx.textAlign = 'center';
    ctx.fillText(`Média AOI: ${stats.mean.toFixed(2)} °C`, w / 2, fy + 162);
    ctx.textAlign = 'right';
    ctx.fillText(`${stats.max.toFixed(1)} °C`, w - 42, fy + 162);
    ctx.textAlign = 'left';

    ctx.fillStyle = '#8fa9b0';
    ctx.font = '13px Arial, sans-serif';
    ctx.fillText(`Fonte: ${raster.fileName} · EPSG:${raster.epsg}`, 42, fy + 192);

    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = `SR2D4-AOI-${stats.shapeMode}.png`;
    a.click();
  };

  const downloadAoiGeoTiff = () => {
    downloadFloat32Tiff(
      stats.clippedFloat32,
      stats.clipWidth,
      stats.clipHeight,
      `SR2D4-AOI-${stats.shapeMode}-LST.tif`,
      stats.clipOrigin,
      raster.resolution,
      raster.epsg,
      raster.isProjected,
    );
  };

  const downloadAoiGeoJson = () => {
    const closedRing = [...stats.vertices, stats.vertices[0]];
    const geojson = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {
            shapeMode: stats.shapeMode,
            pixelsValid: stats.count,
            areaM2: Number(stats.areaM2.toFixed(2)),
            areaHa: Number(stats.areaHa.toFixed(4)),
            lstMinC: Number(stats.min.toFixed(2)),
            lstMeanC: Number(stats.mean.toFixed(2)),
            lstMedianC: Number(stats.q50.toFixed(2)),
            lstMaxC: Number(stats.max.toFixed(2)),
            lstStdDevC: Number(stats.stdDev.toFixed(2)),
            lstQ25C: Number(stats.q25.toFixed(2)),
            lstQ75C: Number(stats.q75.toFixed(2)),
            ndviMean: Number(stats.ndviMean.toFixed(4)),
            ndbiMean: Number(stats.ndbiMean.toFixed(4)),
            vegetationPct: Number(stats.vegPct.toFixed(2)),
            builtUpPct: Number(stats.builtPct.toFixed(2)),
            uhiStrongExtremePct: Number((stats.uhiPcts[4] + stats.uhiPcts[5]).toFixed(2)),
            sourceFile: raster.fileName,
            epsg: raster.epsg,
          },
          geometry: {
            type: 'Polygon',
            coordinates: [closedRing],
          },
        },
      ],
    };
    const blob = new Blob([JSON.stringify(geojson, null, 2)], { type: 'application/geo+json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `SR2D4-AOI-${stats.shapeMode}.geojson`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const downloadAoiKml = () => {
    const closedRing = [...stats.vertices, stats.vertices[0]];
    const coords = closedRing.map(([lng, lat]) => `${lng},${lat},0`).join(' ');
    const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>SR2D4 AOI (${shapeLabel[stats.shapeMode]})</name>
    <Placemark>
      <name>AOI · Média ${stats.mean.toFixed(2)} °C (${stats.areaHa.toFixed(2)} ha)</name>
      <description>Mín: ${stats.min.toFixed(1)} °C | Média: ${stats.mean.toFixed(2)} °C | Mediana: ${stats.q50.toFixed(2)} °C | Máx: ${stats.max.toFixed(1)} °C | NDVI: ${stats.ndviMean.toFixed(3)} | NDBI: ${stats.ndbiMean.toFixed(3)}</description>
      <Style>
        <LineStyle><color>ff00b0ff</color><width>3</width></LineStyle>
        <PolyStyle><color>4400b0ff</color></PolyStyle>
      </Style>
      <Polygon><outerBoundaryIs><LinearRing><coordinates>${coords}</coordinates></LinearRing></outerBoundaryIs></Polygon>
    </Placemark>
  </Document>
</kml>`;
    const blob = new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `SR2D4-AOI-${stats.shapeMode}.kml`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const downloadAoiCsv = () => {
    const rows = [
      ['Parametro', 'Valor', 'Unidade'],
      ['Formato_AOI', shapeLabel[stats.shapeMode], 'geometria'],
      ['Pixels_Validos', String(stats.count), 'px'],
      ['Area_m2', stats.areaM2.toFixed(2), 'm2'],
      ['Area_ha', stats.areaHa.toFixed(4), 'ha'],
      ['LST_Minima', stats.min.toFixed(2), 'C'],
      ['LST_Q25', stats.q25.toFixed(2), 'C'],
      ['LST_Mediana_Q50', stats.q50.toFixed(2), 'C'],
      ['LST_Media', stats.mean.toFixed(2), 'C'],
      ['LST_Q75', stats.q75.toFixed(2), 'C'],
      ['LST_Maxima', stats.max.toFixed(2), 'C'],
      ['LST_Desvio_Padrao', stats.stdDev.toFixed(2), 'C'],
      ['NDVI_Medio', stats.ndviMean.toFixed(4), 'indice'],
      ['NDBI_Medio', stats.ndbiMean.toFixed(4), 'indice'],
      ['Vegetacao_NDVI_gt_0_3', stats.vegPct.toFixed(2), '%'],
      ['Construido_NDBI_gt_0_1', stats.builtPct.toFixed(2), '%'],
      ['UHI_Forte_Mais_Extrema', (stats.uhiPcts[4] + stats.uhiPcts[5]).toFixed(2), '%'],
    ];
    const csv = rows.map((r) => r.join(';')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `SR2D4-AOI-${stats.shapeMode}-estatisticas.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div
      className="dialog-backdrop"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(3, 10, 14, 0.78)',
        backdropFilter: 'blur(6px)',
        zIndex: 9999,
        display: 'grid',
        placeItems: 'center',
        padding: '20px',
      }}
    >
      <div
        className="dialog-card"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(960px, 96vw)',
          maxHeight: '90vh',
          overflowY: 'auto',
          background: '#0b1b22',
          border: '1.5px solid rgba(255, 176, 0, 0.55)',
          borderRadius: '18px',
          padding: '24px',
          color: '#e8f4f2',
          boxShadow: '0 24px 60px rgba(0,0,0,0.65)',
          position: 'relative',
        }}
      >
        <button
          type="button"
          onClick={onClose}
          style={{
            position: 'absolute',
            top: '16px',
            right: '16px',
            width: '34px',
            height: '34px',
            borderRadius: '50%',
            border: '1px solid rgba(255,255,255,0.2)',
            background: 'rgba(255,255,255,0.08)',
            color: '#fff',
            fontSize: '18px',
            cursor: 'pointer',
          }}
        >
          ×
        </button>

        <div style={{ fontSize: '11px', fontWeight: 800, color: '#ffb000', letterSpacing: '0.14em', textTransform: 'uppercase' }}>
          ⌗ Diagnóstico Espacial Recortado · Área de Interesse (AOI)
        </div>
        <h2 style={{ margin: '6px 0 4px', fontSize: '24px', color: '#fff' }}>
          Análise da AOI · {shapeLabel[stats.shapeMode]}
        </h2>
        <p style={{ margin: '0 0 18px', fontSize: '13px', color: '#9ab0b5' }}>
          Área útil: <b>{stats.areaHa.toFixed(2)} ha</b> ({stats.areaM2.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} m²) ·{' '}
          <b>{stats.count.toLocaleString('pt-BR')}</b> píxeis analisados no raster numérico · EPSG:{raster.epsg}
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '18px' }}>
          {/* Coluna Esquerda: Preview Visual */}
          <div
            style={{
              background: '#071317',
              border: '1px solid rgba(121,226,220,0.22)',
              borderRadius: '12px',
              padding: '12px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <img
              src={stats.previewDataUrl}
              alt="Recorte da Área de Interesse"
              style={{
                maxWidth: '100%',
                maxHeight: '300px',
                objectFit: 'contain',
                borderRadius: '8px',
                border: '1px solid rgba(255,176,0,0.4)',
              }}
            />
            <small style={{ marginTop: '8px', color: '#9cddda', fontSize: '11px' }}>
              Janela recortada: {stats.clipWidth} × {stats.clipHeight} px · Contorno amarelo = limite da AOI
            </small>
          </div>

          {/* Coluna Direita: Estatísticas e Classes UHI */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px' }}>
              <div style={{ background: 'rgba(255,255,255,0.04)', padding: '10px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.08)' }}>
                <small style={{ color: '#9ab0b5', fontSize: '11px', display: 'block' }}>Mínima AOI</small>
                <strong style={{ fontSize: '18px', color: '#38bdf8' }}>{stats.min.toFixed(1)} °C</strong>
              </div>
              <div style={{ background: 'rgba(255,255,255,0.04)', padding: '10px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.08)' }}>
                <small style={{ color: '#9ab0b5', fontSize: '11px', display: 'block' }}>Média AOI (μ)</small>
                <strong style={{ fontSize: '18px', color: '#ffb000' }}>{stats.mean.toFixed(2)} °C</strong>
              </div>
              <div style={{ background: 'rgba(255,255,255,0.04)', padding: '10px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.08)' }}>
                <small style={{ color: '#9ab0b5', fontSize: '11px', display: 'block' }}>Máxima AOI</small>
                <strong style={{ fontSize: '18px', color: '#f43f5e' }}>{stats.max.toFixed(1)} °C</strong>
              </div>
              <div style={{ background: 'rgba(255,255,255,0.04)', padding: '10px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.08)' }}>
                <small style={{ color: '#9ab0b5', fontSize: '11px', display: 'block' }}>Mediana (Q50)</small>
                <strong style={{ fontSize: '16px' }}>{stats.q50.toFixed(2)} °C</strong>
              </div>
              <div style={{ background: 'rgba(255,255,255,0.04)', padding: '10px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.08)' }}>
                <small style={{ color: '#9ab0b5', fontSize: '11px', display: 'block' }}>Quartis Q25–Q75</small>
                <strong style={{ fontSize: '15px' }}>{stats.q25.toFixed(1)}–{stats.q75.toFixed(1)} °C</strong>
              </div>
              <div style={{ background: 'rgba(255,255,255,0.04)', padding: '10px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.08)' }}>
                <small style={{ color: '#9ab0b5', fontSize: '11px', display: 'block' }}>Desvio (σ)</small>
                <strong style={{ fontSize: '16px' }}>±{stats.stdDev.toFixed(2)} °C</strong>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
              <div style={{ background: 'rgba(52,211,153,0.1)', padding: '9px 12px', borderRadius: '8px', border: '1px solid rgba(52,211,153,0.3)', fontSize: '12px' }}>
                🌿 <b>NDVI médio: {stats.ndviMean.toFixed(3)}</b> · Vegetação: <b>{stats.vegPct.toFixed(1)}%</b>
              </div>
              <div style={{ background: 'rgba(251,146,60,0.1)', padding: '9px 12px', borderRadius: '8px', border: '1px solid rgba(251,146,60,0.3)', fontSize: '12px' }}>
                🏢 <b>NDBI médio: {stats.ndbiMean.toFixed(3)}</b> · Construído: <b>{stats.builtPct.toFixed(1)}%</b>
              </div>
            </div>

            <div style={{ background: 'rgba(0,0,0,0.25)', padding: '10px 12px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.07)' }}>
              <b style={{ fontSize: '11px', display: 'block', marginBottom: '6px', color: '#9cddda' }}>
                DISTRIBUIÇÃO DE ILHAS DE CALOR (UHI) DENTRO DA AOI:
              </b>
              {uhiLabels.map((u, idx) => (
                <div key={u.name} style={{ marginBottom: '5px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px' }}>
                    <span>{u.name}</span>
                    <b>{stats.uhiPcts[idx].toFixed(1)}% ({stats.uhiCounts[idx].toLocaleString('pt-BR')} px)</b>
                  </div>
                  <div style={{ height: '6px', background: 'rgba(255,255,255,0.08)', borderRadius: '4px', overflow: 'hidden', marginTop: '2px' }}>
                    <div style={{ width: `${Math.max(1, stats.uhiPcts[idx])}%`, height: '100%', background: u.color }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Barra de Exportação Direta no Pop-up */}
        <div
          style={{
            marginTop: '20px',
            paddingTop: '16px',
            borderTop: '1px solid rgba(121,226,220,0.2)',
            display: 'flex',
            flexWrap: 'wrap',
            gap: '10px',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span style={{ fontSize: '12px', fontWeight: 700, color: '#ffb000' }}>
            ⇩ Exportar recorte e dados desta AOI:
          </span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
            <button
              type="button"
              onClick={() => void downloadAoiCardPng()}
              style={{
                padding: '9px 14px',
                borderRadius: '8px',
                border: '1px solid #ffb000',
                background: '#ffb000',
                color: '#071317',
                fontWeight: 800,
                fontSize: '12px',
                cursor: 'pointer',
              }}
            >
              🖼 Exportar PNG (com legenda)
            </button>
            <button
              type="button"
              onClick={downloadAoiGeoTiff}
              style={{
                padding: '9px 14px',
                borderRadius: '8px',
                border: '1px solid #79e2dc',
                background: 'rgba(121,226,220,0.16)',
                color: '#79e2dc',
                fontWeight: 700,
                fontSize: '12px',
                cursor: 'pointer',
              }}
            >
              🗺 Exportar GeoTIFF (LST)
            </button>
            <button
              type="button"
              onClick={downloadAoiGeoJson}
              style={{
                padding: '9px 14px',
                borderRadius: '8px',
                border: '1px solid rgba(255,255,255,0.25)',
                background: 'rgba(255,255,255,0.08)',
                color: '#fff',
                fontWeight: 700,
                fontSize: '12px',
                cursor: 'pointer',
              }}
            >
              📐 Exportar GeoJSON
            </button>
            <button
              type="button"
              onClick={downloadAoiKml}
              style={{
                padding: '9px 14px',
                borderRadius: '8px',
                border: '1px solid rgba(255,255,255,0.25)',
                background: 'rgba(255,255,255,0.08)',
                color: '#fff',
                fontWeight: 700,
                fontSize: '12px',
                cursor: 'pointer',
              }}
            >
              🌍 Exportar KML
            </button>
            <button
              type="button"
              onClick={downloadAoiCsv}
              style={{
                padding: '9px 14px',
                borderRadius: '8px',
                border: '1px solid rgba(255,255,255,0.25)',
                background: 'rgba(255,255,255,0.08)',
                color: '#fff',
                fontWeight: 700,
                fontSize: '12px',
                cursor: 'pointer',
              }}
            >
              📊 Exportar CSV
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
