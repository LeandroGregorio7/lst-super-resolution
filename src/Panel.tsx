import React, { useState } from 'react';
import { calculateOpticalIndices } from './opticalIndices';
import { calculateThermalRadiance } from './thermalProcessing';
import { readTiffPixels } from './tiffReader';
import { searchLandsatInCloud } from './stacSearch';
import { applyTsHARP } from './downscaling';
import { renderLstToCanvas, renderRGBBasemapToCanvas } from './colorMapper';
import { t } from './i18n';

export interface PanelProps {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  bgCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  onStatsChange: (stats: { 
    min: number; max: number; mean: number; stdDev: number; 
    width: number; height: number; data: Float32Array; landsatMeta: any; 
    origin: number[]; resolution: number[]; epsg: number; isProjected: boolean;
  }) => void;
  lang: 'pt' | 'en';
  setLang: (lang: 'pt' | 'en') => void;
  onOpenMethodology: () => void;
  onOpenHowToUse: () => void;
}

function extractDateFromFilename(filename: string): string | null {
  const match = filename.match(/\d{8}/);
  if (match) return `${match[0].substring(0, 4)}-${match[0].substring(4, 6)}-${match[0].substring(6, 8)}`;
  return null;
}

const yieldToUI = () => new Promise(resolve => setTimeout(resolve, 50));

