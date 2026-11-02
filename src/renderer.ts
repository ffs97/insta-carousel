import {
  MediaAsset,
  Slide,
  SlideLayer,
  SnapGuide,
} from './types';

export interface BridgedLayerItem {
  layer: SlideLayer;
  originSlideIndex: number;
  /** X coordinate translated into the target slide's [0..slideWidth] coordinate space */
  localX: number;
}

/**
 * Collects all layers visible on `targetSlideIndex`, including layers from adjacent
 * slides that bridge across slide boundaries (P-1 Cross-Slide Bridging).
 */
export function getVisibleLayersForSlide(
  slides: Slide[],
  targetSlideIndex: number,
  slideWidth: number
): BridgedLayerItem[] {
  const result: BridgedLayerItem[] = [];
  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i];
    const offsetX = (i - targetSlideIndex) * slideWidth;
    for (const layer of slide.layers) {
      const localX = layer.x + offsetX;
      // Check if horizontal span [localX, localX + layer.width] intersects [0, slideWidth]
      if (localX + layer.width > 0.5 && localX < slideWidth - 0.5) {
        result.push({
          layer,
          originSlideIndex: i,
          localX,
        });
      }
    }
  }
  result.sort((a, b) => a.layer.zIndex - b.layer.zIndex);
  return result;
}

function addRoundedRectSubpath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function drawRoundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  ctx.beginPath();
  addRoundedRectSubpath(ctx, x, y, w, h, r);
}

function hexToRgba(hex: string, opacity: number): string {
  const clean = (hex || '#000000').replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16) || 0;
  const g = parseInt(clean.slice(2, 4), 16) || 0;
  const b = parseInt(clean.slice(4, 6), 16) || 0;
  const a = Math.max(0, Math.min(1, opacity));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export interface RenderSlideOptions {
  slides: Slide[];
  slideIndex: number;
  slideWidth: number;
  slideHeight: number;
  assetsById: Map<string, MediaAsset>;
  /** Scale factor from slide space (1080w) to target canvas pixels */
  scale: number;
  /** Destination X offset on target canvas (used in Strip View) */
  offsetX?: number;
  /** Destination Y offset on target canvas */
  offsetY?: number;
  selectedLayerId?: string | null;
  cropModeLayerId?: string | null;
  snapGuides?: SnapGuide[];
  showInstagramChromeGuide?: boolean;
  showProfileGridGuide?: boolean;
  showSmartFocalPoints?: boolean;
  isExport?: boolean;
}

/**
 * Renders a single slide (and any bridged cross-slide layers) onto a 2D canvas context.
 */
