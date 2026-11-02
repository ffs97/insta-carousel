import { MediaAsset, NormalizedCrop } from './types';

const GRID_SIZE = 64;

export interface MediaAnalysisResult {
  smartFocalPoint: { x: number; y: number };
  saliencyIntegral: Float32Array;
  saliencyGridSize: number;
  dominantColors: string[];
  thumbnailUrl: string;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      case b:
        h = (r - g) / d + 4;
        break;
    }
    h /= 6;
  }
  return [h, s, l];
}

/**
 * Evaluates how closely an RGB pixel matches natural human skin tone chromaticity.
 */
function skinToneScore(r: number, g: number, b: number): number {
  const mag = Math.sqrt(r * r + g * g + b * b);
  if (mag < 25 || mag > 420) return 0;
  const nr = r / mag;
  const ng = g / mag;
  const nb = b / mag;
  // Reference skin vector in normalized RGB (~[0.78, 0.51, 0.36])
  const d =
    Math.abs(nr - 0.78) * 1.2 +
    Math.abs(ng - 0.51) * 1.4 +
    Math.abs(nb - 0.36) * 1.4;
  if (d > 0.25 || r <= g || g <= b * 0.85) return 0;
  return Math.max(0, 1 - d / 0.25);
}

/**
 * Queries the sum inside [x0..x1, y0..y1] (0..gridSize) from a (gridSize+1)x(gridSize+1) integral image.
 */
function queryIntegral(
  integral: Float32Array,
  gridSize: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number
): number {
  const stride = gridSize + 1;
  const ix0 = Math.max(0, Math.min(gridSize, Math.round(x0)));
  const iy0 = Math.max(0, Math.min(gridSize, Math.round(y0)));
  const ix1 = Math.max(ix0 + 1, Math.min(gridSize, Math.round(x1)));
  const iy1 = Math.max(iy0 + 1, Math.min(gridSize, Math.round(y1)));

  const A = integral[iy0 * stride + ix0];
  const B = integral[iy0 * stride + ix1];
  const C = integral[iy1 * stride + ix0];
  const D = integral[iy1 * stride + ix1];
  return D - B - C + A;
}

/**
 * Analyzes an image or video frame to extract:
 * 1. A 64x64 saliency integral image (Sobel edge energy + skin tone + saturation)
 * 2. Weighted smart focal center (0..1)
 * 3. Top 5 dominant/harmonious hex colors for slide backgrounds
 * 4. A fast 320px thumbnail data URL
 */
