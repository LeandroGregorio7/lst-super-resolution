import type { RasterBounds } from './rasterGeo';

type UhiProperties = {
  class: 'cool' | 'light' | 'moderate' | 'extreme';
  temperature: number;
  intensity: number;
};

export type UhiSurface = {
  type: 'FeatureCollection';
  features: {
    type: 'Feature';
    properties: UhiProperties;
    geometry: { type: 'Polygon'; coordinates: [[number, number][]] };
  }[];
};

type SurfaceInput = {
  data: Float32Array;
  width: number;
  height: number;
  bounds: RasterBounds;
  mean: number;
  stdDev: number;
};

function classify(value: number, mean: number, stdDev: number): UhiProperties['class'] {
  if (value < mean) return 'cool';
  if (value < mean + 0.5 * stdDev) return 'light';
  if (value < mean + 1.5 * stdDev) return 'moderate';
  return 'extreme';
}

/**
 * Creates a compact vector surface from the LST raster. A 3x3 neighborhood
 * average reduces pixel noise before vectorizing a maximum 96x96 grid. This
 * is a reproducible browser-side spatial estimate, not a replacement for
 * kriging or field observations.
 */
export function buildUhiSurface(input: SurfaceInput): UhiSurface {
  const extent = {
    west: Math.min(...input.bounds.map((point) => point[0])),
    east: Math.max(...input.bounds.map((point) => point[0])),
    south: Math.min(...input.bounds.map((point) => point[1])),
    north: Math.max(...input.bounds.map((point) => point[1])),
  };
  const columns = Math.min(96, Math.max(12, Math.ceil(input.width / Math.max(1, Math.ceil(input.width / 96)))));
  const rows = Math.min(96, Math.max(12, Math.ceil(input.height / Math.max(1, Math.ceil(input.height / 96)))));
  const features: UhiSurface['features'] = [];
  const sample = (x: number, y: number) => {
    let total = 0;
    let count = 0;
    for (let oy = -1; oy <= 1; oy += 1) for (let ox = -1; ox <= 1; ox += 1) {
      const sx = Math.min(input.width - 1, Math.max(0, x + ox));
      const sy = Math.min(input.height - 1, Math.max(0, y + oy));
      const value = input.data[sy * input.width + sx];
      if (Number.isFinite(value)) { total += value; count += 1; }
    }
    return count ? total / count : NaN;
  };
  for (let row = 0; row < rows; row += 1) for (let column = 0; column < columns; column += 1) {
    const x0 = Math.floor(column * input.width / columns);
    const x1 = Math.max(x0, Math.ceil((column + 1) * input.width / columns) - 1);
    const y0 = Math.floor(row * input.height / rows);
    const y1 = Math.max(y0, Math.ceil((row + 1) * input.height / rows) - 1);
    const values = [sample(x0, y0), sample(x1, y0), sample(x1, y1), sample(x0, y1)].filter(Number.isFinite) as number[];
    if (!values.length) continue;
    const temperature = values.reduce((sum, value) => sum + value, 0) / values.length;
    const west = extent.west + column / columns * (extent.east - extent.west);
    const east = extent.west + (column + 1) / columns * (extent.east - extent.west);
    const north = extent.north - row / rows * (extent.north - extent.south);
    const south = extent.north - (row + 1) / rows * (extent.north - extent.south);
    features.push({
      type: 'Feature',
      properties: { class: classify(temperature, input.mean, input.stdDev), temperature, intensity: temperature - input.mean },
      geometry: { type: 'Polygon', coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] },
    });
  }
  return { type: 'FeatureCollection', features };
}

export function downloadUhiSurface(surface: UhiSurface, filename = 'SR2D4-UHI-superficie.geojson') {
  const blob = new Blob([JSON.stringify(surface, null, 2)], { type: 'application/geo+json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
