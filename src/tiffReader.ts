import * as GeoTIFF from 'geotiff';

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
  const bandLabels = extractBandLabels(image, bandCount);
  console.log(`📍 Geografia Lida - EPSG:${epsg} | Origem:`, origin);
  return { rasters, width, height, origin: origin ? Array.from(origin) : [0, 0, 0], resolution: resolution ? Array.from(resolution) : [1, 1, 0], epsg, isProjected, bandLabels };
}