export function analyzeMediaElement(
  source: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement,
  naturalWidth: number,
  naturalHeight: number
): MediaAnalysisResult {
  // 1. Generate thumbnail
  const thumbCanvas = document.createElement('canvas');
  const maxThumb = 320;
  const scale = Math.min(1, maxThumb / Math.max(naturalWidth || 1, naturalHeight || 1));
  thumbCanvas.width = Math.max(1, Math.round((naturalWidth || 320) * scale));
  thumbCanvas.height = Math.max(1, Math.round((naturalHeight || 320) * scale));
  const thumbCtx = thumbCanvas.getContext('2d');
  if (thumbCtx) {
    thumbCtx.drawImage(source, 0, 0, thumbCanvas.width, thumbCanvas.height);
  }
  const thumbnailUrl = thumbCanvas.toDataURL('image/jpeg', 0.82);

  // 2. Saliency analysis on GRID_SIZE x GRID_SIZE
  const canvas = document.createElement('canvas');
  canvas.width = GRID_SIZE;
  canvas.height = GRID_SIZE;
  const ctx = canvas.getContext('2d');
  const stride = GRID_SIZE + 1;
  const integral = new Float32Array(stride * stride);

  if (!ctx) {
    return {
      smartFocalPoint: { x: 0.5, y: 0.5 },
      saliencyIntegral: integral,
      saliencyGridSize: GRID_SIZE,
      dominantColors: ['#18181b', '#27272a', '#f4f4f5', '#3f3f46', '#71717a'],
      thumbnailUrl,
    };
  }

  ctx.drawImage(source, 0, 0, GRID_SIZE, GRID_SIZE);
  const imgData = ctx.getImageData(0, 0, GRID_SIZE, GRID_SIZE).data;

  // Luminance buffer for Sobel edge detection
  const lum = new Float32Array(GRID_SIZE * GRID_SIZE);
  for (let i = 0; i < GRID_SIZE * GRID_SIZE; i++) {
    const r = imgData[i * 4];
    const g = imgData[i * 4 + 1];
    const b = imgData[i * 4 + 2];
    lum[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }

  const saliency = new Float32Array(GRID_SIZE * GRID_SIZE);
  let totalWeight = 0;
  let weightedX = 0;
  let weightedY = 0;

  // Color quantization buckets (4x4x4 RGB cube)
  const colorBuckets = new Map<
    number,
    { count: number; rSum: number; gSum: number; bSum: number; satSum: number }
  >();

  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      const idx = y * GRID_SIZE + x;
      const r = imgData[idx * 4];
      const g = imgData[idx * 4 + 1];
      const b = imgData[idx * 4 + 2];

      // Sobel 3x3 gradient
      let edge = 0;
      if (x > 0 && x < GRID_SIZE - 1 && y > 0 && y < GRID_SIZE - 1) {
        const gx =
          -lum[(y - 1) * GRID_SIZE + (x - 1)] +
          lum[(y - 1) * GRID_SIZE + (x + 1)] -
          2 * lum[y * GRID_SIZE + (x - 1)] +
          2 * lum[y * GRID_SIZE + (x + 1)] -
          lum[(y + 1) * GRID_SIZE + (x - 1)] +
          lum[(y + 1) * GRID_SIZE + (x + 1)];
        const gy =
          -lum[(y - 1) * GRID_SIZE + (x - 1)] -
          2 * lum[(y - 1) * GRID_SIZE + x] -
          lum[(y - 1) * GRID_SIZE + (x + 1)] +
          lum[(y + 1) * GRID_SIZE + (x - 1)] +
          2 * lum[(y + 1) * GRID_SIZE + x] +
          lum[(y + 1) * GRID_SIZE + (x + 1)];
        edge = Math.min(1, Math.sqrt(gx * gx + gy * gy) / 420);
      }

      const [, sat, light] = rgbToHsl(r, g, b);
      const skin = skinToneScore(r, g, b);

      // Gentle upper-center portrait bias (subjects/heads are often in upper-middle)
      const nx = (x + 0.5) / GRID_SIZE;
      const ny = (y + 0.5) / GRID_SIZE;
      const centerBias =
        Math.exp(-((nx - 0.5) ** 2 / 0.28 + (ny - 0.42) ** 2 / 0.28)) * 0.25;

      const score =
        0.05 +
        edge * 1.45 +
        skin * 1.85 +
        sat * (light > 0.12 && light < 0.88 ? 0.65 : 0.15) +
        centerBias;

      saliency[idx] = score;
      const w = score * score;
      totalWeight += w;
      weightedX += nx * w;
      weightedY += ny * w;

      // Collect dominant color sample
      const qr = r >> 5;
      const qg = g >> 5;
      const qb = b >> 5;
      const key = (qr << 6) | (qg << 3) | qb;
      const bucket = colorBuckets.get(key);
      if (bucket) {
        bucket.count++;
        bucket.rSum += r;
        bucket.gSum += g;
        bucket.bSum += b;
        bucket.satSum += sat;
      } else {
        colorBuckets.set(key, { count: 1, rSum: r, gSum: g, bSum: b, satSum: sat });
      }
    }
  }

  // Build 2D Integral Image
  for (let y = 1; y <= GRID_SIZE; y++) {
    let rowSum = 0;
    for (let x = 1; x <= GRID_SIZE; x++) {
      rowSum += saliency[(y - 1) * GRID_SIZE + (x - 1)];
      integral[y * stride + x] = integral[(y - 1) * stride + x] + rowSum;
    }
  }

  const smartFocalPoint =
    totalWeight > 0
      ? {
          x: Math.max(0.1, Math.min(0.9, weightedX / totalWeight)),
          y: Math.max(0.1, Math.min(0.9, weightedY / totalWeight)),
        }
      : { x: 0.5, y: 0.5 };

  // Extract top 5 distinct dominant colors
  const sortedBuckets = Array.from(colorBuckets.values())
    .map((b) => {
      const r = Math.round(b.rSum / b.count);
      const g = Math.round(b.gSum / b.count);
      const bl = Math.round(b.bSum / b.count);
      const avgSat = b.satSum / b.count;
      return {
        r,
        g,
        b: bl,
        score: b.count * (1 + avgSat * 0.8),
      };
    })
    .sort((a, b) => b.score - a.score);

  const selectedColors: { r: number; g: number; b: number }[] = [];
  for (const cand of sortedBuckets) {
    if (selectedColors.length >= 5) break;
    const tooClose = selectedColors.some(
      (c) =>
        Math.hypot(c.r - cand.r, c.g - cand.g, c.b - cand.b) < 42
    );
    if (!tooClose) {
      selectedColors.push(cand);
    }
  }

  const dominantColors = selectedColors.map(
    (c) =>
      `#${c.r.toString(16).padStart(2, '0')}${c.g
        .toString(16)
        .padStart(2, '0')}${c.b.toString(16).padStart(2, '0')}`
  );
  while (dominantColors.length < 5) {
    dominantColors.push('#18181b');
  }

  return {
    smartFocalPoint,
    saliencyIntegral: integral,
    saliencyGridSize: GRID_SIZE,
    dominantColors,
    thumbnailUrl,
  };
}

