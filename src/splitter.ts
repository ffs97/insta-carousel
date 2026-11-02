import { MediaAsset, NormalizedCrop, Slide, SlideLayer } from './types';
import { computeSmartCrop } from './smartcrop';

/**
 * Recommends the optimal number of slides (2..8) to split an image into
 * given its aspect ratio and the active carousel slide aspect ratio.
 */
export function recommendSlideSplitCount(
  mediaAspectRatio: number,
  slideAspectRatio: number
): number {
  const rawCount = Math.round(mediaAspectRatio / Math.max(0.2, slideAspectRatio));
  return Math.max(2, Math.min(8, rawCount));
}

/**
 * Computes the initial content-aware crop across N consecutive slides.
 */
export function computePanoramaSpanCrop(
  asset: MediaAsset,
  slideCount: number,
  slideAspectRatio: number
): NormalizedCrop {
  const combinedRatio = Math.max(2, slideCount) * slideAspectRatio;
  return computeSmartCrop(asset, combinedRatio);
}

/**
 * Splits a single photo across `slideCount` consecutive slides, returning the generated slides.
 * Each slide gets an exact 1/N horizontal slice of `unifiedCrop` with zero seam gap.
 */
export function createSplitPanoramaSlides(
  asset: MediaAsset,
  unifiedCrop: NormalizedCrop,
  slideCount: number,
  slideWidth: number,
  slideHeight: number,
  backgroundColor = '#0c0c0e'
): Slide[] {
  const count = Math.max(2, Math.min(10, Math.round(slideCount)));
  const spanGroupId = `span_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const sliceCropWidth = unifiedCrop.width / count;

  const slides: Slide[] = [];
  for (let i = 0; i < count; i++) {
    const sliceCrop: NormalizedCrop = {
      x: Math.max(0, Math.min(1 - sliceCropWidth, unifiedCrop.x + i * sliceCropWidth)),
      y: unifiedCrop.y,
      width: sliceCropWidth,
      height: unifiedCrop.height,
    };

    const layer: SlideLayer = {
      id: `layer_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`,
      assetId: asset.id,
      zIndex: 1,
      x: 0,
      y: 0,
      width: slideWidth,
      height: slideHeight,
      cropPreset: 'match-slide',
      lockAspectRatio: true,
      crop: sliceCrop,
      pinZone: 'full',
      borderRadius: 0,
      shadow: false,
      spanGroupId,
      trimStart: 0,
      trimEnd: asset.duration || 0,
      muted: false,
      endBehavior: 'loop',
    };

    slides.push({
      id: `slide_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`,
      layers: [layer],
      background: {
        type: 'solid',
        color: asset.dominantColors[0] || backgroundColor,
        blurIntensity: 36,
      },
      padding: 0,
      gap: 0,
    });
  }

  return slides;
}
