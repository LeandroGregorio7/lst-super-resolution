import { describe, expect, it } from 'vitest';
import { calculateOpticalIndices } from './opticalIndices';
import { downscaleLandsatLST } from './downscaling';
import type { RasterBounds } from './rasterGeo';

const bounds: RasterBounds = [[0, 1], [1, 1], [1, 0], [0, 0]];
const gridAlignment = {
  fine: { origin: [0, 60], resolution: [1, -1], epsg: 32631 },
  coarse: { origin: [0, 60], resolution: [10, -10], epsg: 32631 },
};

function makeFeatures(width: number, height: number, withNdwi = true) {
  const ndvi = new Float32Array(width * height);
  const ndbi = new Float32Array(width * height);
  const ndwi = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      ndvi[i] = 0.12 + 0.72 * x / Math.max(width - 1, 1);
      ndbi[i] = 0.28 - 0.56 * y / Math.max(height - 1, 1);
      ndwi[i] = withNdwi ? 0.18 + 0.32 * Math.sin((x + y) / 13) - 0.12 * y / Math.max(height - 1, 1) : NaN;
    }
  }
  return { ndvi, ndbi, ndwi };
}

function makeCoarseTarget(
  features: ReturnType<typeof makeFeatures>,
  fineWidth: number,
  fineHeight: number,
  coarseWidth: number,
  coarseHeight: number,
) {
  const n = coarseWidth * coarseHeight;
  const sums = Array.from({ length: n }, () => [0, 0, 0]);
  const counts = new Uint32Array(n);
  for (let y = 0; y < fineHeight; y += 1) {
    for (let x = 0; x < fineWidth; x += 1) {
      const cx = Math.floor((x + 0.5) / fineWidth * coarseWidth);
      const cy = Math.floor((y + 0.5) / fineHeight * coarseHeight);
      const cell = cy * coarseWidth + cx;
      const i = y * fineWidth + x;
      sums[cell][0] += features.ndvi[i];
      sums[cell][1] += features.ndbi[i];
      if (Number.isFinite(features.ndwi[i])) sums[cell][2] += features.ndwi[i];
      counts[cell] += 1;
    }
  }
  const thermal = new Float32Array(n);
  for (let cell = 0; cell < n; cell += 1) {
    const ndvi = sums[cell][0] / counts[cell];
    const ndbi = sums[cell][1] / counts[cell];
    const ndwi = sums[cell][2] / counts[cell];
    // Known thermal relationship plus a cell-scale residual not explained by optics.
    thermal[cell] = 37 - 8 * ndvi + 5 * ndbi - 3 * ndwi + 0.7 * Math.sin(cell / 4);
  }
  return thermal;
}

describe('SR2D4 spectral indices', () => {
  it('calculates NDVI, NDBI and independent Green-NIR NDWI', () => {
    const result = calculateOpticalIndices(
      new Float32Array([0.2]),
      new Float32Array([0.6]),
      new Float32Array([0.3]),
      new Float32Array([0.15]),
    );
    expect(result.ndvi[0]).toBeCloseTo(0.5, 6);
    expect(result.ndbi[0]).toBeCloseTo(-1 / 3, 6);
    expect(result.ndwi[0]).toBeCloseTo(-0.6, 6);
  });

  it('does not mislabel NIR-SWIR as NDWI when Green is unavailable', () => {
    const result = calculateOpticalIndices(
      new Float32Array([0.2]),
      new Float32Array([0.6]),
      new Float32Array([0.3]),
    );
    expect(Number.isNaN(result.ndwi[0])).toBe(true);
  });
});

describe('LST coarse-to-fine downscaling', () => {
  it('creates fine-scale spectral variation and conserves each coarse-cell mean', () => {
    const fineWidth = 60;
    const fineHeight = 60;
    const coarseWidth = 6;
    const coarseHeight = 6;
    const features = makeFeatures(fineWidth, fineHeight);
    const thermal = makeCoarseTarget(features, fineWidth, fineHeight, coarseWidth, coarseHeight);
    const result = downscaleLandsatLST(
      thermal, coarseWidth, coarseHeight, bounds,
      features, fineWidth, fineHeight, bounds, gridAlignment,
    );

    expect(result.model).toBe('multivariate-NDVI-NDBI-NDWI');
    expect(result.lstDownscaled).toHaveLength(fineWidth * fineHeight);
    expect(result.fineSignalRange).toBeGreaterThan(0.01);
    expect(Number.isFinite(result.r2)).toBe(true);
    expect(result.conservationMae).toBeLessThan(1e-4);

    const sums = new Float64Array(coarseWidth * coarseHeight);
    const counts = new Uint32Array(coarseWidth * coarseHeight);
    for (let y = 0; y < fineHeight; y += 1) {
      for (let x = 0; x < fineWidth; x += 1) {
        const cell = Math.floor((y + 0.5) / fineHeight * coarseHeight) * coarseWidth
          + Math.floor((x + 0.5) / fineWidth * coarseWidth);
        sums[cell] += result.lstDownscaled[y * fineWidth + x];
        counts[cell] += 1;
      }
    }
    for (let cell = 0; cell < thermal.length; cell += 1) {
      expect(sums[cell] / counts[cell]).toBeCloseTo(thermal[cell], 4);
    }
  });

  it('uses a stable NDVI/NDBI fallback when no independent NDWI exists', () => {
    const fineWidth = 60;
    const fineHeight = 60;
    const coarseWidth = 6;
    const coarseHeight = 6;
    const features = makeFeatures(fineWidth, fineHeight, false);
    const thermal = makeCoarseTarget(features, fineWidth, fineHeight, coarseWidth, coarseHeight);
    const result = downscaleLandsatLST(
      thermal, coarseWidth, coarseHeight, bounds,
      features, fineWidth, fineHeight, bounds, gridAlignment,
    );

    expect(result.model).toBe('multivariate-NDVI-NDBI');
    expect(result.conservationMae).toBeLessThan(1e-4);
    expect(result.fineSignalRange).toBeGreaterThan(0.01);
  });
});