/**
 * Computes the optimal content-aware NormalizedCrop (0..1 in source media space)
 * for a given target frame aspect ratio (frameWidth / frameHeight).
 */
export function computeSmartCrop(
  asset: Pick<
    MediaAsset,
    'aspectRatio' | 'smartFocalPoint' | 'saliencyIntegral' | 'saliencyGridSize'
  >,
  targetAspectRatio: number
): NormalizedCrop {
  const safeTargetRatio = Math.max(0.1, targetAspectRatio || 1);
  const mediaRatio = Math.max(0.1, asset.aspectRatio || 1);

  // Full-extent crop dimensions in normalized (0..1) source coordinates
  let cropW = 1;
  let cropH = 1;
  if (mediaRatio > safeTargetRatio) {
    // Source is wider than target frame -> full height, narrower width
    cropH = 1;
    cropW = safeTargetRatio / mediaRatio;
  } else {
    // Source is taller than target frame -> full width, shorter height
    cropW = 1;
    cropH = mediaRatio / safeTargetRatio;
  }

  cropW = Math.min(1, Math.max(0.05, cropW));
  cropH = Math.min(1, Math.max(0.05, cropH));

  // If we have a saliency integral image, evaluate candidate windows along the sliding axis
  if (asset.saliencyIntegral && asset.saliencyGridSize) {
    const G = asset.saliencyGridSize;
    const integral = asset.saliencyIntegral;
    const steps = 28;
    let bestScore = -Infinity;
    let bestX = (1 - cropW) / 2;
    let bestY = (1 - cropH) / 2;

    const maxX = Math.max(0, 1 - cropW);
    const maxY = Math.max(0, 1 - cropH);

    const xSteps = maxX > 0.001 ? steps : 1;
    const ySteps = maxY > 0.001 ? steps : 1;

    for (let iy = 0; iy < ySteps; iy++) {
      const ny = ySteps === 1 ? 0 : (iy / (ySteps - 1)) * maxY;
      for (let ix = 0; ix < xSteps; ix++) {
        const nx = xSteps === 1 ? 0 : (ix / (xSteps - 1)) * maxX;

        // Saliency inside the candidate window
        const mainEnergy = queryIntegral(
          integral,
          G,
          nx * G,
          ny * G,
          (nx + cropW) * G,
          (ny + cropH) * G
        );

        // Rule-of-thirds inner core bonus (subjects placed near the middle/thirds of the crop)
        const padX = cropW * 0.16;
        const padY = cropH * 0.16;
        const innerEnergy = queryIntegral(
          integral,
          G,
          (nx + padX) * G,
          (ny + padY) * G,
          (nx + cropW - padX) * G,
          (ny + cropH - padY) * G
        );

        // Proximity to smart focal center
        const cx = nx + cropW / 2;
        const cy = ny + cropH / 2;
        const distToFocal = Math.hypot(
          cx - asset.smartFocalPoint.x,
          cy - asset.smartFocalPoint.y
        );

        const candidateScore =
          mainEnergy + innerEnergy * 0.45 - distToFocal * G * 1.5;

        if (candidateScore > bestScore) {
          bestScore = candidateScore;
          bestX = nx;
          bestY = ny;
        }
      }
    }

    return {
      x: Math.max(0, Math.min(1 - cropW, bestX)),
      y: Math.max(0, Math.min(1 - cropH, bestY)),
      width: cropW,
      height: cropH,
    };
  }

  // Fallback: center crop around smartFocalPoint
  const x = Math.max(0, Math.min(1 - cropW, asset.smartFocalPoint.x - cropW / 2));
  const y = Math.max(0, Math.min(1 - cropH, asset.smartFocalPoint.y - cropH / 2));
  return { x, y, width: cropW, height: cropH };
}

