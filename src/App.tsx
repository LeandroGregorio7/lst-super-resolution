import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { calculateOpticalIndices } from './opticalIndices';
import { downscaleLandsatLST } from './downscaling';
import { fetchNearestLandsatThermal, type ThermalProgress } from './landsatAuto';
import { readTiffPixels } from './tiffReader';
import { renderRGBBasemapToCanvas, type PaletteType } from './colorMapper';
import { downloadFloat32Tiff, downloadUhiTiff } from './exportTiff';
import { boundsExtent, rasterBoundsToWgs84, type RasterBounds } from './rasterGeo';
import { buildUhiSurface, downloadUhiSurface, type UhiSurface } from './uhiSurface';
export interface StationPoint {
  id: string;
  name: string;
  source: string;
  lng: number;
  lat: number;
  dateIso: string;
  overpassTime: string;
  stationTempC: number;
  humidityPct: number;
  pixel1mC: number;
  radiusMeanC: number;
  radiusMedianC: number;
  radiusStdC: number;
  radiusMinC: number;
  radiusMaxC: number;
  pixelCount: number;
  ndviMean: number;
  ndbiMean: number;
  deltaRadiusC: number;
  deltaPixel1mC: number;
  proximityStatus: string;
  proximityColor: string;
}

export const STATION_AND_MAP_UI_CSS = `
  .map-search, .map-legend {
    background: rgba(7, 19, 23, 0.55) !important;
    backdrop-filter: blur(8px) !important;
    -webkit-backdrop-filter: blur(8px) !important;
    border: 1px solid rgba(121, 226, 220, 0.32) !important;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35) !important;
  }
  .map-legend {
    pointer-events: auto !important;
  }
  .station-modern-marker {
    display: flex;
    flex-direction: column;
    align-items: center;
    cursor: pointer;
    user-select: none;
    transition: transform 0.18s ease;
  }
  .station-modern-marker:hover {
    transform: scale(1.16);
    z-index: 30;
  }
  .station-badge-label {
    margin-top: 3px;
    padding: 2px 6px;
    border-radius: 5px;
    background: rgba(7, 19, 23, 0.85);
    border: 1px solid rgba(56, 189, 248, 0.65);
    color: #e8f4f2;
    font: 700 10px/1.2 Inter, system-ui, sans-serif;
    white-space: nowrap;
    box-shadow: 0 2px 8px rgba(0,0,0,0.5);
  }
  .station-map-popup .maplibregl-popup-content {
    background: rgba(8, 22, 28, 0.94) !important;
    backdrop-filter: blur(10px) !important;
    border: 1.5px solid #38bdf8 !important;
    border-radius: 12px !important;
    padding: 12px 14px !important;
    color: #e8f4f2 !important;
    box-shadow: 0 14px 34px rgba(0, 0, 0, 0.65) !important;
    min-width: 265px !important;
  }
  .station-map-popup .maplibregl-popup-tip {
    border-top-color: #38bdf8 !important;
  }
  .station-popup-close-btn {
    background: rgba(244, 63, 94, 0.22);
    border: 1px solid #f43f5e;
    color: #fda4af;
    border-radius: 6px;
    width: 24px;
    height: 24px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    font-weight: 800;
    cursor: pointer;
    line-height: 1;
    padding: 0;
    flex-shrink: 0;
    transition: background 0.15s ease, color 0.15s ease;
  }
  .station-popup-close-btn:hover {
    background: #f43f5e;
    color: #ffffff;
  }
`;

function classifyStationMeta(source: string, name: string): {
  sector: 'Governamental / Oficial' | 'Privada / Ciência Cidadã';
  stationType: string;
} {
  const s = `${source} ${name}`.toLowerCase();
  if (s.includes('oficial') || s.includes('metar') || s.includes('aero') || s.includes('inmet')) {
    return {
      sector: 'Governamental / Oficial',
      stationType: s.includes('metar') || s.includes('aero') ? 'EMA Aeronáutica (METAR)' : 'Estação Meteorológica Automática (EMA)',
    };
  }
  if (s.includes('cidad') || s.includes('opensense') || s.includes('pws')) {
    return {
      sector: 'Privada / Ciência Cidadã',
      stationType: 'Estação PWS / IoT (OpenSenseMap)',
    };
  }
  return {
    sector: 'Governamental / Oficial',
    stationType: 'Estação Sinótica de Referência (OMM 2m)',
  };
}

