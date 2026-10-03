import { renderLstToCanvas, type PaletteType } from './colorMapper';

type MapLike = {
  getSource: (id: string) => any;
  addSource: (id: string, source: any) => void;
  removeSource: (id: string) => void;
  getLayer: (id: string) => any;
  addLayer: (layer: any, beforeId?: string) => void;
  removeLayer: (id: string) => void;
  setPaintProperty: (layerId: string, name: string, value: unknown) => void;
};

type RasterStats = {
  data: Float32Array;
  width: number;
  height: number;
  origin: number[];
  resolution: number[];
  epsg: number;
};

const SOURCE_ID = 'lst-super-resolution-source';
const LAYER_ID = 'lst-super-resolution-layer';
const EARTH_RADIUS = 6378137;

function mercatorToLonLat(x: number, y: number): [number, number] {
  return [
    (x / EARTH_RADIUS) * (180 / Math.PI),
    (Math.atan(Math.sinh(y / EARTH_RADIUS)) * 180) / Math.PI,
  ];
}

function utmToLonLat(easting: number, northing: number, zone: number, southern: boolean): [number, number] {
  const a = 6378137;
  const eccSquared = 0.00669438;
  const k0 = 0.9996;
  const e1 = (1 - Math.sqrt(1 - eccSquared)) / (1 + Math.sqrt(1 - eccSquared));
  const x = easting - 500000;
  const y = southern ? northing - 10000000 : northing;
  const m = y / k0;
  const mu = m / (a * (1 - eccSquared / 4 - (3 * eccSquared ** 2) / 64 - (5 * eccSquared ** 3) / 256));
  const ePrimeSquared = eccSquared / (1 - eccSquared);
  const phi1 = mu
    + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu)
    + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
    + (151 * e1 ** 3 / 96) * Math.sin(6 * mu)
    + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const n1 = a / Math.sqrt(1 - eccSquared * Math.sin(phi1) ** 2);
  const t1 = Math.tan(phi1) ** 2;
  const c1 = ePrimeSquared * Math.cos(phi1) ** 2;
  const r1 = (a * (1 - eccSquared)) / (1 - eccSquared * Math.sin(phi1) ** 2) ** 1.5;
  const d = x / (n1 * k0);
  const lat = phi1 - (n1 * Math.tan(phi1) / r1) * (
    d ** 2 / 2
    - (5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * ePrimeSquared) * d ** 4 / 24
    + (61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * ePrimeSquared - 3 * c1 ** 2) * d ** 6 / 720
  );
  const lon = (
    (zone - 1) * 6 - 180 + 3
    + (d - (1 + 2 * t1 + c1) * d ** 3 / 6
      + (5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * ePrimeSquared + 24 * t1 ** 2) * d ** 5 / 120) / Math.cos(phi1)
  );
  return [(lon * 180) / Math.PI, (lat * 180) / Math.PI];
}

function toLonLat(x: number, y: number, epsg: number): [number, number] {
  if (epsg === 3857 || epsg === 900913) return mercatorToLonLat(x, y);
  if (epsg === 4326 || epsg === 4269) return [x, y];
  if (epsg >= 32601 && epsg <= 32660) return utmToLonLat(x, y, epsg - 32600, false);
  if (epsg >= 32701 && epsg <= 32760) return utmToLonLat(x, y, epsg - 32700, true);
  console.warn(`[LST] EPSG:${epsg} não tem conversão embutida; assumindo WGS84.`);
  return [x, y];
}

function rasterCoordinates(stats: RasterStats): number[][] {
  const x0 = stats.origin[0];
  const y0 = stats.origin[1];
  const x1 = x0 + stats.width * stats.resolution[0];
  const y1 = y0 + stats.height * stats.resolution[1];
  const west = Math.min(x0, x1);
  const east = Math.max(x0, x1);
  const south = Math.min(y0, y1);
  const north = Math.max(y0, y1);
  return [
    toLonLat(west, north, stats.epsg),
    toLonLat(east, north, stats.epsg),
    toLonLat(east, south, stats.epsg),
    toLonLat(west, south, stats.epsg),
  ];
}

export function removeLstOverlay(map: MapLike | null | undefined): void {
  if (!map) return;
  if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
}

export function addOrUpdateLstOverlay(
  map: MapLike | null | undefined,
  stats: RasterStats,
  palette: PaletteType,
  opacity: number,
): void {
  if (!map) return;
  const canvas = document.createElement('canvas');
  const rendered = renderLstToCanvas(stats.data, stats.width, stats.height, canvas, palette);
  if (!rendered) return;

  const image = canvas.toDataURL('image/png');
  const coordinates = rasterCoordinates(stats);
  const source = map.getSource(SOURCE_ID);

  if (source?.updateImage) {
    source.updateImage({ url: image, coordinates });
  } else {
    removeLstOverlay(map);
    map.addSource(SOURCE_ID, { type: 'image', url: image, coordinates });
    map.addLayer({
      id: LAYER_ID,
      type: 'raster',
      source: SOURCE_ID,
      paint: { 'raster-opacity': opacity },
    });
  }

  if (map.getLayer(LAYER_ID)) {
    map.setPaintProperty(LAYER_ID, 'raster-opacity', opacity);
  }
}

export const LST_OVERLAY_LAYER_ID = LAYER_ID;