/**
 * Adjusts an existing NormalizedCrop to match a new frame aspect ratio
 * WITHOUT running smart auto-crop recalculation — strictly preserves the
 * user's current crop center and zoom level.
 */
export function adjustCropPreservingCenter(
  currentCrop: NormalizedCrop,
  mediaAspectRatio: number,
  newFrameAspectRatio: number
): NormalizedCrop {
  const safeTargetRatio = Math.max(0.1, newFrameAspectRatio || 1);
  const safeMediaRatio = Math.max(0.1, mediaAspectRatio || 1);

  const cx = currentCrop.x + currentCrop.width / 2;
  const cy = currentCrop.y + currentCrop.height / 2;

  // Preserve current zoom scale relative to full image
  const currentScale = Math.min(1, Math.max(currentCrop.width, currentCrop.height));

  let baseW = 1;
  let baseH = 1;
  if (safeMediaRatio > safeTargetRatio) {
    baseH = 1;
    baseW = safeTargetRatio / safeMediaRatio;
  } else {
    baseW = 1;
    baseH = safeMediaRatio / safeTargetRatio;
  }

  const width = Math.min(1, Math.max(0.05, baseW * currentScale));
  const height = Math.min(1, Math.max(0.05, baseH * currentScale));

  const x = Math.max(0, Math.min(1 - width, cx - width / 2));
  const y = Math.max(0, Math.min(1 - height, cy - height / 2));

  return { x, y, width, height };
}

/**
 * Computes a straightforward geometric center crop (for "Reset to Center").
 */
export function computeCenterCrop(
  mediaAspectRatio: number,
  targetAspectRatio: number
): NormalizedCrop {
  const safeTargetRatio = Math.max(0.1, targetAspectRatio || 1);
  const safeMediaRatio = Math.max(0.1, mediaAspectRatio || 1);

  let width = 1;
  let height = 1;
  if (safeMediaRatio > safeTargetRatio) {
    height = 1;
    width = safeTargetRatio / safeMediaRatio;
  } else {
    width = 1;
    height = safeMediaRatio / safeTargetRatio;
  }
  return {
    x: (1 - width) / 2,
    y: (1 - height) / 2,
    width,
    height,
  };
}