export function StationValidationDock({
  open,
  visibleOnMap,
  stations,
  stationRadiusM,
  onChangeRadius,
  onClose,
  onDownloadCsv,
  map,
  rasterMin,
  rasterMax,
}: {
  open: boolean;
  visibleOnMap: boolean;
  stations: StationPoint[];
  stationRadiusM: number;
  onChangeRadius: (r: number) => void;
  onClose: () => void;
  onDownloadCsv: () => void;
  map: MapLibreMap | null;
  rasterMin: number;
  rasterMax: number;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const activePopupRef = useRef<maplibregl.Popup | null>(null);

  useEffect(() => {
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];
    activePopupRef.current?.remove();
    activePopupRef.current = null;

    if (!map || !visibleOnMap || stations.length === 0) return;

    stations.forEach((st, idx) => {
      const meta = classifyStationMeta(st.source, st.name);
      const isGov = meta.sector.startsWith('Governamental');
      const badgeColor = isGov ? '#38bdf8' : '#a855f7';

      const el = document.createElement('div');
      el.className = 'station-modern-marker';
      el.innerHTML = `
        <svg width="34" height="34" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="18" cy="18" r="16" fill="#071317" fill-opacity="0.88" stroke="${st.proximityColor}" stroke-width="2.5"/>
          <path d="M11 13C14.8 9.2 21.2 9.2 25 13" stroke="${badgeColor}" stroke-width="1.8" stroke-linecap="round"/>
          <path d="M13.8 15.8C16.1 13.5 19.9 13.5 22.2 15.8" stroke="${badgeColor}" stroke-width="1.8" stroke-linecap="round"/>
          <circle cx="18" cy="18.5" r="2.6" fill="#ffb000"/>
          <path d="M18 21V27M14 27H22" stroke="#ffffff" stroke-width="2" stroke-linecap="round"/>
        </svg>
        <span class="station-badge-label">#${idx + 1} ${st.name} · ${st.stationTempC.toFixed(1)}°C</span>
      `;

      const showPopup = () => {
        activePopupRef.current?.remove();
        const popupNode = document.createElement('div');
        popupNode.style.cssText = 'font-family:Inter,system-ui,sans-serif;font-size:12px;line-height:1.45';
        popupNode.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px">
            <span style="background:${badgeColor}22;color:${badgeColor};border:1px solid ${badgeColor};padding:2px 7px;border-radius:99px;font-size:10px;font-weight:800">
              ${meta.sector.toUpperCase()}
            </span>
            <span style="color:#9cddda;font-size:10px;font-weight:700;margin-left:auto">${st.dateIso} · ${st.overpassTime}</span>
            <button type="button" class="station-popup-close-btn" title="Fechar pop-up da estação" aria-label="Fechar">✕</button>
          </div>
          <strong style="font-size:14px;color:#fff;display:block;margin-bottom:2px">📡 ${st.name}</strong>
          <div style="color:#9ab0b5;font-size:11px;margin-bottom:8px">Tipo: <b>${meta.stationType}</b></div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;background:rgba(255,255,255,0.05);padding:8px;border-radius:8px;margin-bottom:8px">
            <div><small style="color:#9ab0b5;display:block;font-size:10px">Estação (Ar 2m)</small><b style="color:#38bdf8;font-size:14px">${st.stationTempC.toFixed(2)} °C</b></div>
            <div><small style="color:#9ab0b5;display:block;font-size:10px">LST Raio ${stationRadiusM}m</small><b style="color:#ffb000;font-size:14px">${st.radiusMeanC.toFixed(2)} °C</b></div>
            <div><small style="color:#9ab0b5;display:block;font-size:10px">Erro / ΔT (LST − Ta)</small><b style="color:${st.proximityColor};font-size:13px">${st.deltaRadiusC >= 0 ? '+' : ''}${st.deltaRadiusC.toFixed(2)} °C</b></div>
            <div><small style="color:#9ab0b5;display:block;font-size:10px">Desvio Espacial (σ)</small><b style="color:#fff;font-size:13px">±${st.radiusStdC.toFixed(2)} °C</b></div>
          </div>
          <div style="font-size:11px;color:${st.proximityColor};font-weight:700">${st.proximityStatus}</div>
        `;

        const closeBtn = popupNode.querySelector('.station-popup-close-btn');
        closeBtn?.addEventListener('click', (ev) => {
          ev.stopPropagation();
          activePopupRef.current?.remove();
          activePopupRef.current = null;
        });

        activePopupRef.current = new maplibregl.Popup({
          closeButton: false,
          closeOnClick: true,
          offset: 20,
          className: 'station-map-popup',
        })
          .setLngLat([st.lng, st.lat])
          .setDOMContent(popupNode)
          .addTo(map);
      };

      el.addEventListener('click', (e) => {
        e.stopPropagation();
        showPopup();
        map.flyTo({ center: [st.lng, st.lat], zoom: Math.max(map.getZoom(), 14), duration: 650 });
      });

      const marker = new maplibregl.Marker({ element: el, anchor: 'bottom' })
        .setLngLat([st.lng, st.lat])
        .addTo(map);
      markersRef.current.push(marker);
    });

    return () => {
      activePopupRef.current?.remove();
      activePopupRef.current = null;
      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];
    };
  }, [map, visibleOnMap, stations, stationRadiusM]);

  useEffect(() => {
    if (!map || !open || stations.length === 0) return;
    const timer = window.setTimeout(() => {
      map.resize();
      let w = Infinity; let e = -Infinity; let s = Infinity; let n = -Infinity;
      for (const pt of stations) {
        if (pt.lng < w) w = pt.lng;
        if (pt.lng > e) e = pt.lng;
        if (pt.lat < s) s = pt.lat;
        if (pt.lat > n) n = pt.lat;
      }
      if (Number.isFinite(w) && Number.isFinite(e)) {
        map.fitBounds(
          [[w - 0.006, s - 0.006], [e + 0.006, n + 0.006]],
          {
            padding: { top: 70, bottom: 70, left: 60, right: collapsed ? 70 : 420 },
            duration: 700,
            maxZoom: 14.5,
          },
        );
      }
    }, 120);
    return () => window.clearTimeout(timer);
  }, [open, collapsed, stations, map]);

  if (!open || stations.length === 0) return null;

  const n = stations.length;
  const maeRadius = stations.reduce((acc, s) => acc + Math.abs(s.deltaRadiusC), 0) / n;
  const mae1m = stations.reduce((acc, s) => acc + Math.abs(s.deltaPixel1mC), 0) / n;
  const rmseRadius = Math.sqrt(stations.reduce((acc, s) => acc + s.deltaRadiusC ** 2, 0) / n);
  const biasRadius = stations.reduce((acc, s) => acc + s.deltaRadiusC, 0) / n;

  const downloadChartPng = () => {
    const rowH = 92;
    const headH = 195;
    const w = 980;
    const h = headH + stations.length * rowH + 40;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.fillStyle = '#071317';
    ctx.fillRect(0, 0, w, h);

    ctx.fillStyle = '#38bdf8';
    ctx.font = '700 13px Arial';
    ctx.fillText('📡 SR2D4 / LST EXPLORER · VALIDAÇÃO EM TERRA (ACOPLAMENTO SUPERFÍCIE-ATMOSFERA)', 28, 34);

    ctx.fillStyle = '#ffffff';
    ctx.font = '700 22px Arial';
    ctx.fillText(`Comparativo Térmico: Satélite (Raio ${stationRadiusM}m) vs. Estações em Terra (Ta 2m)`, 28, 64);

    ctx.fillStyle = '#9cddda';
    ctx.font = '14px Arial';
    ctx.fillText(
      `Passagem: ${stations[0].dateIso} às ${stations[0].overpassTime}   |   MAE (${stationRadiusM}m): ${maeRadius.toFixed(2)} °C   |   RMSE: ${rmseRadius.toFixed(2)} °C   |   Offset (LST − Ta): ${biasRadius >= 0 ? '+' : ''}${biasRadius.toFixed(2)} °C`,
      28,
      92,
    );

    ctx.fillStyle = '#38bdf8'; ctx.fillRect(28, 114, 14, 14);
    ctx.fillStyle = '#e8f4f2'; ctx.font = '700 13px Arial'; ctx.fillText('Estação em Terra (Ta 2m)', 48, 126);
    ctx.fillStyle = '#ffb000'; ctx.fillRect(250, 114, 14, 14);
    ctx.fillStyle = '#e8f4f2'; ctx.fillText(`LST Média no Raio ${stationRadiusM}m (com faixa ±1σ)`, 270, 126);
    ctx.fillStyle = '#f43f5e'; ctx.fillRect(590, 114, 14, 14);
    ctx.fillStyle = '#e8f4f2'; ctx.fillText('LST Pixel Central 1m', 610, 126);

    const scaleMin = Math.min(14, rasterMin) - 2;
    const scaleMax = Math.max(40, rasterMax) + 2;
    const toW = (val: number) => Math.max(10, Math.min(540, ((val - scaleMin) / (scaleMax - scaleMin)) * 540));

    stations.forEach((st, i) => {
      const y = headH + i * rowH;
      const meta = classifyStationMeta(st.source, st.name);

      ctx.fillStyle = 'rgba(255,255,255,0.04)';
      ctx.fillRect(24, y - 22, w - 48, rowH - 10);

      ctx.fillStyle = '#ffffff';
      ctx.font = '700 15px Arial';
      ctx.fillText(`#${i + 1} ${st.name} (${meta.sector} · ${meta.stationType})`, 36, y);

      ctx.fillStyle = st.proximityColor;
      ctx.font = '700 13px Arial';
      ctx.textAlign = 'right';
      ctx.fillText(`Erro ΔT: ${st.deltaRadiusC >= 0 ? '+' : ''}${st.deltaRadiusC.toFixed(2)} °C (σ = ±${st.radiusStdC.toFixed(2)}°C) · ${st.proximityStatus}`, w - 36, y);
      ctx.textAlign = 'left';

      ctx.fillStyle = '#9ab0b5'; ctx.font = '12px Arial'; ctx.fillText('Estação 2m:', 36, y + 22);
      ctx.fillStyle = '#38bdf8'; ctx.fillRect(135, y + 12, toW(st.stationTempC), 10);
      ctx.fillStyle = '#fff'; ctx.font = '700 12px Arial'; ctx.fillText(`${st.stationTempC.toFixed(1)} °C`, 145 + toW(st.stationTempC), y + 22);

      ctx.fillStyle = '#9ab0b5'; ctx.font = '12px Arial'; ctx.fillText(`LST Raio ${stationRadiusM}m:`, 36, y + 40);
      ctx.fillStyle = '#ffb000'; ctx.fillRect(135, y + 30, toW(st.radiusMeanC), 10);
      ctx.fillStyle = '#fff'; ctx.font = '700 12px Arial'; ctx.fillText(`${st.radiusMeanC.toFixed(1)} °C`, 145 + toW(st.radiusMeanC), y + 40);

      ctx.fillStyle = '#9ab0b5'; ctx.font = '12px Arial'; ctx.fillText('LST Pixel 1m:', 36, y + 56);
      ctx.fillStyle = '#f43f5e'; ctx.fillRect(135, y + 47, toW(st.pixel1mC), 8);
      ctx.fillStyle = '#fff'; ctx.font = '700 12px Arial'; ctx.fillText(`${st.pixel1mC.toFixed(1)} °C`, 145 + toW(st.pixel1mC), y + 56);
    });

    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = `SR2D4-Grafico-Validacao-Estacoes-${stationRadiusM}m.png`;
    a.click();
  };

  return (
    <aside
      style={{
        position: 'absolute',
        top: '12px',
        right: '54px',
        bottom: '12px',
        width: collapsed ? '46px' : 'min(410px, 44vw)',
        zIndex: 22,
        background: 'rgba(8, 20, 26, 0.90)',
        backdropFilter: 'blur(12px)',
        border: '1.5px solid rgba(56, 189, 248, 0.55)',
        borderRadius: '16px',
        boxShadow: '0 16px 40px rgba(0,0,0,0.6)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        transition: 'width 0.22s ease',
        color: '#e8f4f2',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', borderBottom: '1px solid rgba(121,226,220,0.18)', background: 'rgba(5,14,18,0.65)' }}>
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          title={collapsed ? 'Expandir Docker de Estações' : 'Recolher Docker para ver mais mapa'}
          style={{ background: 'rgba(56,189,248,0.18)', border: '1px solid #38bdf8', color: '#fff', borderRadius: '8px', padding: '4px 8px', cursor: 'pointer', fontWeight: 800, fontSize: '12px' }}
        >
          {collapsed ? '◀' : '▶'}
        </button>
        {!collapsed && (
          <>
            <div style={{ flex: 1, marginLeft: '10px' }}>
              <div style={{ fontSize: '10px', fontWeight: 800, color: '#38bdf8', letterSpacing: '0.08em' }}>DOCKER DE VALIDAÇÃO EM TERRA</div>
              <strong style={{ fontSize: '13px', color: '#fff' }}>Satélite (LST) vs. Estações ({stations.length})</strong>
            </div>
            <button
              type="button"
              onClick={onClose}
              title="Fechar Docker"
              style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.2)', color: '#fff', borderRadius: '8px', width: '28px', height: '28px', cursor: 'pointer', fontWeight: 800 }}
            >
              ×
            </button>
          </>
        )}
      </div>

      {!collapsed && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ background: 'rgba(255,255,255,0.04)', padding: '9px 10px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.08)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '11px', marginBottom: '6px' }}>
              <b style={{ color: '#ffb000' }}>Raio de Representatividade (R):</b>
              <span style={{ color: '#9cddda' }}>{stations[0].dateIso} · {stations[0].overpassTime}</span>
            </div>
            <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap', marginBottom: '8px' }}>
              {[30, 50, 100, 250, 500].map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => onChangeRadius(r)}
                  style={{ flex: 1, padding: '5px 6px', borderRadius: '6px', border: stationRadiusM === r ? '1.5px solid #38bdf8' : '1px solid rgba(255,255,255,0.18)', background: stationRadiusM === r ? 'rgba(56,189,248,0.25)' : 'transparent', color: '#fff', fontWeight: 700, fontSize: '11px', cursor: 'pointer' }}
                >
                  {r}m
                </button>
              ))}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
              <button
                type="button"
                onClick={downloadChartPng}
                style={{ padding: '7px 10px', borderRadius: '7px', background: '#ffb000', color: '#071317', fontWeight: 800, fontSize: '11px', border: 'none', cursor: 'pointer' }}
              >
                🖼 Exportar Gráfico PNG
              </button>
              <button
                type="button"
                onClick={onDownloadCsv}
                style={{ padding: '7px 10px', borderRadius: '7px', background: 'rgba(56,189,248,0.2)', color: '#79e2dc', fontWeight: 800, fontSize: '11px', border: '1px solid #38bdf8', cursor: 'pointer' }}
              >
                📊 Exportar Tabela CSV
              </button>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '7px' }}>
            <div style={{ background: 'rgba(255,255,255,0.04)', padding: '8px 10px', borderRadius: '8px' }}>
              <small style={{ color: '#9ab0b5', fontSize: '10px', display: 'block' }}>MAE no Raio ({stationRadiusM}m)</small>
              <strong style={{ fontSize: '17px', color: '#38bdf8' }}>{maeRadius.toFixed(2)} °C</strong>
              <small style={{ display: 'block', fontSize: '10px', color: '#9cddda' }}>Pixel 1m: {mae1m.toFixed(2)} °C</small>
            </div>
            <div style={{ background: 'rgba(255,255,255,0.04)', padding: '8px 10px', borderRadius: '8px' }}>
              <small style={{ color: '#9ab0b5', fontSize: '10px', display: 'block' }}>RMSE / Offset (LST − Ta)</small>
              <strong style={{ fontSize: '17px', color: '#fb923c' }}>{biasRadius >= 0 ? '+' : ''}{biasRadius.toFixed(2)} °C</strong>
              <small style={{ display: 'block', fontSize: '10px', color: '#9cddda' }}>RMSE: {rmseRadius.toFixed(2)} °C</small>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <small style={{ color: '#9cddda', fontSize: '11px' }}>
              💡 Clique no ícone da estação no mapa para abrir o pop-up (e clique no ✕ do pop-up ou no mapa para fechá-lo):
            </small>
            {stations.map((st, idx) => {
             