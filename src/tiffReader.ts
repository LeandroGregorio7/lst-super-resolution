import * as GeoTIFF from 'geotiff';

export function sr2d4TenBandLabels(fileName: string, count: number): string[] | null {
  if (count !== 10 || !/(?:S2L3Ax10|_MS(?:\.|_|$))/i.test(fileName)) return null;
  return [
    'Camada 01 · Sentinel-2 B02 Blue · 490 nm',
    'Camada 02 · Sentinel-2 B03 Green · 560 nm',
    'Camada 03 · Sentinel-2 B04 Red · 665 nm',
    'Camada 04 · Sentinel-2 B05 Red Edge 1 · 705 nm',
    'Camada 05 · Sentinel-2 B06 Red Edge 2 · 740 nm',
    'Camada 06 · Sentinel-2 B07 Red Edge 3 · 783 nm',
    'Camada 07 · Sentinel-2 B08 NIR · 842 nm',
    'Camada 08 · Sentinel-2 B8A Red Edge 4 · 865 nm',
    'Camada 09 · Sentinel-2 B11 SWIR 1 · 1610 nm',
    'Camada 10 · Sentinel-2 B12 SWIR 2 · 2190 nm',
  ];
}

function extractBandLabels(image: any, count: number): string[] {
  const fileDirectory = image.fileDirectory ?? {};
  const labels = Array.from({ length: count }, (_, index) => `Camada ${String(index + 1).padStart(2, '0')} · nome ausente`);
  const description = String(fileDirectory.ImageDescription ?? fileDirectory.GDAL_METADATA ?? '');
  const patterns = [
    /<(?:Item|item)[^>]*sample=["'](\d+)["'][^>]*>([^<]+)</gi,
    /(?:B(?:and)?[_ ]?)(0?[1-9]|1[0-2])\b/gi,
  ];
  let match: RegExpExecArray | null;
  const itemPattern = patterns[0];
  while ((match = itemPattern.exec(description)) !== null) {
    const index = Number(match[1]);
    if (index >= 0 && index < count) labels[index] = match[2].trim();
  }
  const bandPattern = patterns[1];
  let sequentialIndex = 0;
  while ((match = bandPattern.exec(description)) !== null && sequentialIndex < count) {
    if (labels[sequentialIndex].includes('nome ausente')) labels[sequentialIndex] = `Sentinel-2 B${match[1].padStart(2, '0')}`;
    sequentialIndex += 1;
  }
  const bandDescription = fileDirectory.BandDescription ?? fileDirectory.BandDescriptions;
  if (Array.isArray(bandDescription)) bandDescription.forEach((value: unknown, index: number) => { if (index < count && value) labels[index] = String(value); });
  return labels;
}

export async function readTiffPixels(file: File): Promise<{
  rasters: any;
  width: number;
  height: number;
  origin: number[];
  resolution: number[];
  epsg: number;
  isProjected: boolean;
  bandLabels: string[];
}> {
  console.log(`📂 Abrindo arquivo ${file.name}...`);
  const arrayBuffer = await file.arrayBuffer();
  const tiff = await GeoTIFF.fromArrayBuffer(arrayBuffer);
  const image = await tiff.getImage();
  const rasters = await image.readRasters();
  const width = image.getWidth();
  const height = image.getHeight();
  const origin = image.getOrigin();
  const resolution = image.getResolution();
  const geoKeys = image.getGeoKeys();
  const epsg = geoKeys?.ProjectedCSTypeGeoKey ?? geoKeys?.GeographicTypeGeoKey ?? 3857;
  const isProjected = Boolean(geoKeys?.ProjectedCSTypeGeoKey);
  const bandCount = Array.isArray(rasters) ? rasters.length : Number((image.fileDirectory as any)?.SamplesPerPixel ?? 1);
  const bandLabels = sr2d4TenBandLabels(file.name, bandCount) ?? extractBandLabels(image, bandCount);
  console.log(`📍 Geografia Lida - EPSG:${epsg} | Origem:`, origin);
  return { rasters, width, height, origin: origin ? Array.from(origin) : [0, 0, 0], resolution: resolution ? Array.from(resolution) : [1, 1, 0], epsg, isProjected, bandLabels };
}
