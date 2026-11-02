export type CarouselAspectRatio = '1:1' | '4:5' | '1.91:1';

export interface AspectRatioSpec {
  id: CarouselAspectRatio;
  label: string;
  shortLabel: string;
  width: number;
  height: number;
  ratio: number;
  description: string;
}

export const CAROUSEL_ASPECT_RATIOS: Record<CarouselAspectRatio, AspectRatioSpec> = {
  '4:5': {
    id: '4:5',
    label: 'Portrait (4:5)',
    shortLabel: '4:5',
    width: 1440,
    height: 1800,
    ratio: 1440 / 1800,
    description: '1440 × 1800 px — Highest quality vertical feed space',
  },
  '1:1': {
    id: '1:1',
    label: 'Square (1:1)',
    shortLabel: '1:1',
    width: 1440,
    height: 1440,
    ratio: 1,
    description: '1440 × 1440 px — Highest quality Instagram square',
  },
  '1.91:1': {
    id: '1.91:1',
    label: 'Landscape (1.91:1)',
    shortLabel: '1.91:1',
    width: 1440,
    height: 754,
    ratio: 1440 / 754,
    description: '1440 × 754 px — Highest quality wide cinematic format',
  },
};

export type CropPreset =
  | 'match-slide'
  | 'original'
  | '1:1'
  | '4:5'
  | '1.91:1'
  | '16:9'
  | '9:16'
  | '3:2'
  | '2:3'
  | '4:3'
  | '3:4'
  | 'freeform';

export interface CropPresetOption {
  id: CropPreset;
  label: string;
  ratio: number | null; // null for match-slide, original, or freeform
}

export const CROP_PRESET_OPTIONS: CropPresetOption[] = [
  { id: 'match-slide', label: 'Match Slide', ratio: null },
  { id: 'original', label: 'Original Ratio', ratio: null },
  { id: 'freeform', label: 'Freeform', ratio: null },
  { id: '1:1', label: '1:1 Square', ratio: 1 },
  { id: '4:5', label: '4:5 Portrait', ratio: 4 / 5 },
  { id: '1.91:1', label: '1.91:1 Landscape', ratio: 1.91 },
  { id: '16:9', label: '16:9 Wide', ratio: 16 / 9 },
  { id: '9:16', label: '9:16 Vertical', ratio: 9 / 16 },
  { id: '3:2', label: '3:2 Photo', ratio: 3 / 2 },
  { id: '2:3', label: '2:3 Portrait', ratio: 2 / 3 },
  { id: '4:3', label: '4:3 Classic', ratio: 4 / 3 },
  { id: '3:4', label: '3:4 Vertical', ratio: 3 / 4 },
];

export type PinZone =
  | 'full'
  | 'left-half'
  | 'right-half'
  | 'top-half'
  | 'bottom-half'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right'
  | 'center'
  | null;

export interface NormalizedCrop {
  /** Normalized 0..1 left offset in source media */
  x: number;
  /** Normalized 0..1 top offset in source media */
  y: number;
  /** Normalized 0..1 width in source media */
  width: number;
  /** Normalized 0..1 height in source media */
  height: number;
}

export interface MediaAsset {
  id: string;
  name: string;
  type: 'photo' | 'video';
  url: string;
  thumbnailUrl: string;
  naturalWidth: number;
  naturalHeight: number;
  aspectRatio: number;
  duration: number;
  dominantColors: string[];
  smartFocalPoint: { x: number; y: number };
  /** Integral image (summed-area table) over a 64x64 saliency grid */
  saliencyIntegral?: Float32Array;
  saliencyGridSize?: number;
  element?: HTMLImageElement | HTMLVideoElement;
  /** Server-side cached video ID for offline frame-accurate ffmpeg export */
  serverVideoId?: string;
}

export interface SlideLayer {
  id: string;
  assetId: string;
  zIndex: number;
  /** Frame X in slide space (0..1080, can exceed 1080 when bridging across adjacent slides) */
  x: number;
  /** Frame Y in slide space (0..slideHeight) */
  y: number;
  /** Frame width in slide space */
  width: number;
  /** Frame height in slide space */
  height: number;
  cropPreset: CropPreset;
  /** Whether resizing the layer frame locks its aspect ratio (default true) */
  lockAspectRatio: boolean;
  /** Source media crop region (normalized 0..1) */
  crop: NormalizedCrop;
  pinZone: PinZone;
  borderRadius: number;
  shadow: boolean;
  /** Drop shadow blur radius in slide-space px (default 24) */
  shadowBlur?: number;
  /** Drop shadow horizontal offset in slide-space px (default 0) */
  shadowOffsetX?: number;
  /** Drop shadow vertical offset in slide-space px (default 12) */
  shadowOffsetY?: number;
  /** Drop shadow opacity 0..1 (default 0.45) */
  shadowOpacity?: number;
  /** Drop shadow hex color (default '#000000') */
  shadowColor?: string;
  /** Optional group ID linking slices from a multi-slide split */
  spanGroupId?: string;
  /** Video trim start in seconds */
  trimStart: number;
  /** Video trim end in seconds */
  trimEnd: number;
  /** Video audio mute toggle */
  muted: boolean;
  /** Behavior when shorter than longest video on slide */
  endBehavior: 'loop' | 'freeze';
}

export interface SlideBackground {
  type: 'solid' | 'blur';
  color: string;
  blurAssetId?: string;
  blurIntensity: number;
}

export interface Slide {
  id: string;
  layers: SlideLayer[];
  background: SlideBackground;
  /** Outer margin in px (at 1080w scale) */
  padding: number;
  /** Inner gap between pinned/grid items in px (at 1080w scale) */
  gap: number;
}

export interface SnapGuide {
  orientation: 'vertical' | 'horizontal';
  /** Coordinate in slide space (x for vertical, y for horizontal) */
  position: number;
  start: number;
  end: number;
  label?: string;
  type: 'center' | 'edge' | 'margin' | 'thirds' | 'layer' | 'seam';
}

export interface ExportSettings {
  optimizeForInstagram: boolean;
  jpegQuality: number; // 0.70..1.0
  maxFileSizeMB: number; // default 1.5 MB for Instagram
  applySharpening: boolean;
  sharpenAmount: number; // 0..0.5
  imageFormat: 'jpeg' | 'png';
}

export interface ExportSlideProgress {
  slideIndex: number;
  slideId: string;
  type: 'photo' | 'video';
  status: 'pending' | 'rendering' | 'encoding' | 'done' | 'error';
  progress: number; // 0..1
  blob?: Blob;
  filename?: string;
  width?: number;
  height?: number;
  sizeBytes?: number;
  qualityUsed?: number;
  error?: string;
}
