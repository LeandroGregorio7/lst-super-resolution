import * as GeoTIFF from 'geotiff';
import proj4 from 'proj4';
import type { RasterBounds } from './rasterGeo';
import { boundsExtent } from './rasterGeo';

const STAC_SEARCH = 'https://planetarycomputer.microsoft.com/api/stac/v1/search';
const STAC_SIGN = 'https://planetarycomputer.microsoft.com/api/sas/v1/sign';

type StacItem = {
  id: string;
  properties: Record<string, unknown>;
  assets: Record<string, { href?: string; title?: string }>;
};

export type LandsatThermalSubset = {
  itemId: string;
  satellite: 'Landsat 8' | 'Landsat 9';
  acquisitionDate: string;
  sourceDate: string;
  daysFromSr2d4: number;
  cloudCover: number;
  lstCelsius: Float32Array;
  qaPixel: Uint16Array;
  width: number;
  height: number;
  bounds: RasterBounds;
  epsg: number;
};

function parseSr2d4Date(fileName: string): Date {
  const match = fileName.match(/(?:^|[^0-9])(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?:[^0-9]|$)/);
  if (!match) throw new Error('A data do SR2D4 não foi encontrada no nome do arquivo. Use o padrão ..._AAAAMMDD_MS.tif.');
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (Number.isNaN(date.getTime())) throw new Error('A data do SR2D4 é inválida.');
  return date;
}

function isoDay(date: Date) { return date.toISOString().slice(0, 10); }
function dayDistance(a: Date, b: Date) { return Math.abs(a.getTime() - b.getTime()) / 86400000; }

async function searchLandsat(date: Date, bounds: RasterBounds): Promise<StacItem> {
  const extent = boundsExtent(bounds);
  const start = new Date(date.getTime() - 16 * 86400000);
  const end = new Date(date.getTime() + 16 * 86400000);
  const response = await fetch(STAC_SEARCH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      collections: ['landsat-c2-l2'],
      bbox: [extent.west, extent.south, extent.east, extent.north],
      datetime: `${isoDay(start)}/${isoDay(end)}`,
      limit: 100,
      query: { 'eo:cloud_cover': { lt: 85 } },
    }),
  });
  if (!response.ok) throw new Error(`O catálogo Landsat respondeu HTTP ${response.status}.`);
  const body = await response.json() as { features?: StacItem[] };
  const candidates = (body.features ?? [])
    .filter((item) => item.assets?.lwir11?.href && item.assets?.qa_pixel?.href)
    .map((item) => ({ item, date: new Date(String(item.properties.datetime)), cloud: Number(item.properties['eo:cloud_cover'] ?? 100) }))
    .filter((candidate) => !Number.isNaN(candidate.date.getTime()))
    .sort((a, b) => dayDistance(a.date, date) - dayDistance(b.date, date) || a.cloud - b.cloud);
  if (!candidates.length) throw new Error(`Nenhuma cena Landsat 8/9 ST clara foi encontrada em ±16 dias de ${isoDay(date)}.`);
  return candidates[0].item;
}

async function signedHref(href: string): Promise<string> {
  const response = await fetch(`${STAC_SIGN}?href=${encodeURIComponent(href)}`);
  if (!response.ok) throw new Error(`Não foi possível assinar o asset Landsat (HTTP ${response.status}).`);
  const body = await response.json() as { href?: string };
  if (!body.href) throw new Error('O assinador Landsat não retornou uma URL válida.');
  return body.href;
}

function nativeBbox(bounds: RasterBounds, epsg: number): [number, number, number, number] {
  const transform = (point: [number, number]) => proj4('EPSG:4326', `EPSG:${epsg}`, point) as [number, number];
  const points = bounds.map(transform);
  return [Math.min(...points.map((p) => p[0])), Math.min(...points.map((p) => p[1])), Math.max(...points.map((p) => p[0])), Math.max(...points.map((p) => p[1]))];
}

async function readSubset(url: string, bbox: [number, number, number, number], sample: number): Promise<{ data: Float32Array | Uint16Array; width: number; height: number }> {
  const tiff = await GeoTIFF.fromUrl(url);
  const image = await tiff.getImage();
  const imageBox = image.getBoundingBox();
  const clipped: [number, number, number, number] = [
    Math.max(bbox[0], imageBox[0]), Math.max(bbox[1], imageBox[1]), Math.min(bbox[2], imageBox[2]), Math.min(bbox[3], imageBox[3]),
  ];
  if (clipped[0] >= clipped[2] || clipped[1] >= clipped[3]) throw new Error('A cena Landsat não cobre a extensão do SR2D4.');
  const origin = image.getOrigin(); const resolution = image.getResolution(); const x0 = Math.floor((clipped[0] - origin[0]) / resolution[0]); const x1 = Math.ceil((clipped[2] - origin[0]) / resolution[0]); const y0 = Math.floor((clipped[3] - origin[1]) / resolution[1]); const y1 = Math.ceil((clipped[1] - origin[1]) / resolution[1]);
  const window: [number, number, number, number] = [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
  const result = await image.readRasters({ window, samples: [sample], interleave: true }) as unknown as Float32Array & { width?: number; height?: number };
  const width = Number(result.width ?? Math.max(1, window[2] - window[0]));
  const height = Number(result.height ?? Math.max(1, window[3] - window[1]));
  return { data: result, width, height };
}

export async function fetchNearestLandsatThermal(fileName: string, bounds: RasterBounds): Promise<LandsatThermalSubset> {
  const srDate = parseSr2d4Date(fileName);
  const item = await searchLandsat(srDate, bounds);
  const acquisition = new Date(String(item.properties.datetime));
  const epsg = Number(item.properties['proj:epsg'] ?? 32623);
  const bbox = nativeBbox(bounds, epsg);
  const thermalUrl = await signedHref(String(item.assets.lwir11.href));
  const qaUrl = await signedHref(String(item.assets.qa_pixel.href));
  const [thermal, qa] = await Promise.all([readSubset(thermalUrl, bbox, 0), readSubset(qaUrl, bbox, 0)]);
  if (thermal.width !== qa.width || thermal.height !== qa.height) throw new Error('ST_B10 e QA_PIXEL possuem grades incompatíveis.');
  const lstCelsius = new Float32Array(thermal.data.length);
  const qaPixel = new Uint16Array(qa.data.length);
  for (let i = 0; i < thermal.data.length; i += 1) {
    const dn = Number(thermal.data[i]);
    const qaValue = Number(qa.data[i]);
    qaPixel[i] = qaValue;
    const cloudy = (qaValue & 0b111111) !== 0;
    const kelvin = dn > 0 && dn !== 65535 ? dn * 0.00341802 + 149 : NaN;
    lstCelsius[i] = !cloudy && Number.isFinite(kelvin) && kelvin > 180 && kelvin < 380 ? kelvin - 273.15 : NaN;
  }
  const satellite = item.id.startsWith('LC08') ? 'Landsat 8' : 'Landsat 9';
  return { itemId: item.id, satellite, acquisitionDate: isoDay(acquisition), sourceDate: isoDay(srDate), daysFromSr2d4: dayDistance(acquisition, srDate), cloudCover: Number(item.properties['eo:cloud_cover'] ?? 100), lstCelsius, qaPixel, width: thermal.width, height: thermal.height, bounds, epsg };
}
