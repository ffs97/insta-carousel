import { MediaAsset, PinZone, SlideLayer, SnapGuide } from './types';
import { adjustCropPreservingCenter } from './smartcrop';

export const SNAP_THRESHOLD_PX = 12;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SnapResult {
  rect: Rect;
  guides: SnapGuide[];
}

interface SnapTarget {
  pos: number;
  type: SnapGuide['type'];
  label?: string;
  spanStart: number;
  spanEnd: number;
}

/**
 * Computes magnetic snapping when dragging (translating) a layer on a slide.
 */
export function computeSnapMove(
  proposed: Rect,
  otherLayers: SlideLayer[],
  slideWidth: number,
  slideHeight: number,
  padding: number,
  gap: number,
  allowCrossSlide: boolean,
  threshold = SNAP_THRESHOLD_PX
): SnapResult {
  let { x, y } = proposed;
  const { width, height } = proposed;
  const guides: SnapGuide[] = [];

  const vTargets: SnapTarget[] = [
    { pos: 0, type: 'edge', label: 'Slide Edge', spanStart: 0, spanEnd: slideHeight },
    { pos: slideWidth, type: 'edge', label: 'Slide Edge', spanStart: 0, spanEnd: slideHeight },
    { pos: slideWidth / 2, type: 'center', label: 'Center X', spanStart: 0, spanEnd: slideHeight },
    { pos: slideWidth / 3, type: 'thirds', label: '1/3', spanStart: 0, spanEnd: slideHeight },
    { pos: (slideWidth * 2) / 3, type: 'thirds', label: '2/3', spanStart: 0, spanEnd: slideHeight },
  ];

  if (padding > 0) {
    vTargets.push(
      { pos: padding, type: 'margin', label: `Margin ${padding}px`, spanStart: 0, spanEnd: slideHeight },
      {
        pos: slideWidth - padding,
        type: 'margin',
        label: `Margin ${padding}px`,
        spanStart: 0,
        spanEnd: slideHeight,
      }
    );
  }

  if (allowCrossSlide) {
    vTargets.push(
      { pos: -slideWidth / 2, type: 'seam', label: 'Prev Slide Center', spanStart: 0, spanEnd: slideHeight },
      { pos: slideWidth * 1.5, type: 'seam', label: 'Next Slide Center', spanStart: 0, spanEnd: slideHeight },
      { pos: slideWidth * 2, type: 'seam', label: 'Next Slide Edge', spanStart: 0, spanEnd: slideHeight }
    );
  }

  const hTargets: SnapTarget[] = [
    { pos: 0, type: 'edge', label: 'Top Edge', spanStart: 0, spanEnd: slideWidth },
    { pos: slideHeight, type: 'edge', label: 'Bottom Edge', spanStart: 0, spanEnd: slideWidth },
    { pos: slideHeight / 2, type: 'center', label: 'Center Y', spanStart: 0, spanEnd: slideWidth },
    { pos: slideHeight / 3, type: 'thirds', label: '1/3', spanStart: 0, spanEnd: slideWidth },
    { pos: (slideHeight * 2) / 3, type: 'thirds', label: '2/3', spanStart: 0, spanEnd: slideWidth },
  ];

  if (padding > 0) {
    hTargets.push(
      { pos: padding, type: 'margin', label: `Margin ${padding}px`, spanStart: 0, spanEnd: slideWidth },
      {
        pos: slideHeight - padding,
        type: 'margin',
        label: `Margin ${padding}px`,
        spanStart: 0,
        spanEnd: slideWidth,
      }
    );
  }

  for (const other of otherLayers) {
    const ox0 = other.x;
    const ox1 = other.x + other.width;
    const ocx = other.x + other.width / 2;
    const oy0 = other.y;
    const oy1 = other.y + other.height;
    const ocy = other.y + other.height / 2;

    vTargets.push(
      { pos: ox0, type: 'layer', label: 'Align Left', spanStart: Math.min(y, oy0), spanEnd: Math.max(y + height, oy1) },
      { pos: ox1, type: 'layer', label: 'Align Right', spanStart: Math.min(y, oy0), spanEnd: Math.max(y + height, oy1) },
      { pos: ocx, type: 'layer', label: 'Align Center', spanStart: Math.min(y, oy0), spanEnd: Math.max(y + height, oy1) }
    );
    if (gap >= 0) {
      vTargets.push(
        {
          pos: ox1 + gap,
          type: 'layer',
          label: gap > 0 ? `Gap ${gap}px` : 'Flush',
          spanStart: Math.min(y, oy0),
          spanEnd: Math.max(y + height, oy1),
        },
        {
          pos: ox0 - gap - width,
          type: 'layer',
          label: gap > 0 ? `Gap ${gap}px` : 'Flush',
          spanStart: Math.min(y, oy0),
          spanEnd: Math.max(y + height, oy1),
        }
      );
    }

    hTargets.push(
      { pos: oy0, type: 'layer', label: 'Align Top', spanStart: Math.min(x, ox0), spanEnd: Math.max(x + width, ox1) },
      { pos: oy1, type: 'layer', label: 'Align Bottom', spanStart: Math.min(x, ox0), spanEnd: Math.max(x + width, ox1) },
      { pos: ocy, type: 'layer', label: 'Align Middle', spanStart: Math.min(x, ox0), spanEnd: Math.max(x + width, ox1) }
    );
    if (gap >= 0) {
      hTargets.push(
        {
          pos: oy1 + gap,
          type: 'layer',
          label: gap > 0 ? `Gap ${gap}px` : 'Flush',
          spanStart: Math.min(x, ox0),
          spanEnd: Math.max(x + width, ox1),
        },
        {
          pos: oy0 - gap - height,
          type: 'layer',
          label: gap > 0 ? `Gap ${gap}px` : 'Flush',
          spanStart: Math.min(x, ox0),
          spanEnd: Math.max(x + width, ox1),
        }
      );
    }
  }

  // Test X anchor points on dragged rect: left (0), center (width/2), right (width)
  let bestDx = Infinity;
  let bestVGuide: SnapGuide | null = null;
  const xAnchors = [0, width / 2, width];

  for (const anchorOffset of xAnchors) {
    const anchorX = x + anchorOffset;
    for (const t of vTargets) {
      // Gap targets already baked -width into pos when needed, only match left edge for gap-left
      const diff = t.pos - anchorX;
      if (Math.abs(diff) < Math.abs(bestDx) && Math.abs(diff) <= threshold) {
        bestDx = diff;
        bestVGuide = {
          orientation: 'vertical',
          position: t.pos,
          start: t.spanStart,
          end: t.spanEnd,
          label: t.label,
          type: t.type,
        };
      }
    }
  }

  if (bestVGuide && Math.abs(bestDx) <= threshold) {
    x += bestDx;
    guides.push(bestVGuide);
  }

  // Test Y anchor points on dragged rect: top (0), middle (height/2), bottom (height)
  let bestDy = Infinity;
  let bestHGuide: SnapGuide | null = null;
  const yAnchors = [0, height / 2, height];

  for (const anchorOffset of yAnchors) {
    const anchorY = y + anchorOffset;
    for (const t of hTargets) {
      const diff = t.pos - anchorY;
      if (Math.abs(diff) < Math.abs(bestDy) && Math.abs(diff) <= threshold) {
        bestDy = diff;
        bestHGuide = {
          orientation: 'horizontal',
          position: t.pos,
          start: t.spanStart,
          end: t.spanEnd,
          label: t.label,
          type: t.type,
        };
      }
    }
  }

  if (bestHGuide && Math.abs(bestDy) <= threshold) {
    y += bestDy;
    guides.push(bestHGuide);
  }

  return {
    rect: { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) },
    guides,
  };
}

