import { useEffect, useRef, useState } from 'react';
import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl';

export interface StationPoint {
  id: string; name: string; source: string; lng: number; lat: number;
  dateIso: string; overpassTime: string; stationTempC: number; humidityPct: number;
  pixel1mC: number; radiusMeanC: number; radiusMedianC: number; radiusStdC: number;
  radiusMinC: number; radiusMaxC: number; pixelCount: number;
  ndviMean: number; ndbiMean: number; deltaRadiusC: number; deltaPixel1mC: number;
  proximityStatus: string; proximityColor: string;
}

export const STATION_AND_MAP_UI_CSS = `
  .map-search, .map-legend { background: rgba(7,19,23,0.55) !important; backdrop-filter: blur(8px) !important; -webkit-backdrop-filter: blur(8px) !important; border: 1px solid rgba(121,226,220,0.32) !important; }
  .map-legend { pointer-events: auto !important; }
  .station-modern-marker { display: flex; flex-direction: column; align-items: center; cursor: pointer; user-select: none; transition: transform 0.18s ease; }
  .station-modern-marker:hover { transform: scale(1.15); z-index: 30; }
  .station-badge-label { margin-top: 2px; padding: 2px 6px; border-radius: 5px; background: rgba(7,19,23,0.88); border: 1px solid #38bdf8; color: #fff; font: 700 10px/1.2 Inter, sans-serif; white-space: nowrap; }
  .station-map-popup .maplibregl-popup-content { background: rgba(8,22,28,0.95) !important; border: 1.5px solid #38bdf8 !important; border-radius: 12px !important; padding: 12px !important; color: #fff !important; min-width: 255px !important; }
  .station-popup-close-btn { background: rgba(244,63,94,0.25); border: 1px solid #f43f5e; color: #fda4af; border-radius: 6px; width: 24px; height: 24px; font-weight: 800; cursor: pointer; }
`;

function classifyStation(source: string, name: string) {
  const s = `${source} ${name}`.toLowerCase();
  if (s.includes('oficial') || s.includes('metar') || s.includes('aero') || s.includes('inmet')) {
    return { sector: 'Governamental / Oficial', type: s.includes('metar') || s.includes('aero') ? 'EMA Aeronáutica (METAR)' : 'Estação Automática (EMA)' };
  }
  if (s.includes('cidad') || s.includes('opensense') || s.includes('pws')) return { sector: 'Privada / Cidadã', type: 'Estação PWS / IoT' };
  return { sector: 'Governamental / Oficial', type: 'Estação de Referência (OMM 2m)' };
}

