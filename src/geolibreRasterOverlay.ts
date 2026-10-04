import { renderLstToCanvas, type PaletteType } from './colorMapper';

type MapLike = {
  getSource: (id: string) => any;
  addSource: (id: string, source: any) => void;
  removeSource: (id: string) => void;
  getLayer: (id: string) => any;
  addLayer: (layer: any, beforeId?: string) => void;
  removeLayer: (id: string) => void;
  setPaintProperty: (layerId: string, name: string, value: unknown) => void;
  isStyleLoaded?: () => boolean;
  once?: (event: string, listener: () => void) => void;
};

type RasterStats = { data: Float32Array; width: number; height: number; origin: number[]; resolution: number[]; epsg: number };
const SOURCE_ID = 'lst-super-resolution-source';
const LAYER_ID = 'lst-super-resolution-layer';
const EARTH_RADIUS = 6378137;
const MAX_TEXTURE_SIZE = 4096;

function mercatorToLonLat(x: number, y: number): [number, number] {
  return [(x / EARTH_RADIUS) * (180 / Math.PI), (Math.atan(Math.sinh(y / EARTH_RADIUS)) * 180) / Math.PI];
}
function utmToLonLat(easting: number, northing: number, zone: number, southern: boolean): [number, number] {
  const a = 6378137, eccSquared = 0.00669438, k0 = 0.9996;
  const e1 = (1 - Math.sqrt(1 - eccSquared)) / (1 + Math.sqrt(1 - eccSquared));
  const x = easting - 500000, y = southern ? northing - 10000000 : northing;
  const m = y / k0, mu = m / (a * (1 - eccSquared / 4 - (3 * eccSquared ** 2) / 64 - (5 * eccSquared ** 3) / 256));
  const ePrimeSquared = eccSquared / (1 - eccSquared);
  const phi1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu) + (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const n1 = a / Math.sqrt(1 - eccSquared * Math.sin(phi1) ** 2), t1 = Math.tan(phi1) ** 2, c1 = ePrimeSquared * Math.cos(phi1) ** 2;
  const r1 = (a * (1 - eccSquared)) / (1 - eccSquared * Math.sin(phi1) ** 2) ** 1.5, d = x / (n1 * k0);
  const lat = phi1 - (n1 * Math.tan(phi1) / r1) * (d ** 2 / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * ePrimeSquared) * d ** 4 / 24 + (61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * ePrimeSquared - 3 * c1 ** 2) * d ** 6 / 720);
  const lon = (zone - 1) * 6 - 180 + 3 + (d - (1 + 2 * t1 + c1) * d ** 3 / 6 + (5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * ePrimeSquared + 24 * t1 ** 2) * d ** 5 / 120) / Math.cos(phi1);
  return [(lon * 180) / Math.PI, (lat * 180) / Math.PI];
}
function toLonLat(x: number, y: number, epsg: number): [number, number] {
  if (epsg === 3857 || epsg === 900913) return mercatorToLonLat(x, y);
  if (epsg === 4326 || epsg === 4269) return [x, y];
  if (epsg >= 32601 && epsg <= 32660) return utmToLonLat(x, y, epsg - 32600, false);
  if (epsg >= 32701 && epsg <= 32760) return utmToLonLat(x, y, epsg - 32700, true);
  // SIRGAS 2000 / UTM zones 19S–28S (Brazil), including São Paulo EPSG:31983.
  if (epsg >= 31979 && epsg <= 31988) return utmToLonLat(x, y, epsg - 31960, true);
  // SAD69 / UTM zones 18S–25S, still common in legacy Brazilian rasters.
  if (epsg >= 29168 && epsg <= 29175) return utmToLonLat(x, y, epsg - 29150, true);
  console.warn(`[LST] EPSG:${epsg} não tem conversão embutida; assumindo WGS84.`);
  return [x, y];
}
function rasterCoordinates(stats: RasterStats): number[][] {
  const x0 = stats.origin[0], y0 = stats.origin[1], x1 = x0 + stats.width * stats.resolution[0], y1 = y0 + stats.height * stats.resolution[1];
  const west = Math.min(x0, x1), east = Math.max(x0, x1), south = Math.min(y0, y1), north = Math.max(y0, y1);
  return [toLonLat(west, north, stats.epsg), toLonLat(east, north, stats.epsg), toLonLat(east, south, stats.epsg), toLonLat(west, south, stats.epsg)];
}
function makeOverlayCanvas(stats: RasterStats, palette: PaletteType): HTMLCanvasElement {
  const scale = Math.min(1, MAX_TEXTURE_SIZE / Math.max(stats.width, stats.height));
  const width = Math.max(1, Math.round(stats.width * scale)), height = Math.max(1, Math.round(stats.height * scale));
  const sampled = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sx = Math.min(stats.width - 1, Math.floor(x / scale)), sy = Math.min(stats.height - 1, Math.floor(y / scale));
    sampled[y * width + x] = stats.data[sy * stats.width + sx];
  }
  const canvas = document.createElement('canvas');
  renderLstToCanvas(sampled, width, height, canvas, palette);
  return canvas;
}
function canvasToObjectUrl(canvas: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(URL.createObjectURL(blob)) : reject(new Error('Falha ao codificar o raster termal.')), 'image/png'));
}
export function removeLstOverlay(map: MapLike | null | undefined): void {
  if (!map) return;
  try {
    if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
    if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
  } catch (error) { console.warn('[LST] Falha ao remover overlay:', error); }
}
export async function addOrUpdateLstOverlay(map: MapLike | null | undefined, stats: RasterStats, palette: PaletteType, opacity: number): Promise<boolean> {
  if (!map) return false;
  try {
    if (map.isStyleLoaded?.() === false && map.once) await new Promise<void>(resolve => map.once?.('load', resolve));
    const image = await canvasToObjectUrl(makeOverlayCanvas(stats, palette));
    const coordinates = rasterCoordinates(stats), source = map.getSource(SOURCE_ID);
    if (source?.updateImage) source.updateImage({ url: image, coordinates });
    else {
      removeLstOverlay(map);
      map.addSource(SOURCE_ID, { type: 'image', url: image, coordinates });
      map.addLayer({ id: LAYER_ID, type: 'raster', source: SOURCE_ID, paint: { 'raster-opacity': opacity } });
    }
    if (map.getLayer(LAYER_ID)) map.setPaintProperty(LAYER_ID, 'raster-opacity', opacity);
    return true;
  } catch (error) { console.error('[LST] Não foi possível adicionar o overlay termal:', error); return false; }
}
export const LST_OVERLAY_LAYER_ID = LAYER_ID;
