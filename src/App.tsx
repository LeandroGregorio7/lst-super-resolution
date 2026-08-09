import React, { useRef, useState, useEffect } from 'react';
import { Panel } from './Panel';
import { renderLstToCanvas, PaletteType } from './colorMapper';
import { downloadFloat32Tiff, downloadUhiTiff } from './exportTiff';
import { t } from './i18n';

function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const bgCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  
  const [lang, setLang] = useState<'pt' | 'en'>('pt');
  const text = t[lang];

  const [mapStats, setMapStats] = useState<{ 
    min: number; max: number; mean: number; stdDev: number; 
    width: number; height: number; data: Float32Array; landsatMeta: any; 
    origin: number[]; resolution: number[]; epsg: number; isProjected: boolean;
  } | null>(null);

  const [zoom, setZoom] = useState<number>(1);
  const [hoverTemp, setHoverTemp] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0, scrollLeft: 0, scrollTop: 0 });

  const [palette, setPalette] = useState<PaletteType>('ironbow');
  const [opacity, setOpacity] = useState<number>(0.7);
  const [customColors, setCustomColors] = useState<string[]>(['#000080', '#0000ff', '#00ff00', '#ffff00', '#ff0000']);
  const [debouncedCustomColors, setDebouncedCustomColors] = useState<string[]>(customColors);
  
  const [showMethodology, setShowMethodology] = useState(false);
  const [showHowToUse, setShowHowToUse] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedCustomColors(customColors), 150);
    return () => clearTimeout(timer);
  }, [customColors]);

  useEffect(() => {
    if (mapStats && canvasRef.current) {
      renderLstToCanvas(mapStats.data, mapStats.width, mapStats.height, canvasRef.current, palette, debouncedCustomColors);
    }
  }, [palette, debouncedCustomColors, mapStats]);

  useEffect(() => {
    const div = scrollRef.current;
    if (!div) return;
    const handleNativeWheel = (e: WheelEvent) => { e.preventDefault(); setZoom(prev => Math.min(10, Math.max(0.1, prev - e.deltaY * 0.002))); };
    div.addEventListener('wheel', handleNativeWheel, { passive: false });
    return () => div.removeEventListener('wheel', handleNativeWheel);
  }, []);

  const handleExportPNG = () => {
    if (canvasRef.current && bgCanvasRef.current && mapStats) {
      const mergeCanvas = document.createElement('canvas');
      mergeCanvas.width = canvasRef.current.width; mergeCanvas.height = canvasRef.current.height;
      const ctx = mergeCanvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(bgCanvasRef.current, 0, 0); ctx.globalAlpha = opacity; ctx.drawImage(canvasRef.current, 0, 0); ctx.globalAlpha = 1.0;

        const legW = 320; const legH = palette === 'uhi' ? 140 : 100;
        const legX = mergeCanvas.width - legW - 30; const legY = mergeCanvas.height - legH - 30;

        ctx.fillStyle = 'rgba(30, 30, 30, 0.9)'; ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(legX, legY, legW, legH, 10); else ctx.rect(legX, legY, legW, legH);
        ctx.fill(); ctx.strokeStyle = '#444'; ctx.lineWidth = 2; ctx.stroke();

        ctx.fillStyle = '#fff'; ctx.font = 'bold 16px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(text.legend, legX + legW / 2, legY + 25);

        if (palette === 'uhi') {
          ctx.textAlign = 'left'; ctx.font = '14px sans-serif'; const startY = legY + 45;
          ctx.fillStyle = '#1a9641'; ctx.fillRect(legX + 20, startY, 15, 15); ctx.fillStyle = '#fff'; ctx.fillText(`${text.uhiClass1} (< ${mapStats.mean.toFixed(1)}°C)`, legX + 45, startY + 13);
          ctx.fillStyle = '#fee08b'; ctx.fillRect(legX + 20, startY + 20, 15, 15); ctx.fillStyle = '#fff'; ctx.fillText(`${text.uhiClass2} (até ${(mapStats.mean + 0.5 * mapStats.stdDev).toFixed(1)}°C)`, legX + 45, startY + 33);
          ctx.fillStyle = '#fdae61'; ctx.fillRect(legX + 20, startY + 40, 15, 15); ctx.fillStyle = '#fff'; ctx.fillText(`${text.uhiClass3} (até ${(mapStats.mean + 1.5 * mapStats.stdDev).toFixed(1)}°C)`, legX + 45, startY + 53);
          ctx.fillStyle = '#d7191c'; ctx.fillRect(legX + 20, startY + 60, 15, 15); ctx.fillStyle = '#fff'; ctx.fillText(`${text.uhiClass4} (>= ${(mapStats.mean + 1.5 * mapStats.stdDev).toFixed(1)}°C)`, legX + 45, startY + 73);
        } else {
          const grad = ctx.createLinearGradient(legX + 20, 0, legX + legW - 20, 0);
          if (palette === 'jet') { grad.addColorStop(0, '#000082'); grad.addColorStop(0.25, '#00ffff'); grad.addColorStop(0.5, '#00ff00'); grad.addColorStop(0.75, '#ffff00'); grad.addColorStop(1, '#ff0000'); }
          else if (palette === 'spectral') { grad.addColorStop(0, 'rgb(94,79,162)'); grad.addColorStop(0.2, 'rgb(50,136,189)'); grad.addColorStop(0.4, 'rgb(102,194,165)'); grad.addColorStop(0.6, 'rgb(253,212,134)'); grad.addColorStop(0.8, 'rgb(244,109,67)'); grad.addColorStop(1, 'rgb(158,1,66)'); }
          else if (palette === 'grayscale') { grad.addColorStop(0, 'black'); grad.addColorStop(1, 'white'); }
          else if (palette === 'custom') { debouncedCustomColors.forEach((c, i) => grad.addColorStop(i / (debouncedCustomColors.length - 1), c)); }
          else { grad.addColorStop(0, 'rgb(0,0,130)'); grad.addColorStop(0.25, 'rgb(120,0,120)'); grad.addColorStop(0.5, 'rgb(204,0,0)'); grad.addColorStop(0.75, 'rgb(255,204,0)'); grad.addColorStop(1, 'rgb(255,255,255)'); }
          ctx.fillStyle = grad; ctx.fillRect(legX + 20, legY + 45, legW - 40, 20);
          ctx.fillStyle = '#fff'; ctx.font = '14px sans-serif'; ctx.textAlign = 'left'; ctx.fillText(`Min: ${mapStats.min.toFixed(1)}°C`, legX + 20, legY + 85); ctx.textAlign = 'right'; ctx.fillText(`Max: ${mapStats.max.toFixed(1)}°C`, legX + legW - 20, legY + 85);
        }
      }
      const link = document.createElement("a"); link.href = mergeCanvas.toDataURL("image/png"); link.download = `LST_Export_${palette}.png`; link.click();
    }
  };

  const handleExportLstTIF = () => {
    if (mapStats) {
      alert(`A exportar TIF (EPSG:${mapStats.epsg})...`);
      setTimeout(() => downloadFloat32Tiff(mapStats.data, mapStats.width, mapStats.height, "LST_Downscaled_1m.tif", mapStats.origin, mapStats.resolution, mapStats.epsg, mapStats.isProjected), 100);
    }
  };

  const handleExportUhiTIF = () => {
    if (mapStats) {
      alert(`A exportar TIF UHI (EPSG:${mapStats.epsg})...`);
      setTimeout(() => downloadUhiTiff(mapStats.data, mapStats.width, mapStats.height, "UHI_Classified_1m.tif", mapStats.origin, mapStats.resolution, mapStats.epsg, mapStats.isProjected, mapStats.mean, mapStats.stdDev), 100);
    }
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!scrollRef.current) return; setIsDragging(true);
    setDragStart({ x: e.pageX - scrollRef.current.offsetLeft, y: e.pageY - scrollRef.current.offsetTop, scrollLeft: scrollRef.current.scrollLeft, scrollTop: scrollRef.current.scrollTop });
  };
  const handleMouseUp = () => setIsDragging(false);
  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!mapStats || !canvasRef.current || !scrollRef.current) return;
    if (isDragging) { e.preventDefault(); scrollRef.current.scrollLeft = dragStart.scrollLeft - (e.pageX - scrollRef.current.offsetLeft - dragStart.x); scrollRef.current.scrollTop = dragStart.scrollTop - (e.pageY - scrollRef.current.offsetTop - dragStart.y); setHoverTemp(null); return; }
    const rect = canvasRef.current.getBoundingClientRect(); const x = Math.floor((e.clientX - rect.left) * (canvasRef.current.width / rect.width)); const y = Math.floor((e.clientY - rect.top) * (canvasRef.current.height / rect.height));
    if (x >= 0 && x < mapStats.width && y >= 0 && y < mapStats.height) { const temp = mapStats.data[y * mapStats.width + x]; setHoverTemp(isNaN(temp) ? null : temp); } else setHoverTemp(null);
  };

  const getLegendGradient = () => {
    if (palette === 'jet') return 'linear-gradient(to right, #000082, #00ffff, #00ff00, #ffff00, #ff0000)';
    if (palette === 'spectral') return 'linear-gradient(to right, rgb(94,79,162), rgb(50,136,189), rgb(102,194,165), rgb(253,212,134), rgb(244,109,67), rgb(158,1,66))';
    if (palette === 'grayscale') return 'linear-gradient(to right, black, white)';
    if (palette === 'custom') return `linear-gradient(to right, ${debouncedCustomColors.join(', ')})`;
    return 'linear-gradient(to right, rgb(0,0,130), rgb(120,0,120), rgb(204,0,0), rgb(255,204,0), rgb(255,255,255))';
  };

  return (
    <div style={{ display: 'flex', width: '100vw', height: '100vh', margin: 0, padding: 0, backgroundColor: '#1e1e1e' }}>
      <div style={{ width: '350px', height: '100%', borderRight: '2px solid #333', backgroundColor: '#f9f9f9', overflowY: 'auto', zIndex: 10 }}>
        <Panel canvasRef={canvasRef} bgCanvasRef={bgCanvasRef} onStatsChange={setMapStats} lang={lang} setLang={setLang} onOpenMethodology={() => setShowMethodology(true)} onOpenHowToUse={() => setShowHowToUse(true)} />
      </div>

      <div style={{ flex: 1, position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        {!mapStats && <div style={{ textAlign: 'center', color: '#aaa' }}><h2>{text.mapArea}</h2><p>{text.mapDesc}</p></div>}

        {mapStats && (
          <div style={{ position: 'absolute', top: '15px', display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '10px', zIndex: 5, width: '95%' }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', backgroundColor: 'rgba(42, 42, 42, 0.9)', padding: '8px', borderRadius: '8px', boxShadow: '0 4px 15px rgba(0,0,0,0.5)' }}>
              <select value={palette} onChange={(e) => setPalette(e.target.value as PaletteType)} style={{ ...btnStyle, backgroundColor: '#222', border: '1px solid #555' }}><option value="ironbow">🔥 Ironbow</option><option value="spectral">🌌 Spectral</option><option value="jet">🌈 Jet</option><option value="grayscale">🌑 Grayscale</option><option value="custom">{text.custom}</option><option value="uhi">{text.uhiMode}</option></select>
              {palette === 'custom' && <div style={{ display: 'flex', gap: '2px' }}>{customColors.map((c, i) => <input key={i} type="color" value={c} onChange={(e) => { const newC = [...customColors]; newC[i] = e.target.value; setCustomColors(newC); }} style={{ width: '25px', height: '25px', padding: 0, border: 'none', cursor: 'pointer' }} title={`Cor ${i+1}`} />)}</div>}
              <div style={{ width: '1px', height: '20px', backgroundColor: '#666', margin: '0 5px' }}></div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '5px', color: 'white', fontSize: '13px', fontWeight: 'bold' }}>{text.transp} <input type="range" min="0" max="1" step="0.05" value={opacity} onChange={(e) => setOpacity(parseFloat(e.target.value))} style={{ width: '60px', cursor: 'pointer' }} /></div>
              <div style={{ width: '1px', height: '20px', backgroundColor: '#666', margin: '0 5px' }}></div>
              <button onClick={() => setZoom(z => Math.max(0.2, z - 0.2))} style={btnStyle}>➖</button><button onClick={() => setZoom(1)} style={btnStyle}>{text.reset}</button><button onClick={() => setZoom(z => Math.min(10, z + 0.2))} style={btnStyle}>➕</button>
              <div style={{ width: '1px', height: '20px', backgroundColor: '#666', margin: '0 5px' }}></div>
              <button onClick={handleExportPNG} style={{...btnStyle, backgroundColor: '#28a745'}}>{text.exportPng}</button>
              <button onClick={handleExportLstTIF} style={{...btnStyle, backgroundColor: '#ffc107', color: 'black'}}>{text.exportLstTif}</button>
              <button onClick={handleExportUhiTIF} style={{...btnStyle, backgroundColor: '#dc3545', color: 'white'}}>{text.exportUhiTif}</button>
            </div>
          </div>
        )}

        {mapStats?.landsatMeta && (
          <div style={{ position: 'absolute', top: '80px', left: '20px', backgroundColor: 'rgba(20, 20, 20, 0.85)', padding: '12px', borderRadius: '8px', color: '#00ff88', border: '1px solid #333', fontSize: '12px', zIndex: 5 }}>
            <h4 style={{ margin: '0 0 5px 0', color: '#fff' }}>{text.landsatBox}</h4><div><b>{text.scene}</b> {mapStats.landsatMeta.id}</div><div><b>{text.date}</b> {new Date(mapStats.landsatMeta.date).toLocaleString()}</div><div><b>{text.clouds}</b> {mapStats.landsatMeta.cloud.toFixed(2)}%</div>
          </div>
        )}

        {hoverTemp !== null && !isDragging && (
           <div style={{ position: 'absolute', top: '100px', left: '50%', transform: 'translateX(-50%)', backgroundColor: 'rgba(0,0,0,0.8)', color: '#00ff88', padding: '10px 20px', borderRadius: '30px', fontSize: '24px', fontWeight: 'bold', zIndex: 10, pointerEvents: 'none' }}>🎯 {hoverTemp.toFixed(1)} °C</div>
        )}

        <div ref={scrollRef} style={{ display: mapStats ? 'block' : 'none', width: '100%', height: '100%', overflow: 'auto', cursor: isDragging ? 'grabbing' : 'grab' }} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp} onMouseMove={handleMouseMove}>
          <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 'min-content', minHeight: 'min-content' }}>
            <div style={{ position: 'relative', border: '2px solid #555', borderRadius: '8px', transition: isDragging ? 'none' : 'transform 0.1s', transform: `scale(${zoom})`, transformOrigin: 'center center' }}><canvas ref={bgCanvasRef} style={{ display: 'block', pointerEvents: 'none' }} /><canvas ref={canvasRef} style={{ display: 'block', position: 'absolute', top: 0, left: 0, opacity: opacity, pointerEvents: 'none' }} /></div>
          </div>
        </div>

        {mapStats && (
          <div style={{ position: 'absolute', bottom: '30px', right: '30px', backgroundColor: 'rgba(30, 30, 30, 0.9)', padding: '15px', borderRadius: '8px', color: 'white', zIndex: 5, border: '1px solid #444', pointerEvents: 'none' }}>
            <div style={{ textAlign: 'center', marginBottom: '8px', fontSize: '14px', fontWeight: 'bold' }}>{text.legend}</div>
            {palette === 'uhi' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}><div style={{ width: '16px', height: '16px', backgroundColor: '#1a9641', borderRadius: '3px' }}></div><span>{text.uhiClass1} (&lt; {mapStats.mean.toFixed(1)}°C)</span></div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}><div style={{ width: '16px', height: '16px', backgroundColor: '#fee08b', borderRadius: '3px' }}></div><span>{text.uhiClass2} ({mapStats.mean.toFixed(1)}°C a {(mapStats.mean + 0.5 * mapStats.stdDev).toFixed(1)}°C)</span></div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}><div style={{ width: '16px', height: '16px', backgroundColor: '#fdae61', borderRadius: '3px' }}></div><span>{text.uhiClass3} (+0.5σ a +1.5σ)</span></div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}><div style={{ width: '16px', height: '16px', backgroundColor: '#d7191c', borderRadius: '3px' }}></div><span>{text.uhiClass4} (≥ {(mapStats.mean + 1.5 * mapStats.stdDev).toFixed(1)}°C)</span></div>
                <div style={{ marginTop: '5px', fontSize: '10px', color: '#aaa', borderTop: '1px solid #444', paddingTop: '4px' }}>{text.uhiMean} {mapStats.mean.toFixed(2)}°C | {text.uhiStd} {mapStats.stdDev.toFixed(2)}°C</div>
              </div>
            ) : (
              <><div style={{ width: '250px', height: '20px', background: getLegendGradient(), borderRadius: '10px', marginBottom: '5px', border: '1px solid #222' }}></div><div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}><span>❄️ {mapStats.min.toFixed(1)}°C</span><span>🔥 {mapStats.max.toFixed(1)}°C</span></div></>
            )}
          </div>
        )}

        {showMethodology && (<div style={modalOverlayStyle}><div style={modalStyle}><h3>{text.methodology}</h3><p style={{textAlign: 'justify'}}>{text.methodText1}</p><p style={{textAlign: 'justify'}}>{text.methodText2}</p><button onClick={() => setShowMethodology(false)} style={{...btnStyle, marginTop: '10px'}}>{text.close}</button></div></div>)}
        {showHowToUse && (<div style={modalOverlayStyle}><div style={modalStyle}><h3>{text.howToUse}</h3><ul style={{ textAlign: 'left', lineHeight: '1.6' }}><li>{text.useText1}</li><li>{text.useText2}</li><li>{text.useText3}</li><li>{text.useText4}</li><li>{text.useText5}</li></ul><button onClick={() => setShowHowToUse(false)} style={{...btnStyle, marginTop: '10px'}}>{text.understood}</button></div></div>)}
      </div>
    </div>
  );
}

export default App;

const btnStyle: React.CSSProperties = { padding: '6px 12px', backgroundColor: '#444', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold', outline: 'none', fontSize: '13px' };
const modalOverlayStyle: React.CSSProperties = { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 };
const modalStyle: React.CSSProperties = { backgroundColor: '#fff', color: '#333', padding: '30px', borderRadius: '8px', maxWidth: '400px', textAlign: 'center', boxShadow: '0 10px 30px rgba(0,0,0,0.5)' };