export function Panel({ canvasRef, bgCanvasRef, onStatsChange, lang, setLang, onOpenMethodology, onOpenHowToUse }: PanelProps) {
  const [bandRed, setBandRed] = useState('');
  const [bandNir, setBandNir] = useState('');
  const [bandSwir, setBandSwir] = useState('');
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  
  const [isProcessing, setIsProcessing] = useState(false);
  const [progressMsg, setProgressMsg] = useState('');

  const text = t[lang];

  const handleCalculate = async () => {
    if (!bandRed || !bandNir || !bandSwir || !uploadedFile) {
      alert("Selecione as bandas e a imagem!"); return;
    }
    setIsProcessing(true);
    
    try {
      setProgressMsg(text.stepStart); await yieldToUI();
      setProgressMsg(text.stepCloud); await yieldToUI();
      const captureDate = extractDateFromFilename(uploadedFile.name);
      let landsatMeta = null;
      if (captureDate) {
        const features = await searchLandsatInCloud(captureDate);
        if (features && features.length > 0) {
          landsatMeta = { id: features[0].id, date: features[0].properties.datetime, cloud: features[0].properties['eo:cloud_cover'] };
        }
      }

      setProgressMsg(text.stepRead); await yieldToUI();
      const tiffData = await readTiffPixels(uploadedFile);
      const redArray = tiffData.rasters[0] as Float32Array;
      const nirArray = tiffData.rasters[1] as Float32Array;
      const swirArray = tiffData.rasters[2] as Float32Array;

      setProgressMsg(text.stepMath); await yieldToUI();
      const opticalResult = calculateOpticalIndices(redArray, nirArray, swirArray);
      const thermalResult = calculateThermalRadiance(redArray);
      const downscaleResult = applyTsHARP(opticalResult.ndvi, thermalResult.brightnessTempCelsius);

      setProgressMsg(text.stepRender); await yieldToUI();
      
      if (bgCanvasRef.current) renderRGBBasemapToCanvas(swirArray, nirArray, redArray, tiffData.width, tiffData.height, bgCanvasRef.current);
      
      if (canvasRef.current) {
        const stats = renderLstToCanvas(downscaleResult.lstDownscaled, tiffData.width, tiffData.height, canvasRef.current, 'ironbow');
        if (stats) {
          onStatsChange({ 
            min: stats.min, max: stats.max, mean: stats.mean, stdDev: stats.stdDev, 
            width: tiffData.width, height: tiffData.height, data: downscaleResult.lstDownscaled, 
            landsatMeta, origin: tiffData.origin, resolution: tiffData.resolution, 
            epsg: tiffData.epsg, isProjected: tiffData.isProjected
          });
        }
      }
    } catch (error) {
      console.error(error); alert("Erro ao processar imagem.");
    } finally {
      setIsProcessing(false); setProgressMsg('');
    }
  };

  return (
    <div style={{ padding: '15px', fontFamily: 'sans-serif', display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
        <div style={{ display: 'flex', gap: '5px' }}>
          <button onClick={onOpenMethodology} style={btnAuxStyle}>{text.methodology}</button>
          <button onClick={onOpenHowToUse} style={btnAuxStyle}>{text.howToUse}</button>
        </div>
        <div style={{ display: 'flex', gap: '5px' }}>
          <button onClick={() => setLang('pt')} style={{ opacity: lang === 'pt' ? 1 : 0.4, border: 'none', background: 'none', cursor: 'pointer', fontSize: '18px', padding: 0 }}>🇧🇷</button>
          <button onClick={() => setLang('en')} style={{ opacity: lang === 'en' ? 1 : 0.4, border: 'none', background: 'none', cursor: 'pointer', fontSize: '18px', padding: 0 }}>🇺🇸</button>
        </div>
      </div>

      <h2 style={{ marginTop: 0 }}>{text.title}</h2>
      <a href="https://colab.research.google.com/drive/1OL0yxfcRY7qNMtHNszuvlBK-G6vCpwXk?usp=sharing" target="_blank" rel="noreferrer" style={{ display: 'block', textAlign: 'center', backgroundColor: '#f39c12', color: 'white', padding: '10px', textDecoration: 'none', fontWeight: 'bold', borderRadius: '4px', marginBottom: '20px' }}>{text.colabBtn}</a>
      
      <div style={{ marginBottom: '25px', padding: '15px', backgroundColor: '#fff', border: '1px solid #ccc', borderRadius: '5px' }}>
        <h3 style={{ marginTop: 0, fontSize: '16px' }}>{text.uploadTitle}</h3><p style={{ fontSize: '13px', color: '#555' }}>{text.uploadDesc}</p>
        <input type="file" accept=".tif, .tiff" onChange={(e) => setUploadedFile(e.target.files?.[0] || null)} style={{ width: '100%', fontSize: '14px' }} />
        {uploadedFile && <p style={{ fontSize: '12px', color: 'green', marginTop: '10px' }}>{text.ready} {uploadedFile.name}</p>}
      </div>

      <h3 style={{ fontSize: '16px' }}>{text.configTitle}</h3>
      <div style={{ marginBottom: '15px' }}><label style={{ display: 'block', fontSize: '14px', fontWeight: 'bold' }}>{text.bandRed}</label><select value={bandRed} onChange={(e) => setBandRed(e.target.value)} style={{ width: '100%', padding: '5px' }}><option value="">---</option><option value="b4">SR2D4 B4</option></select></div>
      <div style={{ marginBottom: '15px' }}><label style={{ display: 'block', fontSize: '14px', fontWeight: 'bold' }}>{text.bandNir}</label><select value={bandNir} onChange={(e) => setBandNir(e.target.value)} style={{ width: '100%', padding: '5px' }}><option value="">---</option><option value="b8">SR2D4 B8</option></select></div>
      <div style={{ marginBottom: '15px' }}><label style={{ display: 'block', fontSize: '14px', fontWeight: 'bold' }}>{text.bandSwir}</label><select value={bandSwir} onChange={(e) => setBandSwir(e.target.value)} style={{ width: '100%', padding: '5px' }}><option value="">---</option><option value="b11">SR2D4 B11</option></select></div>

      <button onClick={handleCalculate} disabled={isProcessing} style={{ width: '100%', padding: '12px', color: 'white', border: 'none', cursor: isProcessing ? 'not-allowed' : 'pointer', borderRadius: '4px', marginBottom: '20px', fontWeight: 'bold', fontSize: '15px', backgroundColor: isProcessing ? '#6c757d' : '#007BFF', transition: 'background-color 0.3s' }}>{isProcessing ? text.processing : text.calcBtn}</button>
      {isProcessing && <div style={{ marginTop: '-10px', marginBottom: '20px', textAlign: 'center', color: '#007BFF', fontWeight: 'bold', fontSize: '13px' }}>{progressMsg}</div>}
    </div>
  );
}

const btnAuxStyle: React.CSSProperties = { fontSize: '11px', padding: '5px 8px', backgroundColor: '#17a2b8', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' };
