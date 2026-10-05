import proj4 from 'proj4';

export type RasterBounds = [[number, number], [number, number], [number, number], [number, number]];

function epsgDef(epsg: number) {
  if (epsg === 4326 || epsg === 4269) return `EPSG:${epsg}`;
  if (epsg === 3857) return 'EPSG:3857';
  return `EPSG:${epsg}`;
}

export function rasterBoundsToWgs84(
  origin: number[], resolution: number[], width: number, height: number, epsg: number,
): RasterBounds {
  const x0 = origin[0] ?? 0;
  const y0 = origin[1] ?? 0;
  const x1 = x0 + (resolution[0] ?? 1) * width;
  const y1 = y0 + (resolution[1] ?? -1) * height;
  const source = epsgDef(epsg);
  const transform = (x: number, y: number): [number, number] => {
    try {
      const out = proj4(source, 'EPSG:4326', [x, y]);
      return [out[0], out[1]];
    } catch {
      return [x, y];
    }
  };
  const corners = [transform(x0, y0), transform(x1, y0), transform(x1, y1), transform(x0, y1)] as RasterBounds;
  const lons = corners.map((p) => p[0]);
  const lats = corners.map((p) => p[1]);
  if (lons.some((v) => !Number.isFinite(v)) || lats.some((v) => !Number.isFinite(v))) {
    return [[-180, 85], [180, 85], [180, -85], [-180, -85]];
  }
  return corners;
}

export function boundsExtent(bounds: RasterBounds) {
  const lons = bounds.map((p) => p[0]);
  const lats = bounds.map((p) => p[1]);
  return { west: Math.min(...lons), east: Math.max(...lons), south: Math.min(...lats), north: Math.max(...lats) };
}