/**
 * Computes the target rectangle for a PinZone on a slide, respecting padding and gap.
 */
export function getPinZoneRect(
  zone: Exclude<PinZone, null>,
  slideWidth: number,
  slideHeight: number,
  padding: number,
  gap: number
): Rect {
  const innerX = padding;
  const innerY = padding;
  const innerW = Math.max(100, slideWidth - padding * 2);
  const innerH = Math.max(100, slideHeight - padding * 2);
  const halfW = (innerW - gap) / 2;
  const halfH = (innerH - gap) / 2;

  switch (zone) {
    case 'full':
      return { x: innerX, y: innerY, width: innerW, height: innerH };
    case 'left-half':
      return { x: innerX, y: innerY, width: halfW, height: innerH };
    case 'right-half':
      return { x: innerX + halfW + gap, y: innerY, width: halfW, height: innerH };
    case 'top-half':
      return { x: innerX, y: innerY, width: innerW, height: halfH };
    case 'bottom-half':
      return { x: innerX, y: innerY + halfH + gap, width: innerW, height: halfH };
    case 'top-left':
      return { x: innerX, y: innerY, width: halfW, height: halfH };
    case 'top-right':
      return { x: innerX + halfW + gap, y: innerY, width: halfW, height: halfH };
    case 'bottom-left':
      return { x: innerX, y: innerY + halfH + gap, width: halfW, height: halfH };
    case 'bottom-right':
      return { x: innerX + halfW + gap, y: innerY + halfH + gap, width: halfW, height: halfH };
    case 'center': {
      const cw = Math.round(innerW * 0.78);
      const ch = Math.round(innerH * 0.78);
      return {
        x: Math.round(innerX + (innerW - cw) / 2),
        y: Math.round(innerY + (innerH - ch) / 2),
        width: cw,
        height: ch,
      };
    }
  }
}

export type CollageTemplateId =
  | 'single-full'
  | 'single-card'
  | '2-side-by-side'
  | '2-stacked'
  | '2-editorial'
  | '3-left-hero'
  | '3-top-hero'
  | '3-columns'
  | '4-grid';

export interface CollageTemplateSpec {
  id: CollageTemplateId;
  label: string;
  minLayers: number;
  slots: (slideW: number, slideH: number, pad: number, gap: number) => { rect: Rect; pinZone: PinZone }[];
}