export function renderSlideToCanvas(
  ctx: CanvasRenderingContext2D,
  opts: RenderSlideOptions
): void {
  const {
    slides,
    slideIndex,
    slideWidth,
    slideHeight,
    assetsById,
    scale,
    offsetX = 0,
    offsetY = 0,
    selectedLayerId = null,
    cropModeLayerId = null,
    snapGuides = [],
    showInstagramChromeGuide = false,
    showProfileGridGuide = false,
    showSmartFocalPoints = false,
    isExport = false,
  } = opts;

  const slide = slides[slideIndex];
  if (!slide) return;

  const dstW = slideWidth * scale;
  const dstH = slideHeight * scale;

  ctx.save();
  // Clip to slide bounds
  ctx.beginPath();
  ctx.rect(offsetX, offsetY, dstW, dstH);
  ctx.clip();

  // 1. Render Slide Background (P-3)
  ctx.fillStyle = slide.background.color || '#0c0c0e';
  ctx.fillRect(offsetX, offsetY, dstW, dstH);

  if (slide.background.type === 'blur') {
    const primaryAssetId =
      slide.background.blurAssetId || slide.layers[0]?.assetId;
    const bgAsset = primaryAssetId ? assetsById.get(primaryAssetId) : undefined;
    if (bgAsset?.element) {
      ctx.save();
      const blurPx = Math.max(8, (slide.background.blurIntensity || 36) * scale);
      ctx.filter = `blur(${blurPx}px) brightness(0.72) saturate(1.25)`;
      // Cover-fit background element with 15% overscan to avoid blur edge bleed
      const overscan = 1.18;
      const mediaRatio = bgAsset.aspectRatio || 1;
      const slideRatio = slideWidth / slideHeight;
      let bw = dstW * overscan;
      let bh = dstH * overscan;
      if (mediaRatio > slideRatio) {
        bw = bh * mediaRatio;
      } else {
        bh = bw / mediaRatio;
      }
      const bx = offsetX + (dstW - bw) / 2;
      const by = offsetY + (dstH - bh) / 2;
      ctx.drawImage(bgAsset.element, bx, by, bw, bh);
      ctx.restore();
    }
  }

  // 2. Render Visible Media Layers (FR-4, FR-6, P-1)
  const visibleItems = getVisibleLayersForSlide(slides, slideIndex, slideWidth);

  if (!isExport && visibleItems.length === 0) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 6]);
    const inset = Math.round(36 * scale);
    ctx.strokeRect(
      offsetX + inset,
      offsetY + inset,
      dstW - inset * 2,
      dstH - inset * 2
    );
    ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.font = '500 12px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(
      `Slide #${slideIndex + 1}`,
      offsetX + dstW / 2,
      offsetY + dstH / 2
    );
    ctx.restore();
  }

  for (const item of visibleItems) {
    const { layer, localX } = item;
    const asset = assetsById.get(layer.assetId);
    if (!asset || !asset.element) continue;

    const dx = offsetX + localX * scale;
    const dy = offsetY + layer.y * scale;
    const dw = layer.width * scale;
    const dh = layer.height * scale;
    const radius = (layer.borderRadius || 0) * scale;

    const sx = layer.crop.x * asset.naturalWidth;
    const sy = layer.crop.y * asset.naturalHeight;
    const sw = Math.max(1, layer.crop.width * asset.naturalWidth);
    const sh = Math.max(1, layer.crop.height * asset.naturalHeight);

    const isCropActive = !isExport && cropModeLayerId === layer.id;

    // If this layer is in interactive Crop Mode, draw the dimmed full source media ghost outside the frame
    if (isCropActive) {
      ctx.save();
      ctx.globalAlpha = 0.28;
      const fullW = dw / Math.max(0.05, layer.crop.width);
      const fullH = dh / Math.max(0.05, layer.crop.height);
      const fullX = dx - layer.crop.x * fullW;
      const fullY = dy - layer.crop.y * fullH;
      ctx.drawImage(asset.element, fullX, fullY, fullW, fullH);
      ctx.restore();
    }

    // Configurable outside drop shadow (clipped to exterior of rounded rect so fill never fringes image edges)
    if (layer.shadow) {
      const sBlur = Math.max(0, (layer.shadowBlur ?? 24) * scale);
      const sOffX = (layer.shadowOffsetX ?? 0) * scale;
      const sOffY = (layer.shadowOffsetY ?? 12) * scale;
      const sOpacity = layer.shadowOpacity ?? 0.45;
      const sColor = layer.shadowColor || '#000000';

      if (sOpacity > 0 && (sBlur > 0 || sOffX !== 0 || sOffY !== 0)) {
        ctx.save();
        // Even-odd clip masks out the interior of the photo so only the outer drop shadow renders
        ctx.beginPath();
        ctx.rect(offsetX - 200, offsetY - 200, dstW + 400, dstH + 400);
        addRoundedRectSubpath(ctx, dx, dy, dw, dh, radius);
        ctx.clip('evenodd');

        ctx.shadowColor = hexToRgba(sColor, sOpacity);
        ctx.shadowBlur = sBlur;
        ctx.shadowOffsetX = sOffX;
        ctx.shadowOffsetY = sOffY;
        drawRoundedRectPath(ctx, dx, dy, dw, dh, radius);
        ctx.fillStyle = '#000000';
        ctx.fill();
        ctx.restore();
      }
    }

    // Draw clipped cropped media
    ctx.save();
    drawRoundedRectPath(ctx, dx, dy, dw, dh, radius);
    ctx.clip();
    ctx.drawImage(
      asset.element,
      sx,
      sy,
      sw,
      sh,
      dx,
      dy,
      dw,
      dh
    );

    // Smart Focal Point indicator when toggled
    if (!isExport && showSmartFocalPoints) {
      const fx =
        dx +
        ((asset.smartFocalPoint.x - layer.crop.x) /
          Math.max(0.01, layer.crop.width)) *
          dw;
      const fy =
        dy +
        ((asset.smartFocalPoint.y - layer.crop.y) /
          Math.max(0.01, layer.crop.height)) *
          dh;
      ctx.beginPath();
      ctx.arc(fx, fy, 7, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(245, 158, 11, 0.9)';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
    }
    ctx.restore();

    // Editor Selection & Crop Overlays
    if (!isExport && selectedLayerId === layer.id) {
      ctx.save();
      drawRoundedRectPath(ctx, dx, dy, dw, dh, radius);
      ctx.lineWidth = isCropActive ? 2.5 : 2;
      ctx.strokeStyle = isCropActive ? '#f59e0b' : '#38bdf8';
      ctx.stroke();

      // Rule of thirds grid in crop mode or when selected
      ctx.beginPath();
      ctx.strokeStyle = isCropActive
        ? 'rgba(245, 158, 11, 0.55)'
        : 'rgba(255, 255, 255, 0.25)';
      ctx.lineWidth = 1;
      for (let t = 1; t <= 2; t++) {
        const gx = dx + (dw * t) / 3;
        const gy = dy + (dh * t) / 3;
        ctx.moveTo(gx, dy);
        ctx.lineTo(gx, dy + dh);
        ctx.moveTo(dx, gy);
        ctx.lineTo(dx + dw, gy);
      }
      ctx.stroke();

      // 8 Resize Handles
      const handleSize = 8;
      const handles = [
        [dx, dy],
        [dx + dw / 2, dy],
        [dx + dw, dy],
        [dx + dw, dy + dh / 2],
        [dx + dw, dy + dh],
        [dx + dw / 2, dy + dh],
        [dx, dy + dh],
        [dx, dy + dh / 2],
      ];
      for (const [hx, hy] of handles) {
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = isCropActive ? '#d97706' : '#0284c7';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.rect(
          hx - handleSize / 2,
          hy - handleSize / 2,
          handleSize,
          handleSize
        );
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  // 3. Magnetic Snap Guides (FR-6)
  if (!isExport && snapGuides.length > 0) {
    ctx.save();
    for (const g of snapGuides) {
      ctx.beginPath();
      ctx.strokeStyle =
        g.type === 'center'
          ? '#f43f5e'
          : g.type === 'layer'
          ? '#ec4899'
          : '#22d3ee';
      ctx.lineWidth = 1.5;
      ctx.setLineDash(g.type === 'thirds' || g.type === 'margin' ? [5, 4] : []);

      if (g.orientation === 'vertical') {
        const gx = offsetX + g.position * scale;
        ctx.moveTo(gx, offsetY + g.start * scale);
        ctx.lineTo(gx, offsetY + g.end * scale);
        ctx.stroke();

        if (g.label) {
          ctx.setLineDash([]);
          ctx.font = '600 11px Inter, sans-serif';
          const tw = ctx.measureText(g.label).width + 10;
          ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
          ctx.fillRect(gx - tw / 2, offsetY + 12, tw, 20);
          ctx.fillStyle = '#f8fafc';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(g.label, gx, offsetY + 22);
        }
      } else {
        const gy = offsetY + g.position * scale;
        ctx.moveTo(offsetX + g.start * scale, gy);
        ctx.lineTo(offsetX + g.end * scale, gy);
        ctx.stroke();

        if (g.label) {
          ctx.setLineDash([]);
          ctx.font = '600 11px Inter, sans-serif';
          const tw = ctx.measureText(g.label).width + 10;
          ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
          ctx.fillRect(offsetX + 12, gy - 10, tw, 20);
          ctx.fillStyle = '#f8fafc';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(g.label, offsetX + 12 + tw / 2, gy);
        }
      }
    }
    ctx.restore();
  }

  // 4. 1:1 Profile Grid Safe Zone Overlay on Cover Slide (P-2)
  if (!isExport && showProfileGridGuide && slideIndex === 0 && slideWidth !== slideHeight) {
    ctx.save();
    const squareSize = Math.min(dstW, dstH);
    const sqX = offsetX + (dstW - squareSize) / 2;
    const sqY = offsetY + (dstH - squareSize) / 2;

    ctx.fillStyle = 'rgba(9, 9, 11, 0.48)';
    if (dstH > dstW) {
      ctx.fillRect(offsetX, offsetY, dstW, sqY - offsetY);
      ctx.fillRect(offsetX, sqY + squareSize, dstW, offsetY + dstH - (sqY + squareSize));
    } else {
      ctx.fillRect(offsetX, offsetY, sqX - offsetX, dstH);
      ctx.fillRect(sqX + squareSize, offsetY, offsetX + dstW - (sqX + squareSize), dstH);
    }

    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(sqX, sqY, squareSize, squareSize);

    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(245, 158, 11, 0.92)';
    ctx.font = '600 11px Inter, sans-serif';
    ctx.fillRect(sqX + 8, sqY + 8, 136, 20);
    ctx.fillStyle = '#09090b';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('1:1 Profile Grid Safe Zone', sqX + 14, sqY + 18);
    ctx.restore();
  }

  // 5. Instagram UI Chrome Obstruction Safe Zones (P-5)
  if (!isExport && showInstagramChromeGuide) {
    ctx.save();
    // Top-right 1/N pill counter
    const pillW = 54;
    const pillH = 26;
    const pillX = offsetX + dstW - pillW - 14;
    const pillY = offsetY + 14;
    drawRoundedRectPath(ctx, pillX, pillY, pillW, pillH, 13);
    ctx.fillStyle = 'rgba(15, 15, 18, 0.78)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = '600 11px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${slideIndex + 1}/${slides.length}`, pillX + pillW / 2, pillY + pillH / 2);

    // Bottom-left tag / audio bubble obstruction indicator
    const tagR = 14;
    const tagX = offsetX + 14 + tagR;
    const tagY = offsetY + dstH - 14 - tagR;
    ctx.beginPath();
    ctx.arc(tagX, tagY, tagR, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(15, 15, 18, 0.78)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = '600 10px Inter, sans-serif';
    ctx.fillText('TAG', tagX, tagY);

    // Bottom-right audio mute button obstruction
    const muteX = offsetX + dstW - 14 - tagR;
    ctx.beginPath();
    ctx.arc(muteX, tagY, tagR, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(15, 15, 18, 0.78)';
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.fillText('VOL', muteX, tagY);
    ctx.restore();
  }

  ctx.restore();
}