export function StationValidationDock({
  open, visibleOnMap = true, stations, stationRadiusM, onChangeRadius, onClose, onDownloadCsv, map, rasterMin, rasterMax,
}: {
  open: boolean; visibleOnMap?: boolean; stations: StationPoint[]; stationRadiusM: number;
  onChangeRadius: (r: number) => void; onClose: () => void; onDownloadCsv: () => void;
  map: MapLibreMap | null; rasterMin: number; rasterMax: number;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const popupRef = useRef<maplibregl.Popup | null>(null);

  useEffect(() => {
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];
    popupRef.current?.remove();
    if (!map || !visibleOnMap || !stations.length) return;

    stations.forEach((st, idx) => {
      const meta = classifyStation(st.source, st.name);
      const col = meta.sector.startsWith('Gov') ? '#38bdf8' : '#a855f7';
      const el = document.createElement('div');
      el.className = 'station-modern-marker';
      el.innerHTML = `<svg width="32" height="32" viewBox="0 0 36 36" fill="none"><circle cx="18" cy="18" r="16" fill="#071317" stroke="${st.proximityColor}" stroke-width="2.5"/><path d="M11 13C14.8 9.2 21.2 9.2 25 13M13.8 15.8C16.1 13.5 19.9 13.5 22.2 15.8" stroke="${col}" stroke-width="1.8" stroke-linecap="round"/><circle cx="18" cy="18.5" r="2.5" fill="#ffb000"/><path d="M18 21V27M14 27H22" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg><span class="station-badge-label">#${idx + 1} ${st.name} · ${st.stationTempC.toFixed(1)}°C</span>`;

      el.addEventListener('click', (e) => {
        e.stopPropagation();
        popupRef.current?.remove();
        const node = document.createElement('div');
        node.style.cssText = 'font:12px/1.45 Inter,sans-serif';
        node.innerHTML = `<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px"><span style="background:${col}22;color:${col};border:1px solid ${col};padding:2px 6px;border-radius:99px;font-size:10px;font-weight:800">${meta.sector}</span><small style="color:#9cddda;margin-left:auto">${st.dateIso}</small><button type="button" class="station-popup-close-btn" title="Fechar">✕</button></div><strong style="font-size:14px">📡 ${st.name}</strong><div style="color:#9ab0b5;font-size:11px;margin-bottom:6px">Tipo: <b>${meta.type}</b></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;background:rgba(255,255,255,0.06);padding:7px;border-radius:8px;margin-bottom:6px"><div><small style="color:#9ab0b5;display:block;font-size:10px">Estação 2m</small><b style="color:#38bdf8">${st.stationTempC.toFixed(2)} °C</b></div><div><small style="color:#9ab0b5;display:block;font-size:10px">LST Raio ${stationRadiusM}m</small><b style="color:#ffb000">${st.radiusMeanC.toFixed(2)} °C</b></div><div><small style="color:#9ab0b5;display:block;font-size:10px">Erro ΔT</small><b style="color:${st.proximityColor}">${st.deltaRadiusC >= 0 ? '+' : ''}${st.deltaRadiusC.toFixed(2)} °C</b></div><div><small style="color:#9ab0b5;display:block;font-size:10px">Desvio (σ)</small><b>±${st.radiusStdC.toFixed(2)} °C</b></div></div><b style="font-size:11px;color:${st.proximityColor}">${st.proximityStatus}</b>`;
        node.querySelector('.station-popup-close-btn')?.addEventListener('click', (ev) => { ev.stopPropagation(); popupRef.current?.remove(); });
        popupRef.current = new maplibregl.Popup({ closeButton: false, closeOnClick: true, offset: 18, className: 'station-map-popup' }).setLngLat([st.lng, st.lat]).setDOMContent(node).addTo(map);
        map.flyTo({ center: [st.lng, st.lat], zoom: Math.max(map.getZoom(), 14), duration: 600 });
      });
      markersRef.current.push(new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([st.lng, st.lat]).addTo(map));
    });
    return () => { popupRef.current?.remove(); markersRef.current.forEach((m) => m.remove()); };
  }, [map, visibleOnMap, stations, stationRadiusM]);

  useEffect(() => {
    if (!map || !open || !stations.length) return;
    const t = window.setTimeout(() => {
      map.resize();
      const lngs = stations.map((s) => s.lng); const lats = stations.map((s) => s.lat);
      map.fitBounds([[Math.min(...lngs) - 0.006, Math.min(...lats) - 0.006], [Math.max(...lngs) + 0.006, Math.max(...lats) + 0.006]], { padding: { top: 60, bottom: 60, left: 50, right: collapsed ? 60 : 400 }, duration: 650, maxZoom: 14.5 });
    }, 120);
    return () => window.clearTimeout(t);
  }, [open, collapsed, stations, map]);

  if (!open || !stations.length) return null;
  const n = stations.length;
  const mae = stations.reduce((a, s) => a + Math.abs(s.deltaRadiusC), 0) / n;
  const rmse = Math.sqrt(stations.reduce((a, s) => a + s.deltaRadiusC ** 2, 0) / n);
  const bias = stations.reduce((a, s) => a + s.deltaRadiusC, 0) / n;
  const sMin = Math.min(14, rasterMin) - 2; const sMax = Math.max(40, rasterMax) + 2;
  const toPct = (v: number) => Math.max(3, Math.min(97, ((v - sMin) / (sMax - sMin)) * 100));

  const downloadPng = () => {
    const c = document.createElement('canvas'); c.width = 920; c.height = 160 + n * 78;
    const ctx = c.getContext('2d'); if (!ctx) return;
    ctx.fillStyle = '#071317'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = '#38bdf8'; ctx.font = '700 18px Arial'; ctx.fillText(`SR2D4 · Satélite (Raio ${stationRadiusM}m) vs. Estações (Ta 2m) · ${stations[0].dateIso}`, 24, 38);
    ctx.fillStyle = '#9cddda'; ctx.font = '13px Arial'; ctx.fillText(`MAE: ${mae.toFixed(2)}°C | RMSE: ${rmse.toFixed(2)}°C | Offset: ${bias >= 0 ? '+' : ''}${bias.toFixed(2)}°C`, 24, 64);
    stations.forEach((st, i) => {
      const y = 110 + i * 78;
      ctx.fillStyle = '#fff'; ctx.font = '700 14px Arial'; ctx.fillText(`#${i + 1} ${st.name} (ΔT: ${st.deltaRadiusC >= 0 ? '+' : ''}${st.deltaRadiusC.toFixed(2)}°C)`, 24, y);
      ctx.fillStyle = '#38bdf8'; ctx.fillRect(24, y + 10, toPct(st.stationTempC) * 5, 10); ctx.fillText(`Ta: ${st.stationTempC.toFixed(1)}°C`, 540, y + 20);
      ctx.fillStyle = '#ffb000'; ctx.fillRect(24, y + 26, toPct(st.radiusMeanC) * 5, 10); ctx.fillText(`LST ${stationRadiusM}m: ${st.radiusMeanC.toFixed(1)}°C`, 540, y + 36);
    });
    const a = document.createElement('a'); a.href = c.toDataURL('image/png'); a.download = `SR2D4-Estacoes-${stationRadiusM}m.png`; a.click();
  };

  return (
    <aside style={{ position: 'absolute', top: 12, right: 54, bottom: 12, width: collapsed ? 46 : 'min(395px, 42vw)', zIndex: 22, background: 'rgba(8,20,26,0.9)', backdropFilter: 'blur(12px)', border: '1.5px solid #38bdf8', borderRadius: 16, display: 'flex', flexDirection: 'column', overflow: 'hidden', color: '#fff' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px', borderBottom: '1px solid rgba(121,226,220,0.2)' }}>
        <button type="button" onClick={() => setCollapsed(!collapsed)} style={{ background: '#38bdf833', border: '1px solid #38bdf8', color: '#fff', borderRadius: 8, padding: '4px 8px', cursor: 'pointer' }}>{collapsed ? '◀' : '▶'}</button>
        {!collapsed && <><strong style={{ fontSize: 13, marginLeft: 8, flex: 1 }}>Satélite vs. Estações ({n})</strong><button type="button" onClick={onClose} style={{ background: 'transparent', border: '1px solid #ffffff44', color: '#fff', borderRadius: 8, width: 26, height: 26, cursor: 'pointer' }}>×</button></>}
      </div>
      {!collapsed && (
        <div style={{ flex: 1, overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 4 }}>{[30, 50, 100, 250, 500].map((r) => <button key={r} type="button" onClick={() => onChangeRadius(r)} style={{ flex: 1, padding: 5, borderRadius: 6, border: stationRadiusM === r ? '1.5px solid #38bdf8' : '1px solid #ffffff33', background: stationRadiusM === r ? '#38bdf833' : 'transparent', color: '#fff', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>{r}m</button>)}</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            <button type="button" onClick={downloadPng} style={{ padding: 7, borderRadius: 7, background: '#ffb000', color: '#071317', fontWeight: 800, fontSize: 11, border: 'none', cursor: 'pointer' }}>🖼 Gráfico PNG</button>
            <button type="button" onClick={onDownloadCsv} style={{ padding: 7, borderRadius: 7, background: '#38bdf833', color: '#79e2dc', fontWeight: 800, fontSize: 11, border: '1px solid #38bdf8', cursor: 'pointer' }}>📊 Tabela CSV</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, fontSize: 11 }}>
            <div style={{ background: '#ffffff0a', padding: 8, borderRadius: 8 }}><small style={{ color: '#9ab0b5', display: 'block' }}>MAE ({stationRadiusM}m)</small><b style={{ fontSize: 16, color: '#38bdf8' }}>{mae.toFixed(2)} °C</b></div>
            <div style={{ background: '#ffffff0a', padding: 8, borderRadius: 8 }}><small style={{ color: '#9ab0b5', display: 'block' }}>Offset / RMSE</small><b style={{ fontSize: 16, color: '#fb923c' }}>{bias >= 0 ? '+' : ''}${bias.toFixed(2)}° / {rmse.toFixed(2)}°</b></div>
          </div>
          {stations.map((st, i) => (
            <div key={st.id} onClick={() => map?.flyTo({ center: [st.lng, st.lat], zoom: 15, duration: 600 })} style={{ background: '#ffffff0a', border: '1px solid #79e2dc28', borderRadius: 9, padding: 8, cursor: 'pointer', fontSize: 11 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}><b>#{i + 1} · {st.name}</b><b style={{ color: st.proximityColor }}>ΔT: {st.deltaRadiusC >= 0 ? '+' : ''}{st.deltaRadiusC.toFixed(2)}°C</b></div>
              <div style={{ display: 'grid', gridTemplateColumns: '68px 1fr 44px', alignItems: 'center', gap: 6, fontSize: 10, marginBottom: 3 }}><span style={{ color: '#38bdf8' }}>Estação:</span><div style={{ height: 6, background: '#ffffff18', borderRadius: 3 }}><div style={{ width: `${toPct(st.stationTempC)}%`, height: '100%', background: '#38bdf8' }} /></div><b>{st.stationTempC.toFixed(1)}°</b></div>
              <div style={{ display: 'grid', gridTemplateColumns: '68px 1fr 44px', alignItems: 'center', gap: 6, fontSize: 10 }}><span style={{ color: '#ffb000' }}>Raio {stationRadiusM}m:</span><div style={{ height: 6, background: '#ffffff18', borderRadius: 3 }}><div style={{ width: `${toPct(st.radiusMeanC)}%`, height: '100%', background: '#ffb000' }} /></div><b>{st.radiusMeanC.toFixed(1)}°</b></div>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}
// FIM DO ARQUIVO src/StationDock.tsx