export const COLLAGE_TEMPLATES: CollageTemplateSpec[] = [
  {
    id: 'single-full',
    label: 'Full Bleed',
    minLayers: 1,
    slots: (w, h, p, g) => [{ rect: getPinZoneRect('full', w, h, p, g), pinZone: 'full' }],
  },
  {
    id: 'single-card',
    label: 'Editorial Frame',
    minLayers: 1,
    slots: (w, h, p, g) => [{ rect: getPinZoneRect('center', w, h, p, g), pinZone: 'center' }],
  },
  {
    id: '2-side-by-side',
    label: '2-Up Left / Right',
    minLayers: 2,
    slots: (w, h, p, g) => [
      { rect: getPinZoneRect('left-half', w, h, p, g), pinZone: 'left-half' },
      { rect: getPinZoneRect('right-half', w, h, p, g), pinZone: 'right-half' },
    ],
  },
  {
    id: '2-stacked',
    label: '2-Up Top / Bottom',
    minLayers: 2,
    slots: (w, h, p, g) => [
      { rect: getPinZoneRect('top-half', w, h, p, g), pinZone: 'top-half' },
      { rect: getPinZoneRect('bottom-half', w, h, p, g), pinZone: 'bottom-half' },
    ],
  },
  {
    id: '2-editorial',
    label: '2-Up Offset',
    minLayers: 2,
    slots: (w, h, p) => {
      const pad = Math.max(48, p);
      const innerW = w - pad * 2;
      const innerH = h - pad * 2;
      return [
        {
          rect: {
            x: pad,
            y: pad,
            width: Math.round(innerW * 0.64),
            height: Math.round(innerH * 0.74),
          },
          pinZone: null,
        },
        {
          rect: {
            x: Math.round(pad + innerW * 0.44),
            y: Math.round(pad + innerH * 0.42),
            width: Math.round(innerW * 0.56),
            height: Math.round(innerH * 0.58),
          },
          pinZone: null,
        },
      ];
    },
  },
  {
    id: '3-left-hero',
    label: '3-Up Hero Left',
    minLayers: 3,
    slots: (w, h, p, g) => [
      { rect: getPinZoneRect('left-half', w, h, p, g), pinZone: 'left-half' },
      { rect: getPinZoneRect('top-right', w, h, p, g), pinZone: 'top-right' },
      { rect: getPinZoneRect('bottom-right', w, h, p, g), pinZone: 'bottom-right' },
    ],
  },
  {
    id: '3-top-hero',
    label: '3-Up Hero Top',
    minLayers: 3,
    slots: (w, h, p, g) => [
      { rect: getPinZoneRect('top-half', w, h, p, g), pinZone: 'top-half' },
      { rect: getPinZoneRect('bottom-left', w, h, p, g), pinZone: 'bottom-left' },
      { rect: getPinZoneRect('bottom-right', w, h, p, g), pinZone: 'bottom-right' },
    ],
  },
  {
    id: '3-columns',
    label: '3-Up Columns',
    minLayers: 3,
    slots: (w, h, p, g) => {
      const innerW = Math.max(100, w - p * 2);
      const innerH = Math.max(100, h - p * 2);
      const colW = (innerW - g * 2) / 3;
      return [0, 1, 2].map((i) => ({
        rect: {
          x: Math.round(p + i * (colW + g)),
          y: p,
          width: Math.round(colW),
          height: innerH,
        },
        pinZone: null,
      }));
    },
  },
  {
    id: '4-grid',
    label: '2×2 Quad Grid',
    minLayers: 4,
    slots: (w, h, p, g) => [
      { rect: getPinZoneRect('top-left', w, h, p, g), pinZone: 'top-left' },
      { rect: getPinZoneRect('top-right', w, h, p, g), pinZone: 'top-right' },
      { rect: getPinZoneRect('bottom-left', w, h, p, g), pinZone: 'bottom-left' },
      { rect: getPinZoneRect('bottom-right', w, h, p, g), pinZone: 'bottom-right' },
    ],
  },
];

/**
 * Applies a collage template to the slide's layers, preserving each layer's crop center.
 */
export function applyTemplateToLayers(
  templateId: CollageTemplateId,
  layers: SlideLayer[],
  assetsById: Map<string, MediaAsset>,
  slideWidth: number,
  slideHeight: number,
  padding: number,
  gap: number
): SlideLayer[] {
  const tmpl = COLLAGE_TEMPLATES.find((t) => t.id === templateId);
  if (!tmpl || layers.length === 0) return layers;

  const slots = tmpl.slots(slideWidth, slideHeight, padding, gap);
  return layers.map((layer, index) => {
    const slot = slots[index % slots.length];
    const asset = assetsById.get(layer.assetId);
    const mediaAspect = asset?.aspectRatio || 1;
    const frameAspect = slot.rect.width / Math.max(1, slot.rect.height);

    return {
      ...layer,
      x: slot.rect.x,
      y: slot.rect.y,
      width: slot.rect.width,
      height: slot.rect.height,
      pinZone: slot.pinZone,
      cropPreset: 'freeform',
      lockAspectRatio: layer.lockAspectRatio ?? true,
      crop: adjustCropPreservingCenter(layer.crop, mediaAspect, frameAspect),
      zIndex: index + 1,
    };
  });
}
