// src/tiffReader.ts
import * as GeoTIFF from 'geotiff';

export async function readTiffPixels(file: File): Promise<{
  rasters: any;
  width: number;
  height: number;
  origin: number[];
  resolution: number[];
  epsg: number;
  isProjected: boolean;
}> {
  console.log(`📂 Abrindo arquivo ${file.name}...`);
  
  const arrayBuffer = await file.arrayBuffer();
  const tiff = await GeoTIFF.fromArrayBuffer(arrayBuffer);
  const image = await tiff.getImage();
  const rasters = await image.readRasters();
  
  const width = image.getWidth();
  const height = image.getHeight();
  
  // 🗺️ O PULO DO GATO: Deixar a biblioteca interpretar a Geografia!
  const origin = image.getOrigin();
  const resolution = image.getResolution();
  const geoKeys = image.getGeoKeys();
  
  let epsg = 3857; // Default
  let isProjected = true;

  // Descobre automaticamente se é UTM, Pseudo-Mercator ou WGS84
  if (geoKeys) {
    if (geoKeys.ProjectedCSTypeGeoKey) {
      epsg = geoKeys.ProjectedCSTypeGeoKey;
      isProjected = true;
    } else if (geoKeys.GeographicTypeGeoKey) {
      epsg = geoKeys.GeographicTypeGeoKey;
      isProjected = false;
    }
  }

  console.log(`📍 Geografia Lida - EPSG:${epsg} | Origem:`, origin);

  return {
    rasters,
    width,
    height,
    origin: origin ? Array.from(origin) : [0, 0, 0],
    resolution: resolution ? Array.from(resolution) : [1, 1, 0],
    epsg,
    isProjected
  };
}