import React, {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
} from 'react';
import {
  CAROUSEL_ASPECT_RATIOS,
  CROP_PRESET_OPTIONS,
  CarouselAspectRatio,
  CropPreset,
  ExportSettings,
  ExportSlideProgress,
  MediaAsset,
  NormalizedCrop,
  PinZone,
  Slide,
  SlideLayer,
  SnapGuide,
} from './types';
import {
  adjustCropPreservingCenter,
  analyzeMediaElement,
  computeCenterCrop,
  computeSmartCrop,
} from './smartcrop';
import {
  COLLAGE_TEMPLATES,
  CollageTemplateId,
  applyTemplateToLayers,
  computeSnapMove,
  getPinZoneRect,
} from './snapping';
import {
  computePanoramaSpanCrop,
  createSplitPanoramaSlides,
  recommendSlideSplitCount,
} from './splitter';
import { getVisibleLayersForSlide, renderSlideToCanvas } from './renderer';
import {
  bundleExportsIntoZip,
  exportStaticSlide,
  exportVideoSlide,
  slideContainsVideo,
  triggerBlobDownload,
} from './exporter';

interface HistorySnapshot {
  aspectRatio: CarouselAspectRatio;
  slides: Slide[];
  activeSlideIndex: number;
}

type HandleDirection =
  | 'nw'
  | 'n'
  | 'ne'
  | 'e'
  | 'se'
  | 's'
  | 'sw'
  | 'w';

interface DragInteraction {
  mode: 'move' | 'resize' | 'crop-pan';
  slideIndex: number;
  layerId: string;
  handle?: HandleDirection;
  startClientX: number;
  startClientY: number;
  initialLayer: SlideLayer;
  wasAlreadySelected?: boolean;
  hasMoved?: boolean;
}

const EDITORIAL_SWATCHES = [
  '#0c0c0e',
  '#18181b',
  '#f8fafc',
  '#f5f0e6',
  '#e7e5e4',
  '#292524',
  '#1e293b',
];

/**
 * Fits a media aspect ratio (width / height) inside an available target rectangle
 * while preserving the media's exact original proportions (contain fit, centered).
 */
function computeFittedOriginalRect(
  mediaAspect: number,
  box: { x: number; y: number; width: number; height: number }
): { x: number; y: number; width: number; height: number } {
  const safeAspect = Math.max(0.05, mediaAspect || 1);
  const boxW = Math.max(80, box.width);
  const boxH = Math.max(80, box.height);
  const boxAspect = boxW / boxH;

  let width: number;
  let height: number;
  if (safeAspect >= boxAspect) {
    width = boxW;
    height = Math.round(boxW / safeAspect);
  } else {
    height = boxH;
    width = Math.round(boxH * safeAspect);
  }

  const x = Math.round(box.x + (boxW - width) / 2);
  const y = Math.round(box.y + (boxH - height) / 2);
  return {
    x,
    y,
    width: Math.max(40, width),
    height: Math.max(40, height),
  };
}

export function App() {
  // Media Assets Library
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const assetsById = useMemo(() => {
    const map = new Map<string, MediaAsset>();
    for (const a of assets) map.set(a.id, a);
    return map;
  }, [assets]);

  // Carousel State (starts with a single empty slide and no sample assets)
  const [aspectRatio, setAspectRatio] = useState<CarouselAspectRatio>('4:5');
  const [slides, setSlides] = useState<Slide[]>([
    {
      id: 'slide_initial_1',
      layers: [],
      background: { type: 'solid', color: '#18181b', blurIntensity: 36 },
      padding: 0,
      gap: 0,
    },
  ]);
  const [activeSlideIndex, setActiveSlideIndex] = useState<number>(0);
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);
  const [cropModeLayerId, setCropModeLayerId] = useState<string | null>(null);
  const [rightSidebarTab, setRightSidebarTab] = useState<'layer' | 'slide'>(
    'layer'
  );
  const [stageZoom, setStageZoom] = useState<number>(1);
  const lastClickedLayerIdRef = useRef<string | null>(null);

  // Undo / Redo History Stack
  const [past, setPast] = useState<HistorySnapshot[]>([]);
  const [future, setFuture] = useState<HistorySnapshot[]>([]);

  // Workspace View & Guide Overlays (P-1, P-2, P-5)
  const [viewMode, setViewMode] = useState<'single' | 'strip'>('single');
  const [enableSnapping, setEnableSnapping] = useState<boolean>(true);
  const [showProfileGridGuide, setShowProfileGridGuide] = useState<boolean>(false);
  const [showInstagramChromeGuide, setShowInstagramChromeGuide] =
    useState<boolean>(false);
  const [showSmartFocalPoints, setShowSmartFocalPoints] = useState<boolean>(false);
  const [activeSnapGuides, setActiveSnapGuides] = useState<SnapGuide[]>([]);

  // Modals
  const [splitModalAsset, setSplitModalAsset] = useState<MediaAsset | null>(null);
  const [splitSlideCount, setSplitSlideCount] = useState<number>(2);
  const [splitUnifiedCrop, setSplitUnifiedCrop] = useState<NormalizedCrop>({
    x: 0,
    y: 0,
    width: 1,
    height: 1,
  });

  const [showSwipeSimulator, setShowSwipeSimulator] = useState<boolean>(false);
  const [simSlideIndex, setSimSlideIndex] = useState<number>(0);

  const [showExportModal, setShowExportModal] = useState<boolean>(false);
  const [exportSettings, setExportSettings] = useState<ExportSettings>({
    optimizeForInstagram: true,
    jpegQuality: 0.96,
    maxFileSizeMB: 8.0,
    applySharpening: true,
    sharpenAmount: 0.18,
    imageFormat: 'jpeg',
  });
  const [exportProgressList, setExportProgressList] = useState<
    ExportSlideProgress[]
  >([]);
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [isDraggingFileOver, setIsDraggingFileOver] = useState<boolean>(false);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [importErrors, setImportErrors] = useState<string[]>([]);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const hiddenVideoPoolRef = useRef<HTMLDivElement | null>(null);
  const stageCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageViewportRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragInteraction | null>(null);
  const splitPreviewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const splitDragRef = useRef<{
    startX: number;
    startY: number;
    initialCrop: NormalizedCrop;
  } | null>(null);

  const currentSpec = CAROUSEL_ASPECT_RATIOS[aspectRatio];
  const slideWidth = currentSpec.width; // 1440
  const slideHeight = currentSpec.height; // 1800, 1440, or 754

  const pushHistory = useCallback(() => {
    setPast((prev) => [
      ...prev.slice(-29),
      {
        aspectRatio,
        slides: JSON.parse(JSON.stringify(slides)),
        activeSlideIndex,
      },
    ]);
    setFuture([]);
  }, [aspectRatio, slides, activeSlideIndex]);

  const handleUndo = useCallback(() => {
    if (past.length === 0) return;
    const previous = past[past.length - 1];
    setFuture((f) => [
      {
        aspectRatio,
        slides: JSON.parse(JSON.stringify(slides)),
        activeSlideIndex,
      },
      ...f,
    ]);
    setPast((p) => p.slice(0, -1));
    setAspectRatio(previous.aspectRatio);
    setSlides(previous.slides);
    setActiveSlideIndex(
      Math.min(previous.activeSlideIndex, Math.max(0, previous.slides.length - 1))
    );
  }, [past, aspectRatio, slides, activeSlideIndex]);

  const handleRedo = useCallback(() => {
    if (future.length === 0) return;
    const next = future[0];
    setPast((p) => [
      ...p,
      {
        aspectRatio,
        slides: JSON.parse(JSON.stringify(slides)),
        activeSlideIndex,
      },
    ]);
    setFuture((f) => f.slice(1));
    setAspectRatio(next.aspectRatio);
    setSlides(next.slides);
    setActiveSlideIndex(
      Math.min(next.activeSlideIndex, Math.max(0, next.slides.length - 1))
    );
  }, [future, aspectRatio, slides, activeSlideIndex]);

  const handleDeleteSlide = useCallback(
    (idx: number) => {
      if (slides.length <= 1) {
        if (slides[0] && slides[0].layers.length > 0) {
          pushHistory();
          setSlides((prev) =>
            prev.map((s, i) => (i === 0 ? { ...s, layers: [] } : s))
          );
          setSelectedLayerId(null);
          setCropModeLayerId(null);
        }
        return;
      }
      pushHistory();
      setSlides((prev) => {
        const next = prev.filter((_, i) => i !== idx);
        setActiveSlideIndex((curr) =>
          Math.max(0, Math.min(curr, next.length - 1))
        );
        return next;
      });
      setSelectedLayerId(null);
      setCropModeLayerId(null);
    },
    [slides, pushHistory]
  );

  // Keyboard shortcuts (Undo/Redo, Delete layer or active slide, Escape crop mode, +/- Zoom)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
      } else if (e.key === 'Escape') {
        if (cropModeLayerId) {
          setCropModeLayerId(null);
        } else if (selectedLayerId) {
          setSelectedLayerId(null);
        }
      } else if (
        (e.key === 'Delete' || e.key === 'Backspace') &&
        !cropModeLayerId
      ) {
        e.preventDefault();
        if (selectedLayerId) {
          pushHistory();
          setSlides((prev) =>
            prev.map((s) => ({
              ...s,
              layers: s.layers.filter((l) => l.id !== selectedLayerId),
            }))
          );
          setSelectedLayerId(null);
        } else {
          handleDeleteSlide(activeSlideIndex);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    handleUndo,
    handleRedo,
    handleDeleteSlide,
    activeSlideIndex,
    selectedLayerId,
    cropModeLayerId,
    pushHistory,
  ]);

  // Import Local Files (Photos & Videos, including .HEIC/.HEIF & .MOV) — FR-1
  const handleFilesSelected = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return;
      const imported: MediaAsset[] = [];
      const newErrors: string[] = [];

      const loadImgFromUrl = (srcUrl: string): Promise<HTMLImageElement> =>
        new Promise((resolve, reject) => {
          const el = new Image();
          el.onload = () => {
            if (el.naturalWidth > 0 && el.naturalHeight > 0) {
              resolve(el);
            } else {
              reject(new Error('Decoded image has 0×0 dimensions'));
            }
          };
          el.onerror = () =>
            reject(new Error('Browser failed to decode image data'));
          el.src = srcUrl;
        });

      const convertHeicBlobToJpeg = async (file: File): Promise<Blob> => {
        const errors: string[] = [];

        // 1. Try local server /api/convert-heic (uses macOS `sips`, `heif-convert`, or `ffmpeg`)
        try {
          const resp = await fetch('/api/convert-heic', {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: await file.arrayBuffer(),
          });
          if (resp.ok) {
            const blob = await resp.blob();
            if (blob.size > 0) return blob;
          } else {
            const errJson = await resp.json().catch(() => ({}));
            errors.push(
              errJson.details || errJson.error || `Server HTTP ${resp.status}`
            );
          }
        } catch (err) {
          errors.push(`Server /api/convert-heic error: ${String(err)}`);
        }

        // 2. Fallback to client-side `heic2any` library if loaded
        const heic2anyFn = (window as unknown as { heic2any?: any }).heic2any;
        if (typeof heic2anyFn === 'function') {
          try {
            const result = await heic2anyFn({
              blob: file,
              toType: 'image/jpeg',
              quality: 0.96,
            });
            const outBlob = Array.isArray(result) ? result[0] : result;
            if (outBlob instanceof Blob && outBlob.size > 0) {
              return outBlob;
            }
          } catch (err) {
            errors.push(
              `heic2any error: ${
                err instanceof Error
                  ? err.message
                  : JSON.stringify(err) || String(err)
              }`
            );
          }
        } else {
          errors.push('heic2any library not available in browser');
        }

        throw new Error(errors.join(' | '));
      };

      const loadVideoElement = (
        srcUrl: string
      ): Promise<HTMLVideoElement> =>
        new Promise((resolve, reject) => {
          const vid = document.createElement('video');
          vid.src = srcUrl;
          vid.muted = true;
          vid.loop = true;
          vid.playsInline = true;
          vid.preload = 'auto';
          vid.style.width = '1px';
          vid.style.height = '1px';
          vid.style.opacity = '0.01';
          vid.style.pointerEvents = 'none';

          // Keep <video> mounted in a live 1x1px DOM container so the browser
          // hardware decoder/compositor never suspends or black-frames it.
          const pool = hiddenVideoPoolRef.current || document.body;
          pool.appendChild(vid);

          const cleanup = () => {
            vid.onloadeddata = null;
            vid.onerror = null;
          };

          vid.onloadeddata = () => {
            cleanup();
            if (vid.videoWidth > 0 && vid.videoHeight > 0) {
              resolve(vid);
            } else {
              vid.remove();
              reject(
                new Error(
                  'Video stream codec unsupported by browser (videoWidth is 0)'
                )
              );
            }
          };
          vid.onerror = () => {
            cleanup();
            vid.remove();
            const mediaErr = vid.error
              ? `code ${vid.error.code}${
                  vid.error.message ? `: ${vid.error.message}` : ''
                }`
              : 'unknown media error';
            reject(new Error(`Browser video decode failed (${mediaErr})`));
          };
          vid.load();
        });

      for (const file of Array.from(fileList)) {
        const lowerName = file.name.toLowerCase();
        const ext = lowerName.includes('.')
          ? lowerName.slice(lowerName.lastIndexOf('.'))
          : '';

        const isHeic =
          ext === '.heic' ||
          ext === '.heif' ||
          file.type === 'image/heic' ||
          file.type === 'image/heif';

        const isImage =
          isHeic ||
          file.type.startsWith('image/') ||
          [
            '.jpg',
            '.jpeg',
            '.png',
            '.webp',
            '.gif',
            '.avif',
            '.bmp',
            '.svg',
          ].includes(ext);

        const isVideo =
          !isImage &&
          (file.type.startsWith('video/') ||
            [
              '.mp4',
              '.mov',
              '.m4v',
              '.webm',
              '.mkv',
              '.avi',
              '.ogv',
              '.3gp',
            ].includes(ext));

        if (!isImage && !isVideo) {
          const msg = `Unsupported file "${file.name}" (type: ${
            file.type || 'unknown'
          }). Supported formats: JPG, PNG, WebP, HEIC/HEIF, MP4, MOV, WebM.`;
          console.error('[Import Error]', msg);
          newErrors.push(msg);
          continue;
        }

        if (isImage) {
          let activeUrl = '';
          try {
            let img: HTMLImageElement;
            if (isHeic) {
              setImportStatus(`Converting ${file.name} (HEIC → JPEG)…`);
              const convertedBlob = await convertHeicBlobToJpeg(file);
              activeUrl = URL.createObjectURL(convertedBlob);
              img = await loadImgFromUrl(activeUrl);
            } else {
              setImportStatus(`Loading ${file.name}…`);
              activeUrl = URL.createObjectURL(file);
              try {
                img = await loadImgFromUrl(activeUrl);
              } catch {
                // Fallback: try server/heic conversion in case file is a misnamed HEIC/TIFF
                URL.revokeObjectURL(activeUrl);
                setImportStatus(`Converting ${file.name}…`);
                const convertedBlob = await convertHeicBlobToJpeg(file);
                activeUrl = URL.createObjectURL(convertedBlob);
                img = await loadImgFromUrl(activeUrl);
              }
            }

            const w = img.naturalWidth || 1440;
            const h = img.naturalHeight || 1440;
            const analysis = analyzeMediaElement(img, w, h);
            imported.push({
              id: `asset_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
              name: file.name,
              type: 'photo',
              url: activeUrl,
              thumbnailUrl: analysis.thumbnailUrl,
              naturalWidth: w,
              naturalHeight: h,
              aspectRatio: w / h,
              duration: 0,
              dominantColors: analysis.dominantColors,
              smartFocalPoint: analysis.smartFocalPoint,
              saliencyIntegral: analysis.saliencyIntegral,
              saliencyGridSize: analysis.saliencyGridSize,
              element: img,
            });
          } catch (err) {
            if (activeUrl) URL.revokeObjectURL(activeUrl);
            const reason = err instanceof Error ? err.message : String(err);
            const msg = `Failed to import photo "${file.name}": ${reason}`;
            console.error('[Import Error]', msg);
            newErrors.push(msg);
          }
        } else if (isVideo) {
          try {
            setImportStatus(
              `Preparing lightweight stage proxy for ${file.name}…`
            );
            const resp = await fetch(
              `/api/import-video?name=${encodeURIComponent(file.name)}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/octet-stream' },
                body: await file.arrayBuffer(),
              }
            );

            if (!resp.ok) {
              const errJson = await resp.json().catch(() => ({}));
              throw new Error(
                errJson.error
                  ? `${errJson.error}${
                      errJson.details ? ` (${errJson.details})` : ''
                    }`
                  : `Server /api/import-video returned HTTP ${resp.status}`
              );
            }

            const meta = (await resp.json()) as {
              serverVideoId: string;
              proxyUrl: string;
              width: number;
              height: number;
              proxyWidth: number;
              proxyHeight: number;
              duration: number;
              hasAudio: boolean;
            };

            const vid = await loadVideoElement(meta.proxyUrl);

            // Seek slightly in and wait for a decoded frame (readyState >= 2)
            // so the thumbnail & saliency analysis never capture a black frame
            const dur =
              Number.isFinite(vid.duration) && vid.duration > 0
                ? vid.duration
                : meta.duration || 5;
            vid.currentTime = Math.min(0.5, dur * 0.15);
            await new Promise<void>((resolve) => {
              let settled = false;
              const finish = () => {
                if (!settled) {
                  settled = true;
                  resolve();
                }
              };
              const onSeeked = () => {
                if (vid.readyState >= 2) finish();
                else
                  vid.addEventListener('loadeddata', finish, { once: true });
              };
              vid.addEventListener('seeked', onSeeked, { once: true });
              setTimeout(finish, 600);
            });

            const proxyW = vid.videoWidth || meta.proxyWidth || 960;
            const proxyH = vid.videoHeight || meta.proxyHeight || 1200;
            const analysis = analyzeMediaElement(vid, proxyW, proxyH);

            const sourceW = meta.width || proxyW;
            const sourceH = meta.height || proxyH;

            vid.currentTime = 0;
            vid.play().catch(() => {});

            imported.push({
              id: `asset_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
              name: file.name,
              type: 'video',
              url: meta.proxyUrl,
              serverVideoId: meta.serverVideoId,
              thumbnailUrl: analysis.thumbnailUrl,
              naturalWidth: sourceW,
              naturalHeight: sourceH,
              aspectRatio: sourceW / sourceH,
              duration: dur,
              dominantColors: analysis.dominantColors,
              smartFocalPoint: analysis.smartFocalPoint,
              saliencyIntegral: analysis.saliencyIntegral,
              saliencyGridSize: analysis.saliencyGridSize,
              element: vid,
            });
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            const msg = `Failed to import video "${file.name}": ${reason}`;
            console.error('[Import Error]', msg);
            newErrors.push(msg);
          }
        }
      }

      setImportStatus(null);
      if (newErrors.length > 0) {
        setImportErrors((prev) => [...newErrors, ...prev]);
      }
      if (imported.length > 0) {
        setAssets((prev) => [...imported, ...prev]);
      }
    },
    []
  );

  // Delete an Imported Photo or Video from Media Library (and remove its layers)
  const handleDeleteAsset = useCallback(
    (assetId: string) => {
      const target = assetsById.get(assetId);
      if (!target) return;

      const isUsedInSlides = slides.some(
        (s) =>
          s.layers.some((l) => l.assetId === assetId) ||
          s.background.blurAssetId === assetId
      );
      if (isUsedInSlides) {
        pushHistory();
        setSlides((prev) =>
          prev.map((s) => ({
            ...s,
            background:
              s.background.blurAssetId === assetId
                ? { ...s.background, blurAssetId: undefined }
                : s.background,
            layers: s.layers.filter((l) => l.assetId !== assetId),
          }))
        );
      }

      setSelectedLayerId((curr) => {
        if (!curr) return null;
        const stillExists = slides.some((s) =>
          s.layers.some((l) => l.id === curr && l.assetId !== assetId)
        );
        return stillExists ? curr : null;
      });
      setCropModeLayerId((curr) => {
        if (!curr) return null;
        const stillExists = slides.some((s) =>
          s.layers.some((l) => l.id === curr && l.assetId !== assetId)
        );
        return stillExists ? curr : null;
      });
      if (splitModalAsset?.id === assetId) {
        setSplitModalAsset(null);
      }

      if (target.element instanceof HTMLVideoElement) {
        target.element.pause();
        target.element.removeAttribute('src');
        target.element.load();
        target.element.remove();
      }
      if (target.url.startsWith('blob:')) {
        URL.revokeObjectURL(target.url);
      }

      setAssets((prev) => prev.filter((a) => a.id !== assetId));
    },
    [assetsById, slides, splitModalAsset, pushHistory]
  );

  // Switch Global Carousel Aspect Ratio (FR-3)
  // CRITICAL: Preserves existing crops without recalculating smart auto-crop!
  const handleCarouselAspectRatioChange = useCallback(
    (newRatio: CarouselAspectRatio) => {
      if (newRatio === aspectRatio) return;
      pushHistory();
      const oldSpec = CAROUSEL_ASPECT_RATIOS[aspectRatio];
      const newSpec = CAROUSEL_ASPECT_RATIOS[newRatio];
      const scaleY = newSpec.height / oldSpec.height;

      setSlides((prevSlides) =>
        prevSlides.map((slide) => ({
          ...slide,
          layers: slide.layers.map((layer) => {
            const asset = assetsById.get(layer.assetId);
            const mediaAspect = asset?.aspectRatio || 1;

            if (layer.pinZone) {
              const rect = getPinZoneRect(
                layer.pinZone,
                newSpec.width,
                newSpec.height,
                slide.padding,
                slide.gap
              );
              const newFrameAspect = rect.width / Math.max(1, rect.height);
              return {
                ...layer,
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
                // Preserve existing crop center & zoom without smart auto-crop recalculation
                crop: adjustCropPreservingCenter(
                  layer.crop,
                  mediaAspect,
                  newFrameAspect
                ),
              };
            }

            if (layer.cropPreset === 'original') {
              const innerBox = getPinZoneRect(
                'full',
                newSpec.width,
                newSpec.height,
                slide.padding,
                slide.gap
              );
              if (
                slide.layers.length === 1 ||
                layer.width > innerBox.width ||
                layer.height > innerBox.height
              ) {
                const fitted = computeFittedOriginalRect(mediaAspect, innerBox);
                return {
                  ...layer,
                  x: fitted.x,
                  y: fitted.y,
                  width: fitted.width,
                  height: fitted.height,
                };
              }
            }

            if (layer.cropPreset === 'match-slide') {
              const newY = Math.round(layer.y * scaleY);
              const newH = Math.round(layer.height * scaleY);
              const newFrameAspect = layer.width / Math.max(1, newH);
              return {
                ...layer,
                y: newY,
                height: newH,
                crop: adjustCropPreservingCenter(
                  layer.crop,
                  mediaAspect,
                  newFrameAspect
                ),
              };
            }

            // Fixed-ratio or freeform layers keep their exact dimensions and exact crop
            const newCenterY = (layer.y + layer.height / 2) * scaleY;
            const newY = Math.round(newCenterY - layer.height / 2);
            return {
              ...layer,
              y: newY,
            };
          }),
        }))
      );
      setAspectRatio(newRatio);
    },
    [aspectRatio, assetsById, pushHistory]
  );

  // Add Media Asset to Current Slide (FR-6)
  // Uses original proportions of the image/video and fits it into the slide template.
  const handleAddAssetToCurrentSlide = useCallback(
    (asset: MediaAsset) => {
      pushHistory();
      setSlides((prev) => {
        if (prev.length === 0) return prev;
        const idx = Math.min(activeSlideIndex, prev.length - 1);
        const slide = prev[idx];
        const maxZ = slide.layers.reduce((m, l) => Math.max(m, l.zIndex), 0);

        const fullBox = getPinZoneRect(
          'full',
          slideWidth,
          slideHeight,
          slide.padding,
          slide.gap
        );
        let targetBox = fullBox;

        if (slide.layers.length > 0) {
          // Fit additional photo with its original proportions into a slightly smaller offset box
          const boxW = Math.round(fullBox.width * 0.72);
          const boxH = Math.round(fullBox.height * 0.72);
          const offset = (slide.layers.length % 4) * 28;
          targetBox = {
            x: Math.min(
              slideWidth - boxW - 16,
              Math.round(fullBox.x + (fullBox.width - boxW) / 2 + offset)
            ),
            y: Math.min(
              slideHeight - boxH - 16,
              Math.round(fullBox.y + (fullBox.height - boxH) / 2 + offset)
            ),
            width: boxW,
            height: boxH,
          };
        }

        const rect = computeFittedOriginalRect(asset.aspectRatio, targetBox);
        const fullOriginalCrop: NormalizedCrop = {
          x: 0,
          y: 0,
          width: 1,
          height: 1,
        };

        const newLayer: SlideLayer = {
          id: `layer_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          assetId: asset.id,
          zIndex: maxZ + 1,
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          cropPreset: 'original',
          lockAspectRatio: true,
          crop: fullOriginalCrop,
          pinZone: null,
          borderRadius: slide.padding > 0 ? 12 : 0,
          shadow: false,
          shadowBlur: 24,
          shadowOffsetX: 0,
          shadowOffsetY: 12,
          shadowOpacity: 0.45,
          shadowColor: '#000000',
          trimStart: 0,
          trimEnd: asset.duration || 0,
          muted: false,
          endBehavior: 'loop',
        };

        const updated = [...prev];
        updated[idx] = {
          ...slide,
          layers: [...slide.layers, newLayer],
        };
        setSelectedLayerId(newLayer.id);
        setRightSidebarTab('layer');
        return updated;
      });
    },
    [activeSlideIndex, slideWidth, slideHeight, pushHistory]
  );

  // Add Media Asset as a Brand New Slide (FR-2)
  // Uses original proportions of the image/video and fits it into the slide template.
  const handleAddAssetAsNewSlide = useCallback(
    (asset: MediaAsset) => {
      pushHistory();
      const rect = computeFittedOriginalRect(asset.aspectRatio, {
        x: 0,
        y: 0,
        width: slideWidth,
        height: slideHeight,
      });
      const newLayer: SlideLayer = {
        id: `layer_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        assetId: asset.id,
        zIndex: 1,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        cropPreset: 'original',
        lockAspectRatio: true,
        crop: { x: 0, y: 0, width: 1, height: 1 },
        pinZone: null,
        borderRadius: 0,
        shadow: false,
        shadowBlur: 24,
        shadowOffsetX: 0,
        shadowOffsetY: 12,
        shadowOpacity: 0.45,
        shadowColor: '#000000',
        trimStart: 0,
        trimEnd: asset.duration || 0,
        muted: false,
        endBehavior: 'loop',
      };
      const newSlide: Slide = {
        id: `slide_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        layers: [newLayer],
        background: {
          type: 'solid',
          color: asset.dominantColors[0] || '#0c0c0e',
          blurIntensity: 36,
        },
        padding: 0,
        gap: 0,
      };
      setSlides((prev) => {
        const next = [...prev, newSlide];
        setActiveSlideIndex(next.length - 1);
        return next;
      });
      setSelectedLayerId(newLayer.id);
      setRightSidebarTab('layer');
    },
    [slideWidth, slideHeight, pushHistory]
  );

  // Open Panorama Split Modal (FR-7)
  const handleOpenSplitModal = useCallback(
    (asset: MediaAsset) => {
      const recCount = recommendSlideSplitCount(
        asset.aspectRatio,
        slideWidth / slideHeight
      );
      const initialCrop = computePanoramaSpanCrop(
        asset,
        recCount,
        slideWidth / slideHeight
      );
      setSplitModalAsset(asset);
      setSplitSlideCount(recCount);
      setSplitUnifiedCrop(initialCrop);
    },
    [slideWidth, slideHeight]
  );

  const handleConfirmSplitSlides = useCallback(() => {
    if (!splitModalAsset) return;
    pushHistory();
    const generated = createSplitPanoramaSlides(
      splitModalAsset,
      splitUnifiedCrop,
      splitSlideCount,
      slideWidth,
      slideHeight,
      splitModalAsset.dominantColors[0] || '#0c0c0e'
    );
    setSlides((prev) => {
      if (prev.length === 1 && prev[0].layers.length === 0) {
        setActiveSlideIndex(0);
        if (generated[0]?.layers[0]) {
          setSelectedLayerId(generated[0].layers[0].id);
        }
        return generated;
      }
      const insertAt = Math.min(activeSlideIndex + 1, prev.length);
      const next = [
        ...prev.slice(0, insertAt),
        ...generated,
        ...prev.slice(insertAt),
      ];
      setActiveSlideIndex(insertAt);
      if (generated[0]?.layers[0]) {
        setSelectedLayerId(generated[0].layers[0].id);
      }
      return next;
    });
    setSplitModalAsset(null);
  }, [
    splitModalAsset,
    splitUnifiedCrop,
    splitSlideCount,
    slideWidth,
    slideHeight,
    activeSlideIndex,
    pushHistory,
  ]);

  // Slide Management (Add Blank, Duplicate, Reorder, Delete) — FR-2
  const handleAddBlankSlide = useCallback(() => {
    pushHistory();
    const newSlide: Slide = {
      id: `slide_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      layers: [],
      background: { type: 'solid', color: '#18181b', blurIntensity: 36 },
      padding: 0,
      gap: 0,
    };
    setSlides((prev) => {
      const next = [...prev, newSlide];
      setActiveSlideIndex(next.length - 1);
      return next;
    });
    setSelectedLayerId(null);
  }, [pushHistory]);

  const handleDuplicateSlide = useCallback(
    (idx: number) => {
      pushHistory();
      setSlides((prev) => {
        const src = prev[idx];
        if (!src) return prev;
        const copy: Slide = {
          ...JSON.parse(JSON.stringify(src)),
          id: `slide_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          layers: src.layers.map((l) => ({
            ...JSON.parse(JSON.stringify(l)),
            id: `layer_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          })),
        };
        const next = [
          ...prev.slice(0, idx + 1),
          copy,
          ...prev.slice(idx + 1),
        ];
        setActiveSlideIndex(idx + 1);
        return next;
      });
    },
    [pushHistory]
  );

  const handleMoveSlide = useCallback(
    (idx: number, dir: -1 | 1) => {
      const target = idx + dir;
      if (target < 0 || target >= slides.length) return;
      pushHistory();
      setSlides((prev) => {
        const next = [...prev];
        const [item] = next.splice(idx, 1);
        next.splice(target, 0, item);
        return next;
      });
      setActiveSlideIndex(target);
    },
    [slides.length, pushHistory]
  );

  // Locate active slide and selected layer (searching across all slides in case selected in Strip View)
  const activeSlide = slides[activeSlideIndex] || slides[0];
  const selectedLayerContext = useMemo(() => {
    if (!selectedLayerId) return null;
    for (let i = 0; i < slides.length; i++) {
      const layer = slides[i].layers.find((l) => l.id === selectedLayerId);
      if (layer) {
        return {
          slideIndex: i,
          slide: slides[i],
          layer,
          asset: assetsById.get(layer.assetId),
        };
      }
    }
    return null;
  }, [slides, selectedLayerId, assetsById]);

  const updateLayerById = useCallback(
    (layerId: string, updater: (layer: SlideLayer, slide: Slide) => SlideLayer) => {
      setSlides((prev) =>
        prev.map((slide) => {
          const hasLayer = slide.layers.some((l) => l.id === layerId);
          if (!hasLayer) return slide;
          return {
            ...slide,
            layers: slide.layers.map((l) =>
              l.id === layerId ? updater(l, slide) : l
            ),
          };
        })
      );
    },
    []
  );

  // Stage Scale Calculation (with user zoom multiplier)
  const baseStageScale = useMemo(() => {
    if (viewMode === 'strip') {
      return aspectRatio === '1.91:1' ? 0.34 : 0.28;
    }
    if (aspectRatio === '4:5') return 0.42;
    if (aspectRatio === '1:1') return 0.48;
    return 0.56;
  }, [viewMode, aspectRatio]);

  const stageScale = useMemo(
    () => Math.max(0.1, Math.min(2.5, baseStageScale * stageZoom)),
    [baseStageScale, stageZoom]
  );

  const handleChangeStageZoom = useCallback((nextZoom: number) => {
    const clamped = Math.max(
      0.25,
      Math.min(3, Math.round(nextZoom * 100) / 100)
    );
    setStageZoom(clamped);
  }, []);

  const handleStageWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const delta = -e.deltaY * 0.002;
        setStageZoom((prev) =>
          Math.max(0.25, Math.min(3, Math.round((prev + delta) * 100) / 100))
        );
      }
    },
    []
  );

  // Live Stage Rendering Loop (supports smooth 60fps proxy video playback on stage
  // while avoiding unnecessary CPU/GPU ticks when viewing static-only slides)
  useEffect(() => {
    let animId = 0;

    // Determine which video assets are visible on the current stage view
    const visibleSlideIndices =
      viewMode === 'strip'
        ? slides.map((_, idx) => idx)
        : [Math.min(activeSlideIndex, Math.max(0, slides.length - 1))];

    const visibleVideoLayers: { layer: SlideLayer; asset: MediaAsset }[] = [];
    const visibleVideoAssetIds = new Set<string>();

    for (const sIdx of visibleSlideIndices) {
      const s = slides[sIdx];
      if (!s) continue;
      if (s.background.type === 'blur') {
        const bgId = s.background.blurAssetId || s.layers[0]?.assetId;
        const bgAsset = bgId ? assetsById.get(bgId) : undefined;
        if (bgAsset?.type === 'video') {
          visibleVideoAssetIds.add(bgAsset.id);
        }
      }
      const visItems = getVisibleLayersForSlide(slides, sIdx, slideWidth);
      for (const item of visItems) {
        const asset = assetsById.get(item.layer.assetId);
        if (asset?.type === 'video') {
          visibleVideoAssetIds.add(asset.id);
          visibleVideoLayers.push({ layer: item.layer, asset });
        }
      }
    }

    // Pause off-screen video elements to free hardware decoder resources; play visible ones
    for (const asset of assetsById.values()) {
      if (asset.type === 'video' && asset.element instanceof HTMLVideoElement) {
        if (visibleVideoAssetIds.has(asset.id)) {
          if (asset.element.paused) {
            asset.element.play().catch(() => {});
          }
        } else if (!asset.element.paused) {
          asset.element.pause();
        }
      }
    }

    const hasVisibleVideo = visibleVideoAssetIds.size > 0;

    const renderFrame = () => {
      // Enforce [trimStart, trimEnd] bounds for visible video layers on stage
      for (const { layer, asset } of visibleVideoLayers) {
        if (asset.element instanceof HTMLVideoElement) {
          const vid = asset.element;
          const tStart = Math.max(0, layer.trimStart || 0);
          const tEnd =
            layer.trimEnd > tStart + 0.05
              ? layer.trimEnd
              : asset.duration || vid.duration || 5;
          if (vid.currentTime < tStart - 0.05) {
            vid.currentTime = tStart;
          } else if (vid.currentTime >= tEnd) {
            if (layer.endBehavior === 'freeze') {
              vid.pause();
            } else {
              vid.currentTime = tStart;
              if (vid.paused) vid.play().catch(() => {});
            }
          }
        }
      }

      const canvas = stageCanvasRef.current;
      if (canvas && slides.length > 0) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          if (viewMode === 'single') {
            const targetW = Math.round(slideWidth * stageScale);
            const targetH = Math.round(slideHeight * stageScale);
            if (canvas.width !== targetW || canvas.height !== targetH) {
              canvas.width = targetW;
              canvas.height = targetH;
            }
            ctx.clearRect(0, 0, targetW, targetH);
            renderSlideToCanvas(ctx, {
              slides,
              slideIndex: activeSlideIndex,
              slideWidth,
              slideHeight,
              assetsById,
              scale: stageScale,
              selectedLayerId,
              cropModeLayerId,
              snapGuides: activeSnapGuides,
              showInstagramChromeGuide,
              showProfileGridGuide,
              showSmartFocalPoints,
              isExport: false,
            });
          } else {
            // Continuous Strip View (P-1): All slides flush side-by-side
            const singleW = Math.round(slideWidth * stageScale);
            const totalW = singleW * slides.length;
            const targetH = Math.round(slideHeight * stageScale);
            if (canvas.width !== totalW || canvas.height !== targetH) {
              canvas.width = totalW;
              canvas.height = targetH;
            }
            ctx.clearRect(0, 0, totalW, targetH);
            for (let i = 0; i < slides.length; i++) {
              renderSlideToCanvas(ctx, {
                slides,
                slideIndex: i,
                slideWidth,
                slideHeight,
                assetsById,
                scale: stageScale,
                offsetX: i * singleW,
                offsetY: 0,
                selectedLayerId,
                cropModeLayerId,
                snapGuides: i === activeSlideIndex ? activeSnapGuides : [],
                showInstagramChromeGuide,
                showProfileGridGuide,
                showSmartFocalPoints,
                isExport: false,
              });

              // Draw subtle seam divider line & slide index badge
              if (i > 0) {
                ctx.save();
                ctx.beginPath();
                ctx.setLineDash([6, 4]);
                ctx.strokeStyle = 'rgba(245, 158, 11, 0.65)';
                ctx.lineWidth = 1.5;
                ctx.moveTo(i * singleW, 0);
                ctx.lineTo(i * singleW, targetH);
                ctx.stroke();
                ctx.restore();
              }

              // Active slide highlight bar at top
              ctx.save();
              ctx.fillStyle =
                i === activeSlideIndex ? '#f59e0b' : 'rgba(255,255,255,0.18)';
              ctx.fillRect(i * singleW, 0, singleW, 3);
              ctx.restore();
            }
          }
        }
      }

      if (hasVisibleVideo) {
        animId = requestAnimationFrame(renderFrame);
      }
    };

    renderFrame();
    return () => {
      if (animId) cancelAnimationFrame(animId);
    };
  }, [
    slides,
    activeSlideIndex,
    slideWidth,
    slideHeight,
    assetsById,
    stageScale,
    viewMode,
    selectedLayerId,
    cropModeLayerId,
    activeSnapGuides,
    showInstagramChromeGuide,
    showProfileGridGuide,
    showSmartFocalPoints,
  ]);

  // Interactive Stage Pointer Events (Select, Move with Snapping, 8-Handle Resize, Crop Pan)
  const handleStagePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = stageCanvasRef.current;
      if (!canvas || slides.length === 0) return;
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;

      // Determine clicked slide index and slide-space coordinates (0..1080, 0..slideHeight)
      const singleCanvasW = slideWidth * stageScale;
      const clickedSlideIdx =
        viewMode === 'strip'
          ? Math.max(0, Math.min(slides.length - 1, Math.floor(px / singleCanvasW)))
          : activeSlideIndex;

      if (clickedSlideIdx !== activeSlideIndex) {
        setActiveSlideIndex(clickedSlideIdx);
      }

      const slideX = (px - (viewMode === 'strip' ? clickedSlideIdx * singleCanvasW : 0)) / stageScale;
      const slideY = py / stageScale;

      // 1. Check if clicking one of the 8 resize handles of the currently selected layer
      if (selectedLayerContext && !cropModeLayerId) {
        const { layer, slideIndex: originIdx } = selectedLayerContext;
        const localX = layer.x + (originIdx - clickedSlideIdx) * slideWidth;
        const handleRadius = 14 / stageScale;
        const handleDefs: { dir: HandleDirection; hx: number; hy: number }[] = [
          { dir: 'nw', hx: localX, hy: layer.y },
          { dir: 'n', hx: localX + layer.width / 2, hy: layer.y },
          { dir: 'ne', hx: localX + layer.width, hy: layer.y },
          { dir: 'e', hx: localX + layer.width, hy: layer.y + layer.height / 2 },
          { dir: 'se', hx: localX + layer.width, hy: layer.y + layer.height },
          { dir: 's', hx: localX + layer.width / 2, hy: layer.y + layer.height },
          { dir: 'sw', hx: localX, hy: layer.y + layer.height },
          { dir: 'w', hx: localX, hy: layer.y + layer.height / 2 },
        ];

        for (const h of handleDefs) {
          if (Math.hypot(slideX - h.hx, slideY - h.hy) <= handleRadius) {
            dragRef.current = {
              mode: 'resize',
              slideIndex: originIdx,
              layerId: layer.id,
              handle: h.dir,
              startClientX: e.clientX,
              startClientY: e.clientY,
              initialLayer: JSON.parse(JSON.stringify(layer)),
              wasAlreadySelected: true,
              hasMoved: false,
            };
            e.currentTarget.setPointerCapture(e.pointerId);
            return;
          }
        }
      }

      // 2. Hit-test visible layers on clickedSlideIdx from top zIndex to bottom
      const visible = getVisibleLayersForSlide(slides, clickedSlideIdx, slideWidth);
      for (let i = visible.length - 1; i >= 0; i--) {
        const { layer, originSlideIndex, localX } = visible[i];
        if (
          slideX >= localX &&
          slideX <= localX + layer.width &&
          slideY >= layer.y &&
          slideY <= layer.y + layer.height
        ) {
          const wasAlreadySelected =
            selectedLayerId === layer.id && cropModeLayerId !== layer.id;
          lastClickedLayerIdRef.current = layer.id;

          if (!wasAlreadySelected) {
            setSelectedLayerId(layer.id);
            setRightSidebarTab('layer');
          }
          if (cropModeLayerId && cropModeLayerId !== layer.id) {
            setCropModeLayerId(null);
          }

          dragRef.current = {
            mode: cropModeLayerId === layer.id ? 'crop-pan' : 'move',
            slideIndex: originSlideIndex,
            layerId: layer.id,
            startClientX: e.clientX,
            startClientY: e.clientY,
            initialLayer: JSON.parse(JSON.stringify(layer)),
            wasAlreadySelected,
            hasMoved: false,
          };
          e.currentTarget.setPointerCapture(e.pointerId);
          return;
        }
      }

      // Clicked empty canvas area -> deselect
      lastClickedLayerIdRef.current = null;
      setSelectedLayerId(null);
      setCropModeLayerId(null);
    },
    [
      slides,
      slideWidth,
      stageScale,
      viewMode,
      activeSlideIndex,
      selectedLayerId,
      selectedLayerContext,
      cropModeLayerId,
    ]
  );

  const handleStagePointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const drag = dragRef.current;
      if (!drag) return;

      const distPx = Math.hypot(
        e.clientX - drag.startClientX,
        e.clientY - drag.startClientY
      );
      if (!drag.hasMoved) {
        if (distPx < 3) return;
        drag.hasMoved = true;
        pushHistory();
      }

      const dxSlide = (e.clientX - drag.startClientX) / stageScale;
      const dySlide = (e.clientY - drag.startClientY) / stageScale;
      const init = drag.initialLayer;
      const asset = assetsById.get(init.assetId);
      const mediaAspect = asset?.aspectRatio || 1;

      if (drag.mode === 'crop-pan') {
        // Pan the source media inside the crop window
        const normDx = -(dxSlide / Math.max(1, init.width)) * init.crop.width;
        const normDy = -(dySlide / Math.max(1, init.height)) * init.crop.height;
        const nx = Math.max(
          0,
          Math.min(1 - init.crop.width, init.crop.x + normDx)
        );
        const ny = Math.max(
          0,
          Math.min(1 - init.crop.height, init.crop.y + normDy)
        );
        updateLayerById(drag.layerId, (l) => ({
          ...l,
          crop: { ...l.crop, x: nx, y: ny },
        }));
        return;
      }

      if (drag.mode === 'move') {
        const proposed = {
          x: init.x + dxSlide,
          y: init.y + dySlide,
          width: init.width,
          height: init.height,
        };

        const originSlide = slides[drag.slideIndex];
        if (!originSlide) return;
        const siblings = originSlide.layers.filter((l) => l.id !== drag.layerId);

        if (enableSnapping && !e.altKey) {
          const snapRes = computeSnapMove(
            proposed,
            siblings,
            slideWidth,
            slideHeight,
            originSlide.padding,
            originSlide.gap,
            viewMode === 'strip'
          );
          setActiveSnapGuides(snapRes.guides);
          updateLayerById(drag.layerId, (l) => ({
            ...l,
            x: snapRes.rect.x,
            y: snapRes.rect.y,
            pinZone: null,
          }));
        } else {
          setActiveSnapGuides([]);
          updateLayerById(drag.layerId, (l) => ({
            ...l,
            x: Math.round(proposed.x),
            y: Math.round(proposed.y),
            pinZone: null,
          }));
        }
        return;
      }

      if (drag.mode === 'resize' && drag.handle) {
        const h = drag.handle;
        const right = init.x + init.width;
        const bottom = init.y + init.height;
        const centerX = init.x + init.width / 2;
        const centerY = init.y + init.height / 2;

        let nw = init.width;
        let nh = init.height;

        if (h.includes('e')) nw = Math.max(60, init.width + dxSlide);
        if (h.includes('w')) nw = Math.max(60, init.width - dxSlide);
        if (h.includes('s')) nh = Math.max(60, init.height + dySlide);
        if (h.includes('n')) nh = Math.max(60, init.height - dySlide);

        // Lock aspect ratio by default unless unlocked (or Shift is held to temporarily invert)
        const baseLock = init.lockAspectRatio !== false;
        const isLocked = e.shiftKey ? !baseLock : baseLock;

        let nx = init.x;
        let ny = init.y;

        if (isLocked) {
          const targetRatio = init.width / Math.max(1, init.height);
          if (h === 'n' || h === 's') {
            nw = Math.max(60, nh * targetRatio);
            nx = centerX - nw / 2;
            ny = h === 'n' ? bottom - nh : init.y;
          } else if (h === 'e' || h === 'w') {
            nh = Math.max(60, nw / targetRatio);
            ny = centerY - nh / 2;
            nx = h === 'w' ? right - nw : init.x;
          } else {
            // Corner handles: scale proportionally from opposite corner
            nh = Math.max(60, nw / targetRatio);
            nw = nh * targetRatio;
            nx = h.includes('w') ? right - nw : init.x;
            ny = h.includes('n') ? bottom - nh : init.y;
          }
        } else {
          nx = h.includes('w') ? right - nw : init.x;
          ny = h.includes('n') ? bottom - nh : init.y;
        }

        const newFrameAspect = nw / Math.max(1, nh);
        const adjustedCrop = isLocked
          ? init.crop
          : adjustCropPreservingCenter(init.crop, mediaAspect, newFrameAspect);

        updateLayerById(drag.layerId, (l) => ({
          ...l,
          x: Math.round(nx),
          y: Math.round(ny),
          width: Math.round(nw),
          height: Math.round(nh),
          pinZone: null,
          crop: adjustedCrop,
        }));
      }
    },
    [
      stageScale,
      assetsById,
      slides,
      enableSnapping,
      slideWidth,
      slideHeight,
      viewMode,
      updateLayerById,
      pushHistory,
    ]
  );

  const handleStagePointerUp = useCallback(() => {
    const drag = dragRef.current;
    if (drag && drag.mode === 'move' && drag.wasAlreadySelected && !drag.hasMoved) {
      // Clicking an already-selected image on the slide without dragging unselects it
      setSelectedLayerId(null);
      setCropModeLayerId(null);
    }
    dragRef.current = null;
    setActiveSnapGuides([]);
  }, []);

  const handleStageDoubleClick = useCallback(() => {
    const targetId = selectedLayerId || lastClickedLayerIdRef.current;
    if (targetId) {
      setSelectedLayerId(targetId);
      setRightSidebarTab('layer');
      setCropModeLayerId((prev) => (prev === targetId ? null : targetId));
    }
  }, [selectedLayerId]);

  // Toggle Lock / Unlock Aspect Ratio on Resize
  const handleToggleLockAspectRatio = useCallback(() => {
    if (!selectedLayerContext) return;
    pushHistory();
    const { layer } = selectedLayerContext;
    updateLayerById(layer.id, (l) => {
      const nextLock = l.lockAspectRatio === false ? true : false;
      return {
        ...l,
        lockAspectRatio: nextLock,
        cropPreset: !nextLock ? 'freeform' : l.cropPreset,
      };
    });
  }, [selectedLayerContext, updateLayerById, pushHistory]);

  // Fit Selected Layer with Original Proportions into Active Slide Template
  const handleFitLayerOriginalToSlide = useCallback(() => {
    if (!selectedLayerContext) return;
    pushHistory();
    const { layer, slide, asset } = selectedLayerContext;
    const mediaAspect = asset?.aspectRatio || 1;
    const innerBox = getPinZoneRect(
      'full',
      slideWidth,
      slideHeight,
      slide.padding,
      slide.gap
    );
    const fitted = computeFittedOriginalRect(mediaAspect, innerBox);
    updateLayerById(layer.id, (l) => ({
      ...l,
      x: fitted.x,
      y: fitted.y,
      width: fitted.width,
      height: fitted.height,
      cropPreset: 'original',
      lockAspectRatio: true,
      pinZone: null,
      crop: { x: 0, y: 0, width: 1, height: 1 },
    }));
  }, [selectedLayerContext, slideWidth, slideHeight, updateLayerById, pushHistory]);

  // Apply Crop Ratio Preset (FR-4)
  const handleSelectCropPreset = useCallback(
    (preset: CropPreset) => {
      if (!selectedLayerContext) return;
      pushHistory();
      const { layer, slide, asset } = selectedLayerContext;
      const mediaAspect = asset?.aspectRatio || 1;

      if (preset === 'freeform') {
        updateLayerById(layer.id, (l) => ({
          ...l,
          cropPreset: 'freeform',
          lockAspectRatio: false,
          pinZone: null,
        }));
        return;
      }

      if (preset === 'original') {
        const innerBox = getPinZoneRect(
          'full',
          slideWidth,
          slideHeight,
          slide.padding,
          slide.gap
        );
        const fitted = computeFittedOriginalRect(mediaAspect, innerBox);
        updateLayerById(layer.id, (l) => ({
          ...l,
          cropPreset: 'original',
          lockAspectRatio: true,
          pinZone: null,
          x: fitted.x,
          y: fitted.y,
          width: fitted.width,
          height: fitted.height,
          crop: { x: 0, y: 0, width: 1, height: 1 },
        }));
        return;
      }

      let targetRatio = slideWidth / slideHeight;
      if (preset === 'match-slide') {
        targetRatio = slideWidth / slideHeight;
      } else {
        const opt = CROP_PRESET_OPTIONS.find((o) => o.id === preset);
        if (opt?.ratio) targetRatio = opt.ratio;
      }

      // Reshape layer frame around its current center to match targetRatio
      const cx = layer.x + layer.width / 2;
      const cy = layer.y + layer.height / 2;
      const area = layer.width * layer.height;
      let newW = Math.sqrt(area * targetRatio);
      let newH = newW / targetRatio;

      if (newW > slideWidth) {
        newW = slideWidth;
        newH = newW / targetRatio;
      }
      if (newH > slideHeight) {
        newH = slideHeight;
        newW = newH * targetRatio;
      }

      const newX = Math.max(0, Math.min(slideWidth - newW, cx - newW / 2));
      const newY = Math.max(0, Math.min(slideHeight - newH, cy - newH / 2));

      updateLayerById(layer.id, (l) => ({
        ...l,
        cropPreset: preset,
        lockAspectRatio: true,
        pinZone: null,
        x: Math.round(newX),
        y: Math.round(newY),
        width: Math.round(newW),
        height: Math.round(newH),
        crop: adjustCropPreservingCenter(l.crop, mediaAspect, targetRatio),
      }));
    },
    [selectedLayerContext, slideWidth, slideHeight, updateLayerById, pushHistory]
  );

  // Pin Selected Layer to a Zone (FR-6)
  const handlePinLayerToZone = useCallback(
    (zone: Exclude<PinZone, null>) => {
      if (!selectedLayerContext) return;
      pushHistory();
      const { layer, slide, asset } = selectedLayerContext;
      const rect = getPinZoneRect(
        zone,
        slideWidth,
        slideHeight,
        slide.padding,
        slide.gap
      );
      const mediaAspect = asset?.aspectRatio || 1;
      const frameAspect = rect.width / Math.max(1, rect.height);

      updateLayerById(layer.id, (l) => ({
        ...l,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        pinZone: zone,
        lockAspectRatio: true,
        cropPreset: zone === 'full' ? 'match-slide' : 'freeform',
        crop: adjustCropPreservingCenter(l.crop, mediaAspect, frameAspect),
      }));
    },
    [selectedLayerContext, slideWidth, slideHeight, updateLayerById, pushHistory]
  );

  // Bridge Selected Layer Across Current & Next Slide Seam (P-1)
  const handleBridgeAcrossNextSlide = useCallback(() => {
    if (!selectedLayerContext) return;
    pushHistory();
    const { layer, slideIndex, asset } = selectedLayerContext;

    // Ensure there is a next slide to bridge onto
    setSlides((prev) => {
      const next = [...prev];
      if (slideIndex >= next.length - 1) {
        next.push({
          id: `slide_${Date.now()}_bridge`,
          layers: [],
          background: { ...next[slideIndex].background },
          padding: next[slideIndex].padding,
          gap: next[slideIndex].gap,
        });
      }
      const mediaAspect = asset?.aspectRatio || 1.5;
      const bridgeH = Math.round(slideHeight * 0.76);
      const bridgeW = Math.round(Math.min(slideWidth * 1.4, bridgeH * mediaAspect));
      const bridgeX = Math.round(slideWidth - bridgeW / 2);
      const bridgeY = Math.round((slideHeight - bridgeH) / 2);

      next[slideIndex] = {
        ...next[slideIndex],
        layers: next[slideIndex].layers.map((l) =>
          l.id === layer.id
            ? {
                ...l,
                x: bridgeX,
                y: bridgeY,
                width: bridgeW,
                height: bridgeH,
                pinZone: null,
                cropPreset: 'freeform',
                crop: adjustCropPreservingCenter(
                  l.crop,
                  mediaAspect,
                  bridgeW / bridgeH
                ),
              }
            : l
        ),
      };
      return next;
    });
    setViewMode('strip');
  }, [selectedLayerContext, slideWidth, slideHeight, pushHistory]);

  // Zoom Inside Crop Frame (FR-4)
  const currentZoomFactor = useMemo(() => {
    if (!selectedLayerContext) return 1;
    const { layer, asset } = selectedLayerContext;
    const mediaAspect = asset?.aspectRatio || 1;
    const frameAspect = layer.width / Math.max(1, layer.height);
    const maxW = mediaAspect > frameAspect ? frameAspect / mediaAspect : 1;
    return Math.max(1, Math.min(5, maxW / Math.max(0.05, layer.crop.width)));
  }, [selectedLayerContext]);

  const handleCropZoomChange = useCallback(
    (newZoom: number) => {
      if (!selectedLayerContext) return;
      const { layer, asset } = selectedLayerContext;
      const mediaAspect = asset?.aspectRatio || 1;
      const frameAspect = layer.width / Math.max(1, layer.height);

      const baseW = mediaAspect > frameAspect ? frameAspect / mediaAspect : 1;
      const baseH = mediaAspect > frameAspect ? 1 : mediaAspect / frameAspect;

      const w = Math.max(0.08, Math.min(1, baseW / newZoom));
      const h = Math.max(0.08, Math.min(1, baseH / newZoom));
      const cx = layer.crop.x + layer.crop.width / 2;
      const cy = layer.crop.y + layer.crop.height / 2;

      updateLayerById(layer.id, (l) => ({
        ...l,
        crop: {
          x: Math.max(0, Math.min(1 - w, cx - w / 2)),
          y: Math.max(0, Math.min(1 - h, cy - h / 2)),
          width: w,
          height: h,
        },
      }));
    },
    [selectedLayerContext, updateLayerById]
  );

  // Panorama Split Modal Live Preview Renderer
  useEffect(() => {
    if (!splitModalAsset || !splitPreviewCanvasRef.current) return;
    const canvas = splitPreviewCanvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx || !splitModalAsset.element) return;

    const previewW = 680;
    const previewH = Math.round(previewW / Math.max(0.4, splitModalAsset.aspectRatio));
    canvas.width = previewW;
    canvas.height = previewH;

    // Draw dimmed full image
    ctx.clearRect(0, 0, previewW, previewH);
    ctx.globalAlpha = 0.32;
    ctx.drawImage(splitModalAsset.element, 0, 0, previewW, previewH);
    ctx.globalAlpha = 1;

    // Highlight active unified crop box
    const cx = splitUnifiedCrop.x * previewW;
    const cy = splitUnifiedCrop.y * previewH;
    const cw = splitUnifiedCrop.width * previewW;
    const ch = splitUnifiedCrop.height * previewH;

    ctx.save();
    ctx.beginPath();
    ctx.rect(cx, cy, cw, ch);
    ctx.clip();
    ctx.drawImage(splitModalAsset.element, 0, 0, previewW, previewH);
    ctx.restore();

    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 2;
    ctx.strokeRect(cx, cy, cw, ch);

    // Draw N-1 vertical slide cut seam lines
    for (let i = 1; i < splitSlideCount; i++) {
      const sx = cx + (cw * i) / splitSlideCount;
      ctx.beginPath();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2;
      ctx.moveTo(sx, cy);
      ctx.lineTo(sx, cy + ch);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Slide labels inside each slice
    for (let i = 0; i < splitSlideCount; i++) {
      const sliceX = cx + (cw * i) / splitSlideCount;
      ctx.fillStyle = 'rgba(9, 9, 11, 0.78)';
      ctx.fillRect(sliceX + 8, cy + 8, 64, 22);
      ctx.fillStyle = '#f8fafc';
      ctx.font = '600 11px Inter, sans-serif';
      ctx.fillText(`Slide ${i + 1}`, sliceX + 16, cy + 23);
    }
  }, [splitModalAsset, splitSlideCount, splitUnifiedCrop]);

  // Run Full or Single Slide Export Pipeline (FR-8, FR-9)
  const handleRunExport = useCallback(
    async (onlySlideIndex?: number) => {
      setIsExporting(true);
      const indices =
        typeof onlySlideIndex === 'number'
          ? [onlySlideIndex]
          : slides.map((_, idx) => idx);

      const initialProgress: ExportSlideProgress[] = indices.map((idx) => ({
        slideIndex: idx,
        slideId: slides[idx].id,
        type: slideContainsVideo(slides, idx, slideWidth, assetsById)
          ? 'video'
          : 'photo',
        status: 'pending',
        progress: 0,
      }));
      setExportProgressList(initialProgress);

      const completed: ExportSlideProgress[] = [...initialProgress];

      for (let i = 0; i < indices.length; i++) {
        const sIdx = indices[i];
        const isVid = completed[i].type === 'video';
        completed[i] = { ...completed[i], status: 'rendering', progress: 0.1 };
        setExportProgressList([...completed]);

        try {
          if (isVid) {
            const res = await exportVideoSlide(
              slides,
              sIdx,
              slideWidth,
              slideHeight,
              assetsById,
              (p) => {
                completed[i] = {
                  ...completed[i],
                  status: p > 0.8 ? 'encoding' : 'rendering',
                  progress: p,
                };
                setExportProgressList([...completed]);
              }
            );
            const filename = `carousel_slide_${String(sIdx + 1).padStart(
              2,
              '0'
            )}.${res.ext}`;
            completed[i] = {
              ...completed[i],
              status: 'done',
              progress: 1,
              blob: res.blob,
              filename,
              width: res.width,
              height: res.height,
              sizeBytes: res.blob.size,
              qualityUsed: 1,
            };
          } else {
            const res = await exportStaticSlide(
              slides,
              sIdx,
              slideWidth,
              slideHeight,
              assetsById,
              exportSettings
            );
            const filename = `carousel_slide_${String(sIdx + 1).padStart(
              2,
              '0'
            )}.${res.ext}`;
            completed[i] = {
              ...completed[i],
              status: 'done',
              progress: 1,
              blob: res.blob,
              filename,
              width: res.width,
              height: res.height,
              sizeBytes: res.blob.size,
              qualityUsed: res.qualityUsed,
            };
          }
        } catch (err) {
          completed[i] = {
            ...completed[i],
            status: 'error',
            progress: 0,
            error: String(err),
          };
        }
        setExportProgressList([...completed]);
      }

      setIsExporting(false);

      if (typeof onlySlideIndex === 'number') {
        const item = completed[0];
        if (item?.blob && item.filename) {
          triggerBlobDownload(item.blob, item.filename);
        }
      } else {
        await bundleExportsIntoZip(completed, `insta_carousel_${aspectRatio.replace(':', 'x')}.zip`);
      }
    },
    [slides, slideWidth, slideHeight, assetsById, exportSettings, aspectRatio]
  );

  // Usage counts for each asset across slides
  const assetUsageCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of slides) {
      for (const l of s.layers) {
        counts.set(l.assetId, (counts.get(l.assetId) || 0) + 1);
      }
    }
    return counts;
  }, [slides]);

  return (
    <div className="studio-app">
      {/* Top Command Bar */}
      <header className="topbar">
        <div className="brand-group">
          <div className="brand-mark">CF</div>
          <h1 className="brand-title">CarouselFlow</h1>
          <span className="brand-subtitle">
            {currentSpec.width}×{currentSpec.height}
          </span>
        </div>

        <div className="topbar-center">
          {/* FR-3: Global Instagram Aspect Ratio Selector */}
          <div
            className="segmented-control"
            role="group"
            aria-label="Instagram Carousel Aspect Ratio"
          >
            {(Object.keys(CAROUSEL_ASPECT_RATIOS) as CarouselAspectRatio[]).map(
              (ratioKey) => {
                const spec = CAROUSEL_ASPECT_RATIOS[ratioKey];
                return (
                  <button
                    key={ratioKey}
                    id={`aspect-btn-${ratioKey.replace(/[^a-z0-9]/gi, '-')}`}
                    className={`seg-btn ${
                      aspectRatio === ratioKey ? 'active-amber' : ''
                    }`}
                    onClick={() => handleCarouselAspectRatioChange(ratioKey)}
                    title={spec.description}
                  >
                    <span>{spec.shortLabel}</span>
                  </button>
                );
              }
            )}
          </div>

          {/* P-1: Single Slide vs Continuous Seamless Strip View */}
          <div
            className="segmented-control"
            role="group"
            aria-label="Workspace View Mode"
          >
            <button
              id="view-mode-single-btn"
              className={`seg-btn ${viewMode === 'single' ? 'active' : ''}`}
              onClick={() => setViewMode('single')}
            >
              Single
            </button>
            <button
              id="view-mode-strip-btn"
              className={`seg-btn ${viewMode === 'strip' ? 'active' : ''}`}
              onClick={() => setViewMode('strip')}
            >
              Strip ({slides.length})
            </button>
          </div>

          {/* Stage Guides & Snapping Toggles (absorbed into Top Bar) */}
          <div
            className="segmented-control"
            role="group"
            aria-label="Stage Guides and Snapping"
          >
            <button
              id="toggle-snapping-btn"
              className={`seg-btn ${enableSnapping ? 'active-amber' : ''}`}
              onClick={() => setEnableSnapping((v) => !v)}
              title="Magnetic Snapping to Edges, Centerlines, Thirds & Sibling Photos"
            >
              🧲 Snap
            </button>
            <button
              id="toggle-profile-grid-guide-btn"
              className={`seg-btn ${showProfileGridGuide ? 'active' : ''}`}
              onClick={() => setShowProfileGridGuide((v) => !v)}
              title="Preview 1:1 Profile Grid Crop on Cover Slide 1"
            >
              ⊞ 1:1 Cover
            </button>
            <button
              id="toggle-ig-chrome-guide-btn"
              className={`seg-btn ${showInstagramChromeGuide ? 'active' : ''}`}
              onClick={() => setShowInstagramChromeGuide((v) => !v)}
              title="Show Instagram Native UI Counter & Tag Safe Zones"
            >
              👁 Safe Zones
            </button>
            <button
              id="toggle-focal-point-btn"
              className={`seg-btn ${showSmartFocalPoints ? 'active' : ''}`}
              onClick={() => setShowSmartFocalPoints((v) => !v)}
              title="Display Detected Smart Auto-Crop Focal Point"
            >
              ◎ Focal
            </button>
          </div>

          {/* Undo / Redo */}
          <div className="segmented-control">
            <button
              id="undo-btn"
              className="seg-btn"
              disabled={past.length === 0}
              onClick={handleUndo}
              title="Undo (Ctrl/Cmd+Z)"
            >
              ↶
            </button>
            <button
              id="redo-btn"
              className="seg-btn"
              disabled={future.length === 0}
              onClick={handleRedo}
              title="Redo (Ctrl/Cmd+Shift+Z)"
            >
              ↷
            </button>
          </div>
        </div>

        <div className="topbar-right">
          {/* P-2: Interactive Instagram Swipe Simulator */}
          <button
            id="open-swipe-simulator-btn"
            className="btn btn-sky"
            onClick={() => {
              setSimSlideIndex(activeSlideIndex);
              setShowSwipeSimulator(true);
            }}
          >
            📱 Swipe Preview
          </button>

          {/* FR-8 & FR-9: Export Carousel */}
          <button
            id="open-export-modal-btn"
            className="btn btn-primary"
            onClick={() => {
              setExportProgressList([]);
              setShowExportModal(true);
            }}
          >
            ⬇ Export ({slides.length})
          </button>
        </div>
      </header>

      {/* Main 3-Column Studio Workspace */}
      <main className="workspace-grid">
        {/* LEFT SIDEBAR: Media Bin (FR-1 & FR-7) */}
        <aside className="sidebar-left">
          <div className="panel-header">
            <span className="panel-title">Media Library ({assets.length})</span>
            {assets.length > 0 && (
              <button
                id="import-more-header-btn"
                className="btn btn-sm"
                onClick={() => fileInputRef.current?.click()}
              >
                + Import
              </button>
            )}
          </div>

          <input
            ref={fileInputRef}
            id="media-file-input"
            type="file"
            accept="image/*,video/*,.heic,.heif,.mov,.mp4,.m4v,.webm,.mkv,.avi"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              handleFilesSelected(e.target.files);
              e.target.value = '';
            }}
          />

          <div
            id="media-dropzone"
            className={`dropzone ${isDraggingFileOver ? 'dragging' : ''}`}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setIsDraggingFileOver(true);
            }}
            onDragLeave={() => setIsDraggingFileOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDraggingFileOver(false);
              handleFilesSelected(e.dataTransfer.files);
            }}
          >
            <div className="dropzone-title">+ Import Photos &amp; Videos</div>
            <div className="dropzone-sub">
              Drag &amp; drop or click to browse (JPG, PNG, WebP, HEIC, MP4, MOV)
            </div>
          </div>

          {importStatus && (
            <div className="import-status-banner" role="status">
              <span className="import-spinner">⏳</span>
              <span>{importStatus}</span>
            </div>
          )}

          {importErrors.length > 0 && (
            <div className="import-error-banner" role="alert">
              <div className="import-error-header">
                <span>⚠ Import Error ({importErrors.length})</span>
                <button
                  className="btn btn-sm"
                  onClick={() => setImportErrors([])}
                  title="Dismiss Import Errors"
                >
                  ✕ Dismiss
                </button>
              </div>
              <ul className="import-error-list">
                {importErrors.map((errMsg, idx) => (
                  <li key={idx}>{errMsg}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="asset-list">
            {assets.length === 0 && (
              <div className="empty-library-hint">
                No photos or videos imported yet. Drop files above or click to
                browse from your computer.
              </div>
            )}
            {assets.map((asset) => {
              const usedCount = assetUsageCounts.get(asset.id) || 0;
              return (
                <div key={asset.id} className="asset-card">
                  <div className="asset-thumb-wrap">
                    <img
                      src={asset.thumbnailUrl}
                      alt={asset.name}
                      className="asset-thumb"
                    />
                    <div className="asset-badges">
                      <span
                        className={`badge ${
                          asset.type === 'video' ? 'badge-video' : ''
                        }`}
                      >
                        {asset.type === 'video'
                          ? `VIDEO · ${asset.duration.toFixed(1)}s`
                          : `${asset.naturalWidth}×${asset.naturalHeight}`}
                      </span>
                      {usedCount > 0 && (
                        <span className="badge badge-used">
                          Used ×{usedCount}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="asset-meta">
                    <div className="asset-header-row">
                      <div className="asset-name" title={asset.name}>
                        {asset.name}
                      </div>
                      <button
                        id={`delete-asset-${asset.id}`}
                        className="btn btn-sm btn-danger asset-delete-btn"
                        onClick={() => handleDeleteAsset(asset.id)}
                        title="Delete imported photo/video from library"
                      >
                        🗑 Delete
                      </button>
                    </div>
                    <div className="asset-actions">
                      <button
                        id={`add-to-slide-${asset.id}`}
                        className="btn btn-sm"
                        onClick={() => handleAddAssetToCurrentSlide(asset)}
                        title="Add this media onto the active slide (fitted with original proportions)"
                      >
                        + To Slide {activeSlideIndex + 1}
                      </button>
                      <button
                        id={`add-new-slide-${asset.id}`}
                        className="btn btn-sm"
                        onClick={() => handleAddAssetAsNewSlide(asset)}
                        title="Create a new slide with this media"
                      >
                        + New Slide
                      </button>
                      {asset.type === 'photo' && (
                        <button
                          id={`split-panorama-${asset.id}`}
                          className="btn btn-sm btn-sky btn-split-wide"
                          onClick={() => handleOpenSplitModal(asset)}
                        >
                          ✂ Split Photo Across Multiple Slides
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </aside>

        {/* CENTER COLUMN: Interactive Stage & Bottom Slide Filmstrip */}
        <section className="center-column">
          <div className="stage-viewport-wrap">
            <div
              className="stage-viewport"
              ref={stageViewportRef}
              onWheel={handleStageWheel}
              onPointerDown={(e) => {
                if (
                  e.target === e.currentTarget ||
                  (e.target as HTMLElement).classList.contains(
                    'canvas-shadow-wrap'
                  )
                ) {
                  setSelectedLayerId(null);
                  setCropModeLayerId(null);
                }
              }}
            >
              <div className="canvas-shadow-wrap">
                <canvas
                  ref={stageCanvasRef}
                  id="carousel-stage-canvas"
                  className="stage-canvas"
                  onPointerDown={handleStagePointerDown}
                  onPointerMove={handleStagePointerMove}
                  onPointerUp={handleStagePointerUp}
                  onDoubleClick={handleStageDoubleClick}
                />
              </div>
            </div>

            {/* Quick Layer Manipulation Tools Dock (Anchored next to Right Sidebar) */}
            <div
              className="stage-right-dock"
              role="toolbar"
              aria-label="Quick Layer Manipulation Tools"
            >
              <button
                id="toggle-crop-mode-btn"
                className={`dock-tool-btn ${
                  cropModeLayerId ? 'active-amber' : ''
                }`}
                disabled={!selectedLayerContext}
                onClick={() =>
                  setCropModeLayerId((prev) =>
                    prev === selectedLayerId ? null : selectedLayerId
                  )
                }
                title="Toggle Inner Pan / Crop Mode (or Double-Click Layer)"
              >
                <span>⌗</span>
                <span>{cropModeLayerId ? 'Done Pan/Crop' : 'Pan / Crop'}</span>
              </button>

              <button
                id="toggle-lock-aspect-btn"
                className={`dock-tool-btn ${
                  selectedLayerContext &&
                  selectedLayerContext.layer.lockAspectRatio !== false
                    ? 'active-sky'
                    : ''
                }`}
                disabled={!selectedLayerContext}
                onClick={handleToggleLockAspectRatio}
                title="Lock or Unlock Aspect Ratio when Resizing Layer"
              >
                <span>
                  {selectedLayerContext?.layer.lockAspectRatio === false
                    ? '🔓'
                    : '🔒'}
                </span>
                <span>
                  {selectedLayerContext?.layer.lockAspectRatio === false
                    ? 'Ratio Unlocked'
                    : 'Ratio Locked'}
                </span>
              </button>

              <button
                id="fit-original-proportions-btn"
                className="dock-tool-btn"
                disabled={!selectedLayerContext}
                onClick={handleFitLayerOriginalToSlide}
                title="Fit Image with Original Proportions into Slide"
              >
                <span>⊡</span>
                <span>Fit Original</span>
              </button>

              <button
                id="run-smart-autocrop-btn"
                className="dock-tool-btn"
                disabled={!selectedLayerContext?.asset}
                onClick={() => {
                  if (!selectedLayerContext?.asset) return;
                  pushHistory();
                  const { layer, asset } = selectedLayerContext;
                  const smart = computeSmartCrop(
                    asset,
                    layer.width / Math.max(1, layer.height)
                  );
                  updateLayerById(layer.id, (l) => ({
                    ...l,
                    crop: smart,
                  }));
                }}
                title="Smart Content-Aware Auto-Crop Inside Current Frame"
              >
                <span>✨</span>
                <span>Auto-Crop</span>
              </button>

              <button
                id="reset-center-crop-btn"
                className="dock-tool-btn"
                disabled={!selectedLayerContext?.asset}
                onClick={() => {
                  if (!selectedLayerContext?.asset) return;
                  pushHistory();
                  const { layer, asset } = selectedLayerContext;
                  const centered = computeCenterCrop(
                    asset.aspectRatio,
                    layer.width / Math.max(1, layer.height)
                  );
                  updateLayerById(layer.id, (l) => ({
                    ...l,
                    crop: centered,
                  }));
                }}
                title="Reset Inner Crop to Center"
              >
                <span>⌖</span>
                <span>Center Crop</span>
              </button>
            </div>

            {/* Stage Zoom Controls (Bottom-Right of Stage Viewport) */}
            <div
              className="stage-zoom-bar"
              role="toolbar"
              aria-label="Slide Stage Zoom Controls"
            >
              <button
                id="zoom-out-btn"
                className="zoom-btn"
                onClick={() => handleChangeStageZoom(stageZoom - 0.15)}
                title="Zoom Out Slide (-)"
              >
                −
              </button>
              <input
                id="stage-zoom-slider"
                type="range"
                className="zoom-slider"
                min={0.25}
                max={3}
                step={0.05}
                value={stageZoom}
                onChange={(e) => handleChangeStageZoom(Number(e.target.value))}
                title="Slide Zoom Level"
              />
              <button
                id="zoom-in-btn"
                className="zoom-btn"
                onClick={() => handleChangeStageZoom(stageZoom + 0.15)}
                title="Zoom In Slide (+)"
              >
                +
              </button>
              <div className="num-input-wrap zoom-num-wrap">
                <input
                  id="zoom-percent-input"
                  type="number"
                  className="num-input"
                  min={25}
                  max={300}
                  step={5}
                  value={Math.round(stageZoom * 100)}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    if (!Number.isNaN(val) && val > 0) {
                      handleChangeStageZoom(val / 100);
                    }
                  }}
                  title="Writable Slide Zoom Percentage"
                />
                <span className="num-unit">%</span>
              </div>
              <button
                id="zoom-reset-btn"
                className="zoom-btn zoom-fit-btn"
                onClick={() => handleChangeStageZoom(1)}
                title="Reset Slide Zoom to Fit (100%)"
              >
                Fit
              </button>
            </div>
          </div>

          {/* Bottom Filmstrip (FR-2) */}
          <div className="filmstrip-bar">
            <div className="filmstrip-header">
              <span className="panel-title">
                Carousel Slides ({slides.length} / 20)
              </span>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  id="add-blank-slide-btn"
                  className="btn btn-sm"
                  onClick={handleAddBlankSlide}
                >
                  + Add Blank Slide
                </button>
              </div>
            </div>

            <div className="filmstrip-track">
              {slides.map((slide, idx) => {
                const hasVid = slideContainsVideo(
                  slides,
                  idx,
                  slideWidth,
                  assetsById
                );
                const thumbH = 74;
                const thumbW = Math.round(
                  thumbH * (slideWidth / Math.max(1, slideHeight))
                );
                return (
                  <div
                    key={slide.id}
                    id={`filmstrip-slide-${idx + 1}`}
                    className={`slide-card ${
                      idx === activeSlideIndex ? 'active' : ''
                    }`}
                    onClick={() => {
                      setActiveSlideIndex(idx);
                      setSelectedLayerId(null);
                      setCropModeLayerId(null);
                    }}
                  >
                    <div
                      className="slide-thumb-box"
                      style={{ width: thumbW, height: thumbH }}
                    >
                      <SlideThumbnailCanvas
                        slides={slides}
                        slideIndex={idx}
                        slideWidth={slideWidth}
                        slideHeight={slideHeight}
                        assetsById={assetsById}
                        width={thumbW}
                        height={thumbH}
                      />
                      <span
                        className={`badge ${hasVid ? 'badge-video' : ''}`}
                        style={{
                          position: 'absolute',
                          bottom: 3,
                          right: 3,
                          fontSize: 9,
                          padding: '1px 4px',
                        }}
                      >
                        {hasVid ? 'MP4' : 'JPG'}
                      </span>
                    </div>

                    <div className="slide-card-controls">
                      <span style={{ fontWeight: 600 }}>#{idx + 1}</span>
                      <div
                        className="slide-mini-btns"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          className="icon-btn"
                          disabled={idx === 0}
                          onClick={() => handleMoveSlide(idx, -1)}
                          title="Move Slide Left"
                        >
                          ◀
                        </button>
                        <button
                          className="icon-btn"
                          disabled={idx === slides.length - 1}
                          onClick={() => handleMoveSlide(idx, 1)}
                          title="Move Slide Right"
                        >
                          ▶
                        </button>
                        <button
                          className="icon-btn"
                          onClick={() => handleDuplicateSlide(idx)}
                          title="Duplicate Slide"
                        >
                          ⧉
                        </button>
                        <button
                          className="icon-btn"
                          disabled={slides.length <= 1}
                          onClick={() => handleDeleteSlide(idx)}
                          title="Delete Slide"
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* RIGHT SIDEBAR: Clean Tabbed Inspector (Layer vs Slide) */}
        <aside className="sidebar-right">
          {/* Top-Level Inspector Mode Tabs */}
          <div className="inspector-tabs-header">
            <div className="inspector-tab-bar" role="tablist">
              <button
                id="inspector-tab-layer"
                role="tab"
                aria-selected={rightSidebarTab === 'layer'}
                className={`inspector-tab-btn ${
                  rightSidebarTab === 'layer' ? 'active' : ''
                }`}
                onClick={() => setRightSidebarTab('layer')}
              >
                <span>🖼 Layer</span>
                {selectedLayerContext && (
                  <span className="tab-pill">
                    {selectedLayerContext.asset?.type === 'video'
                      ? 'Video'
                      : 'Photo'}
                  </span>
                )}
              </button>
              <button
                id="inspector-tab-slide"
                role="tab"
                aria-selected={rightSidebarTab === 'slide'}
                className={`inspector-tab-btn ${
                  rightSidebarTab === 'slide' ? 'active' : ''
                }`}
                onClick={() => setRightSidebarTab('slide')}
              >
                <span>🗂 Slide #{activeSlideIndex + 1}</span>
                <span className="tab-pill">
                  {activeSlide?.layers.length || 0}
                </span>
              </button>
            </div>
          </div>

          <div className="inspector-scroll-body">
            {rightSidebarTab === 'layer' ? (
              selectedLayerContext ? (
                <>
                  {/* Card 1: Crop Ratio Presets & Inner Zoom */}
                  <div className="inspector-section">
                    <div className="section-heading">
                      <span
                        className="layer-title-truncate"
                        title={selectedLayerContext.asset?.name}
                      >
                        {selectedLayerContext.asset?.name || 'Selected Layer'}
                      </span>
                      <span className="control-value">
                        {selectedLayerContext.layer.width}×
                        {selectedLayerContext.layer.height}px
                      </span>
                    </div>

                    <div className="control-row">
                      <span className="control-label">Inner Crop Zoom</span>
                      <span className="control-value">
                        {currentZoomFactor.toFixed(2)}×
                      </span>
                    </div>
                    <input
                      id="crop-zoom-slider"
                      type="range"
                      className="range-slider"
                      min={1}
                      max={4}
                      step={0.05}
                      value={currentZoomFactor}
                      onChange={(e) =>
                        handleCropZoomChange(Number(e.target.value))
                      }
                    />

                    <div
                      className="control-label"
                      style={{ marginTop: 6, marginBottom: 6 }}
                    >
                      Frame Aspect Preset
                    </div>
                    <div className="preset-grid">
                      {CROP_PRESET_OPTIONS.map((opt) => (
                        <button
                          key={opt.id}
                          id={`crop-preset-${opt.id}`}
                          className={`btn btn-sm ${
                            selectedLayerContext.layer.cropPreset === opt.id
                              ? 'btn-sky'
                              : ''
                          }`}
                          onClick={() => handleSelectCropPreset(opt.id)}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Card 3: Pinning & Cross-Slide Seam (All 10 Pin Zones incl. Bottom-Right) */}
                  <div className="inspector-section">
                    <div className="section-heading">
                      <span>Pinning &amp; Cross-Slide Seam</span>
                    </div>
                    <div className="pin-grid">
                      {(
                        [
                          ['full', 'Full Bleed'],
                          ['center', 'Center Card'],
                          ['left-half', 'Left 1/2'],
                          ['right-half', 'Right 1/2'],
                          ['top-half', 'Top 1/2'],
                          ['bottom-half', 'Bottom 1/2'],
                          ['top-left', 'Top-Left'],
                          ['top-right', 'Top-Right'],
                          ['bottom-left', 'Btm-Left'],
                          ['bottom-right', 'Btm-Right'],
                        ] as [Exclude<PinZone, null>, string][]
                      ).map(([zone, label]) => (
                        <button
                          key={zone}
                          id={`pin-zone-${zone}`}
                          className={`btn btn-sm ${
                            selectedLayerContext.layer.pinZone === zone
                              ? 'btn-sky'
                              : ''
                          }`}
                          onClick={() => handlePinLayerToZone(zone)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>

                    <button
                      id="bridge-next-slide-btn"
                      className="btn btn-sm btn-sky"
                      style={{ width: '100%', marginTop: 8 }}
                      onClick={handleBridgeAcrossNextSlide}
                    >
                      ↔ Bridge Layer Across Next Slide Seam
                    </button>
                  </div>

                  {/* Card 4: Video Trim, Mute & Loop Sync Controls */}
                  {selectedLayerContext.asset?.type === 'video' && (
                    <div className="inspector-section">
                      <div className="section-heading">
                        <span>Video Trim &amp; Audio Sync</span>
                        <span className="control-value">
                          {(
                            selectedLayerContext.layer.trimEnd -
                            selectedLayerContext.layer.trimStart
                          ).toFixed(1)}
                          s
                        </span>
                      </div>

                      <div className="control-row">
                        <span className="control-label">Trim Start</span>
                        <span className="control-value">
                          {selectedLayerContext.layer.trimStart.toFixed(1)}s
                        </span>
                      </div>
                      <input
                        id="video-trim-start-slider"
                        type="range"
                        className="range-slider"
                        min={0}
                        max={Math.max(
                          0.1,
                          (selectedLayerContext.asset.duration || 5) - 0.5
                        )}
                        step={0.1}
                        value={selectedLayerContext.layer.trimStart}
                        onChange={(e) => {
                          const val = Number(e.target.value);
                          updateLayerById(
                            selectedLayerContext.layer.id,
                            (l) => ({
                              ...l,
                              trimStart: Math.min(val, l.trimEnd - 0.5),
                            })
                          );
                        }}
                      />

                      <div className="control-row">
                        <span className="control-label">Trim End</span>
                        <span className="control-value">
                          {selectedLayerContext.layer.trimEnd.toFixed(1)}s
                        </span>
                      </div>
                      <input
                        id="video-trim-end-slider"
                        type="range"
                        className="range-slider"
                        min={0.5}
                        max={Math.min(
                          60,
                          selectedLayerContext.asset.duration || 5
                        )}
                        step={0.1}
                        value={selectedLayerContext.layer.trimEnd}
                        onChange={(e) => {
                          const val = Number(e.target.value);
                          updateLayerById(
                            selectedLayerContext.layer.id,
                            (l) => ({
                              ...l,
                              trimEnd: Math.max(val, l.trimStart + 0.5),
                            })
                          );
                        }}
                      />

                      <div className="control-row" style={{ marginTop: 6 }}>
                        <span className="control-label">Clip Audio</span>
                        <button
                          id="video-mute-toggle-btn"
                          className={`btn btn-sm ${
                            selectedLayerContext.layer.muted
                              ? 'btn-danger'
                              : 'btn-sky'
                          }`}
                          onClick={() =>
                            updateLayerById(
                              selectedLayerContext.layer.id,
                              (l) => ({
                                ...l,
                                muted: !l.muted,
                              })
                            )
                          }
                        >
                          {selectedLayerContext.layer.muted
                            ? '🔇 Muted'
                            : '🔊 Audio On'}
                        </button>
                      </div>

                      <div className="control-row">
                        <span className="control-label">
                          Shorter Clip Behavior
                        </span>
                        <div className="segmented-control">
                          <button
                            className={`seg-btn ${
                              selectedLayerContext.layer.endBehavior === 'loop'
                                ? 'active'
                                : ''
                            }`}
                            onClick={() =>
                              updateLayerById(
                                selectedLayerContext.layer.id,
                                (l) => ({
                                  ...l,
                                  endBehavior: 'loop',
                                })
                              )
                            }
                          >
                            Loop
                          </button>
                          <button
                            className={`seg-btn ${
                              selectedLayerContext.layer.endBehavior ===
                              'freeze'
                                ? 'active'
                                : ''
                            }`}
                            onClick={() =>
                              updateLayerById(
                                selectedLayerContext.layer.id,
                                (l) => ({
                                  ...l,
                                  endBehavior: 'freeze',
                                })
                              )
                            }
                          >
                            Freeze End
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Card 5: Frame Styling & Layer Order */}
                  <div className="inspector-section">
                    <div className="section-heading">
                      <span>Frame Style &amp; Order</span>
                    </div>
                    <div className="control-row">
                      <span className="control-label">Corner Radius</span>
                      <div className="num-input-wrap">
                        <input
                          id="layer-radius-input"
                          type="number"
                          className="num-input"
                          min={0}
                          max={240}
                          step={1}
                          value={selectedLayerContext.layer.borderRadius}
                          onChange={(e) => {
                            const r = Math.max(
                              0,
                              Math.min(240, Number(e.target.value) || 0)
                            );
                            updateLayerById(
                              selectedLayerContext.layer.id,
                              (l) => ({
                                ...l,
                                borderRadius: r,
                              })
                            );
                          }}
                        />
                        <span className="num-unit">px</span>
                      </div>
                    </div>
                    <input
                      id="layer-radius-slider"
                      type="range"
                      className="range-slider"
                      min={0}
                      max={80}
                      step={1}
                      value={Math.min(
                        80,
                        selectedLayerContext.layer.borderRadius
                      )}
                      onChange={(e) => {
                        const r = Number(e.target.value);
                        updateLayerById(selectedLayerContext.layer.id, (l) => ({
                          ...l,
                          borderRadius: r,
                        }));
                      }}
                    />

                    <div className="control-row">
                      <button
                        id="toggle-layer-shadow-btn"
                        className={`btn btn-sm ${
                          selectedLayerContext.layer.shadow ? 'btn-sky' : ''
                        }`}
                        onClick={() =>
                          updateLayerById(
                            selectedLayerContext.layer.id,
                            (l) => ({
                              ...l,
                              shadow: !l.shadow,
                            })
                          )
                        }
                      >
                        {selectedLayerContext.layer.shadow
                          ? '✓ Shadow On'
                          : 'Shadow Off'}
                      </button>
                      <button
                        id="bring-layer-front-btn"
                        className="btn btn-sm"
                        onClick={() => {
                          const maxZ =
                            selectedLayerContext.slide.layers.reduce(
                              (m, l) => Math.max(m, l.zIndex),
                              0
                            );
                          updateLayerById(
                            selectedLayerContext.layer.id,
                            (l) => ({
                              ...l,
                              zIndex: maxZ + 1,
                            })
                          );
                        }}
                      >
                        ↑ Front
                      </button>
                      <button
                        id="delete-layer-btn"
                        className="btn btn-sm btn-danger"
                        onClick={() => {
                          pushHistory();
                          const idToRemove = selectedLayerContext.layer.id;
                          setSlides((prev) =>
                            prev.map((s) => ({
                              ...s,
                              layers: s.layers.filter(
                                (l) => l.id !== idToRemove
                              ),
                            }))
                          );
                          setSelectedLayerId(null);
                        }}
                      >
                        🗑 Remove
                      </button>
                    </div>

                    {/* Configurable Drop Shadow Controls (Visible when Shadow On) */}
                    {selectedLayerContext.layer.shadow && (
                      <div className="shadow-config-box">
                        <div className="control-row">
                          <span className="control-label">Shadow Blur</span>
                          <div className="num-input-wrap">
                            <input
                              id="shadow-blur-input"
                              type="number"
                              className="num-input"
                              min={0}
                              max={160}
                              step={1}
                              value={
                                selectedLayerContext.layer.shadowBlur ?? 24
                              }
                              onChange={(e) => {
                                const val = Math.max(
                                  0,
                                  Math.min(160, Number(e.target.value) || 0)
                                );
                                updateLayerById(
                                  selectedLayerContext.layer.id,
                                  (l) => ({
                                    ...l,
                                    shadowBlur: val,
                                  })
                                );
                              }}
                            />
                            <span className="num-unit">px</span>
                          </div>
                        </div>
                        <input
                          id="shadow-blur-slider"
                          type="range"
                          className="range-slider"
                          min={0}
                          max={100}
                          step={1}
                          value={Math.min(
                            100,
                            selectedLayerContext.layer.shadowBlur ?? 24
                          )}
                          onChange={(e) => {
                            const val = Number(e.target.value);
                            updateLayerById(
                              selectedLayerContext.layer.id,
                              (l) => ({
                                ...l,
                                shadowBlur: val,
                              })
                            );
                          }}
                        />

                        <div className="control-row">
                          <span className="control-label">Shadow Offset X</span>
                          <div className="num-input-wrap">
                            <input
                              id="shadow-offset-x-input"
                              type="number"
                              className="num-input"
                              min={-120}
                              max={120}
                              step={1}
                              value={
                                selectedLayerContext.layer.shadowOffsetX ?? 0
                              }
                              onChange={(e) => {
                                const val = Math.max(
                                  -120,
                                  Math.min(120, Number(e.target.value) || 0)
                                );
                                updateLayerById(
                                  selectedLayerContext.layer.id,
                                  (l) => ({
                                    ...l,
                                    shadowOffsetX: val,
                                  })
                                );
                              }}
                            />
                            <span className="num-unit">px</span>
                          </div>
                        </div>
                        <input
                          id="shadow-offset-x-slider"
                          type="range"
                          className="range-slider"
                          min={-60}
                          max={60}
                          step={1}
                          value={Math.max(
                            -60,
                            Math.min(
                              60,
                              selectedLayerContext.layer.shadowOffsetX ?? 0
                            )
                          )}
                          onChange={(e) => {
                            const val = Number(e.target.value);
                            updateLayerById(
                              selectedLayerContext.layer.id,
                              (l) => ({
                                ...l,
                                shadowOffsetX: val,
                              })
                            );
                          }}
                        />

                        <div className="control-row">
                          <span className="control-label">Shadow Offset Y</span>
                          <div className="num-input-wrap">
                            <input
                              id="shadow-offset-y-input"
                              type="number"
                              className="num-input"
                              min={-120}
                              max={120}
                              step={1}
                              value={
                                selectedLayerContext.layer.shadowOffsetY ?? 12
                              }
                              onChange={(e) => {
                                const val = Math.max(
                                  -120,
                                  Math.min(120, Number(e.target.value) || 0)
                                );
                                updateLayerById(
                                  selectedLayerContext.layer.id,
                                  (l) => ({
                                    ...l,
                                    shadowOffsetY: val,
                                  })
                                );
                              }}
                            />
                            <span className="num-unit">px</span>
                          </div>
                        </div>
                        <input
                          id="shadow-offset-y-slider"
                          type="range"
                          className="range-slider"
                          min={-60}
                          max={60}
                          step={1}
                          value={Math.max(
                            -60,
                            Math.min(
                              60,
                              selectedLayerContext.layer.shadowOffsetY ?? 12
                            )
                          )}
                          onChange={(e) => {
                            const val = Number(e.target.value);
                            updateLayerById(
                              selectedLayerContext.layer.id,
                              (l) => ({
                                ...l,
                                shadowOffsetY: val,
                              })
                            );
                          }}
                        />

                        <div className="control-row">
                          <span className="control-label">Shadow Opacity</span>
                          <div className="num-input-wrap">
                            <input
                              id="shadow-opacity-input"
                              type="number"
                              className="num-input"
                              min={0}
                              max={100}
                              step={1}
                              value={Math.round(
                                (selectedLayerContext.layer.shadowOpacity ??
                                  0.45) * 100
                              )}
                              onChange={(e) => {
                                const pct = Math.max(
                                  0,
                                  Math.min(100, Number(e.target.value) || 0)
                                );
                                updateLayerById(
                                  selectedLayerContext.layer.id,
                                  (l) => ({
                                    ...l,
                                    shadowOpacity: pct / 100,
                                  })
                                );
                              }}
                            />
                            <span className="num-unit">%</span>
                          </div>
                        </div>
                        <input
                          id="shadow-opacity-slider"
                          type="range"
                          className="range-slider"
                          min={0}
                          max={100}
                          step={1}
                          value={Math.round(
                            (selectedLayerContext.layer.shadowOpacity ?? 0.45) *
                              100
                          )}
                          onChange={(e) => {
                            const pct = Number(e.target.value);
                            updateLayerById(
                              selectedLayerContext.layer.id,
                              (l) => ({
                                ...l,
                                shadowOpacity: pct / 100,
                              })
                            );
                          }}
                        />

                        <div className="control-row" style={{ marginTop: 4 }}>
                          <span className="control-label">Shadow Color</span>
                          <input
                            id="shadow-color-input"
                            type="color"
                            value={
                              selectedLayerContext.layer.shadowColor ||
                              '#000000'
                            }
                            onChange={(e) =>
                              updateLayerById(
                                selectedLayerContext.layer.id,
                                (l) => ({
                                  ...l,
                                  shadowColor: e.target.value,
                                })
                              )
                            }
                            style={{
                              width: 30,
                              height: 22,
                              border: 'none',
                              background: 'transparent',
                              cursor: 'pointer',
                            }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="inspector-empty-state">
                  <div className="inspector-empty-title">
                    No Image or Video Selected
                  </div>
                  <p className="inspector-empty-desc">
                    Select a photo or video on the slide canvas, or add one from
                    the Media Library on the left.
                  </p>
                  <button
                    className="btn btn-sm"
                    style={{ marginTop: 10 }}
                    onClick={() => setRightSidebarTab('slide')}
                  >
                    Switch to Slide #{activeSlideIndex + 1} Settings →
                  </button>
                </div>
              )
            ) : (
              /* TAB 2: SLIDE SETTINGS (Collage Templates, Margins & Backdrop) */
              activeSlide && (
                <>
                  <div className="inspector-section">
                    <div className="section-heading">
                      <span>
                        Slide #{activeSlideIndex + 1} Multi-Photo Layouts
                      </span>
                      <span className="control-value">
                        {activeSlide.layers.length} Layer
                        {activeSlide.layers.length === 1 ? '' : 's'}
                      </span>
                    </div>

                    <div className="preset-grid">
                      {COLLAGE_TEMPLATES.map((tmpl) => (
                        <button
                          key={tmpl.id}
                          id={`collage-tmpl-${tmpl.id}`}
                          className="btn btn-sm"
                          disabled={activeSlide.layers.length === 0}
                          onClick={() => {
                            pushHistory();
                            setSlides((prev) =>
                              prev.map((s, idx) =>
                                idx !== activeSlideIndex
                                  ? s
                                  : {
                                      ...s,
                                      layers: applyTemplateToLayers(
                                        tmpl.id as CollageTemplateId,
                                        s.layers,
                                        assetsById,
                                        slideWidth,
                                        slideHeight,
                                        s.padding,
                                        s.gap
                                      ),
                                    }
                              )
                            );
                          }}
                        >
                          {tmpl.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="inspector-section">
                    <div className="section-heading">
                      <span>Margins &amp; Spacing</span>
                    </div>

                    <div className="control-row">
                      <span className="control-label">
                        Outer Margin (Padding)
                      </span>
                      <div className="num-input-wrap">
                        <input
                          id="slide-padding-input"
                          type="number"
                          className="num-input"
                          min={0}
                          max={240}
                          step={1}
                          value={activeSlide.padding}
                          onChange={(e) => {
                            const newPad = Math.max(
                              0,
                              Math.min(240, Number(e.target.value) || 0)
                            );
                            setSlides((prev) =>
                              prev.map((s, idx) => {
                                if (idx !== activeSlideIndex) return s;
                                return {
                                  ...s,
                                  padding: newPad,
                                  layers: s.layers.map((l) => {
                                    if (!l.pinZone) return l;
                                    const rect = getPinZoneRect(
                                      l.pinZone,
                                      slideWidth,
                                      slideHeight,
                                      newPad,
                                      s.gap
                                    );
                                    const asset = assetsById.get(l.assetId);
                                    return {
                                      ...l,
                                      ...rect,
                                      crop: adjustCropPreservingCenter(
                                        l.crop,
                                        asset?.aspectRatio || 1,
                                        rect.width / Math.max(1, rect.height)
                                      ),
                                    };
                                  }),
                                };
                              })
                            );
                          }}
                        />
                        <span className="num-unit">px</span>
                      </div>
                    </div>
                    <input
                      id="slide-padding-slider"
                      type="range"
                      className="range-slider"
                      min={0}
                      max={120}
                      step={1}
                      value={Math.min(120, activeSlide.padding)}
                      onChange={(e) => {
                        const newPad = Number(e.target.value);
                        setSlides((prev) =>
                          prev.map((s, idx) => {
                            if (idx !== activeSlideIndex) return s;
                            return {
                              ...s,
                              padding: newPad,
                              layers: s.layers.map((l) => {
                                if (!l.pinZone) return l;
                                const rect = getPinZoneRect(
                                  l.pinZone,
                                  slideWidth,
                                  slideHeight,
                                  newPad,
                                  s.gap
                                );
                                const asset = assetsById.get(l.assetId);
                                return {
                                  ...l,
                                  ...rect,
                                  crop: adjustCropPreservingCenter(
                                    l.crop,
                                    asset?.aspectRatio || 1,
                                    rect.width / Math.max(1, rect.height)
                                  ),
                                };
                              }),
                            };
                          })
                        );
                      }}
                    />

                    <div className="control-row">
                      <span className="control-label">Inner Collage Gap</span>
                      <div className="num-input-wrap">
                        <input
                          id="slide-gap-input"
                          type="number"
                          className="num-input"
                          min={0}
                          max={240}
                          step={1}
                          value={activeSlide.gap}
                          onChange={(e) => {
                            const newGap = Math.max(
                              0,
                              Math.min(240, Number(e.target.value) || 0)
                            );
                            setSlides((prev) =>
                              prev.map((s, idx) => {
                                if (idx !== activeSlideIndex) return s;
                                return {
                                  ...s,
                                  gap: newGap,
                                  layers: s.layers.map((l) => {
                                    if (!l.pinZone) return l;
                                    const rect = getPinZoneRect(
                                      l.pinZone,
                                      slideWidth,
                                      slideHeight,
                                      s.padding,
                                      newGap
                                    );
                                    const asset = assetsById.get(l.assetId);
                                    return {
                                      ...l,
                                      ...rect,
                                      crop: adjustCropPreservingCenter(
                                        l.crop,
                                        asset?.aspectRatio || 1,
                                        rect.width / Math.max(1, rect.height)
                                      ),
                                    };
                                  }),
                                };
                              })
                            );
                          }}
                        />
                        <span className="num-unit">px</span>
                      </div>
                    </div>
                    <input
                      id="slide-gap-slider"
                      type="range"
                      className="range-slider"
                      min={0}
                      max={120}
                      step={1}
                      value={Math.min(120, activeSlide.gap)}
                      onChange={(e) => {
                        const newGap = Number(e.target.value);
                        setSlides((prev) =>
                          prev.map((s, idx) => {
                            if (idx !== activeSlideIndex) return s;
                            return {
                              ...s,
                              gap: newGap,
                              layers: s.layers.map((l) => {
                                if (!l.pinZone) return l;
                                const rect = getPinZoneRect(
                                  l.pinZone,
                                  slideWidth,
                                  slideHeight,
                                  s.padding,
                                  newGap
                                );
                                const asset = assetsById.get(l.assetId);
                                return {
                                  ...l,
                                  ...rect,
                                  crop: adjustCropPreservingCenter(
                                    l.crop,
                                    asset?.aspectRatio || 1,
                                    rect.width / Math.max(1, rect.height)
                                  ),
                                };
                              }),
                            };
                          })
                        );
                      }}
                    />
                  </div>

                  {/* P-3: Slide Background Color, Auto-Extracted Palette & Blur Fill */}
                  <div className="inspector-section">
                    <div className="section-heading">
                      <span>Slide Backdrop</span>
                    </div>

                    <div className="control-row">
                      <span className="control-label">Backdrop Mode</span>
                      <div className="segmented-control">
                        <button
                          className={`seg-btn ${
                            activeSlide.background.type === 'solid'
                              ? 'active'
                              : ''
                          }`}
                          onClick={() =>
                            setSlides((prev) =>
                              prev.map((s, idx) =>
                                idx === activeSlideIndex
                                  ? {
                                      ...s,
                                      background: {
                                        ...s.background,
                                        type: 'solid',
                                      },
                                    }
                                  : s
                              )
                            )
                          }
                        >
                          Solid / Palette
                        </button>
                        <button
                          className={`seg-btn ${
                            activeSlide.background.type === 'blur'
                              ? 'active'
                              : ''
                          }`}
                          onClick={() =>
                            setSlides((prev) =>
                              prev.map((s, idx) =>
                                idx === activeSlideIndex
                                  ? {
                                      ...s,
                                      background: {
                                        ...s.background,
                                        type: 'blur',
                                      },
                                    }
                                  : s
                              )
                            )
                          }
                        >
                          Blurred Photo
                        </button>
                      </div>
                    </div>

                    {activeSlide.background.type === 'solid' ? (
                      <>
                        <div className="swatch-row">
                          {EDITORIAL_SWATCHES.map((hex) => (
                            <button
                              key={hex}
                              className={`color-swatch ${
                                activeSlide.background.color === hex
                                  ? 'active'
                                  : ''
                              }`}
                              style={{ backgroundColor: hex }}
                              onClick={() =>
                                setSlides((prev) =>
                                  prev.map((s, idx) =>
                                    idx === activeSlideIndex
                                      ? {
                                          ...s,
                                          background: {
                                            ...s.background,
                                            color: hex,
                                          },
                                        }
                                      : s
                                  )
                                )
                              }
                              title={`Studio Swatch ${hex}`}
                            />
                          ))}
                          <input
                            type="color"
                            value={activeSlide.background.color}
                            onChange={(e) => {
                              const hex = e.target.value;
                              setSlides((prev) =>
                                prev.map((s, idx) =>
                                  idx === activeSlideIndex
                                    ? {
                                        ...s,
                                        background: {
                                          ...s.background,
                                          color: hex,
                                        },
                                      }
                                    : s
                                )
                              );
                            }}
                            style={{
                              width: 24,
                              height: 24,
                              border: 'none',
                              background: 'transparent',
                              cursor: 'pointer',
                            }}
                            title="Custom Background Color"
                          />
                        </div>

                        {/* Auto-Extracted Dominant Colors from Slide Media */}
                        {activeSlide.layers.length > 0 && (
                          <div style={{ marginTop: 10 }}>
                            <div className="control-label">
                              Auto-Extracted Photo Palette
                            </div>
                            <div className="swatch-row">
                              {Array.from(
                                new Set(
                                  activeSlide.layers.flatMap(
                                    (l) =>
                                      assetsById.get(l.assetId)
                                        ?.dominantColors || []
                                  )
                                )
                              )
                                .slice(0, 7)
                                .map((hex) => (
                                  <button
                                    key={hex}
                                    className={`color-swatch ${
                                      activeSlide.background.color === hex
                                        ? 'active'
                                        : ''
                                    }`}
                                    style={{ backgroundColor: hex }}
                                    onClick={() =>
                                      setSlides((prev) =>
                                        prev.map((s, idx) =>
                                          idx === activeSlideIndex
                                            ? {
                                                ...s,
                                                background: {
                                                  ...s.background,
                                                  color: hex,
                                                },
                                              }
                                            : s
                                        )
                                      )
                                    }
                                    title={`Sampled Dominant Color ${hex}`}
                                  />
                                ))}
                            </div>
                          </div>
                        )}
                      </>
                    ) : (
                      <div style={{ marginTop: 8 }}>
                        <div className="control-row">
                          <span className="control-label">Blur Intensity</span>
                          <span className="control-value">
                            {activeSlide.background.blurIntensity}px
                          </span>
                        </div>
                        <input
                          type="range"
                          className="range-slider"
                          min={10}
                          max={80}
                          value={activeSlide.background.blurIntensity}
                          onChange={(e) => {
                            const val = Number(e.target.value);
                            setSlides((prev) =>
                              prev.map((s, idx) =>
                                idx === activeSlideIndex
                                  ? {
                                      ...s,
                                      background: {
                                        ...s.background,
                                        blurIntensity: val,
                                      },
                                    }
                                  : s
                              )
                            );
                          }}
                        />
                      </div>
                    )}
                  </div>
                </>
              )
            )}
          </div>
        </aside>
      </main>

      {/* MODAL 1: Panorama Multi-Slide Splitter (FR-7) */}
      {splitModalAsset && (
        <div className="modal-backdrop" onClick={() => setSplitModalAsset(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">
                ✂ Split Panorama Photo Across Consecutive Slides
              </h2>
              <button
                className="btn btn-sm"
                onClick={() => setSplitModalAsset(null)}
              >
                ✕ Close
              </button>
            </div>
            <div className="modal-body">
              <div className="control-row" style={{ marginBottom: 14 }}>
                <div>
                  <div style={{ fontWeight: 600 }}>
                    Number of Consecutive {currentSpec.shortLabel} Slides
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    Combined aspect ratio:{' '}
                    {(
                      (splitSlideCount * slideWidth) /
                      Math.max(1, slideHeight)
                    ).toFixed(2)}
                    :1 ({splitSlideCount * slideWidth}×{slideHeight}px total)
                  </div>
                </div>
                <div className="segmented-control">
                  {[2, 3, 4, 5, 6].map((n) => (
                    <button
                      key={n}
                      id={`split-count-btn-${n}`}
                      className={`seg-btn ${
                        splitSlideCount === n ? 'active-amber' : ''
                      }`}
                      onClick={() => {
                        setSplitSlideCount(n);
                        setSplitUnifiedCrop(
                          computePanoramaSpanCrop(
                            splitModalAsset,
                            n,
                            slideWidth / slideHeight
                          )
                        );
                      }}
                    >
                      {n} Slides
                    </button>
                  ))}
                </div>
              </div>

              <div
                style={{
                  display: 'flex',
                  justifyContent: 'center',
                  background: '#050507',
                  padding: 12,
                  borderRadius: 8,
                  border: '1px solid var(--border-subtle)',
                }}
              >
                <canvas
                  ref={splitPreviewCanvasRef}
                  style={{
                    maxWidth: '100%',
                    cursor: 'move',
                    borderRadius: 4,
                  }}
                  onPointerDown={(e) => {
                    splitDragRef.current = {
                      startX: e.clientX,
                      startY: e.clientY,
                      initialCrop: { ...splitUnifiedCrop },
                    };
                    e.currentTarget.setPointerCapture(e.pointerId);
                  }}
                  onPointerMove={(e) => {
                    if (!splitDragRef.current || !splitPreviewCanvasRef.current)
                      return;
                    const rect =
                      splitPreviewCanvasRef.current.getBoundingClientRect();
                    const dx =
                      (e.clientX - splitDragRef.current.startX) /
                      Math.max(1, rect.width);
                    const dy =
                      (e.clientY - splitDragRef.current.startY) /
                      Math.max(1, rect.height);
                    const init = splitDragRef.current.initialCrop;
                    setSplitUnifiedCrop({
                      ...init,
                      x: Math.max(0, Math.min(1 - init.width, init.x + dx)),
                      y: Math.max(0, Math.min(1 - init.height, init.y + dy)),
                    });
                  }}
                  onPointerUp={() => {
                    splitDragRef.current = null;
                  }}
                />
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: 'var(--text-secondary)',
                  textAlign: 'center',
                  marginTop: 8,
                }}
              >
                Drag the highlighted panorama frame to adjust positioning across
                the dashed slide cut lines.
              </div>
            </div>
            <div className="modal-footer">
              <button
                className="btn"
                onClick={() =>
                  setSplitUnifiedCrop(
                    computePanoramaSpanCrop(
                      splitModalAsset,
                      splitSlideCount,
                      slideWidth / slideHeight
                    )
                  )
                }
              >
                ✨ Auto Smart-Crop Span
              </button>
              <button
                id="confirm-split-slides-btn"
                className="btn btn-primary"
                onClick={handleConfirmSplitSlides}
              >
                Create {splitSlideCount} Seamless Slides
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL 2: Interactive Instagram Mobile Swipe Simulator (P-2) */}
      {showSwipeSimulator && (
        <div
          className="modal-backdrop"
          onClick={() => setShowSwipeSimulator(false)}
        >
          <div
            className="modal-card"
            style={{ maxWidth: 460 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h2 className="modal-title">📱 Instagram Feed Swipe Preview</h2>
              <button
                className="btn btn-sm"
                onClick={() => setShowSwipeSimulator(false)}
              >
                ✕ Close
              </button>
            </div>
            <div className="modal-body">
              <div className="ig-phone-frame">
                <div className="ig-post-header">
                  <div className="ig-avatar-row">
                    <div className="ig-avatar" />
                    <div>
                      <div className="ig-username">carouselflow.studio</div>
                      <div style={{ fontSize: 10, color: '#a1a1aa' }}>
                        {currentSpec.label} Carousel
                      </div>
                    </div>
                  </div>
                  <span style={{ color: '#a1a1aa' }}>•••</span>
                </div>

                <div
                  className="ig-viewport"
                  style={{
                    height: Math.round(380 * (slideHeight / slideWidth)),
                  }}
                >
                  <div
                    className="ig-strip-track"
                    style={{
                      width: 380 * slides.length,
                      transform: `translateX(${-simSlideIndex * 380}px)`,
                    }}
                  >
                    {slides.map((s, idx) => (
                      <div key={s.id} style={{ width: 380, flexShrink: 0 }}>
                        <SlideThumbnailCanvas
                          slides={slides}
                          slideIndex={idx}
                          slideWidth={slideWidth}
                          slideHeight={slideHeight}
                          assetsById={assetsById}
                          width={380}
                          height={Math.round(380 * (slideHeight / slideWidth))}
                        />
                      </div>
                    ))}
                  </div>

                  <div className="ig-counter-pill">
                    {simSlideIndex + 1}/{slides.length}
                  </div>
                </div>

                <div className="ig-footer">
                  <div className="ig-dots">
                    {slides.map((s, idx) => (
                      <div
                        key={s.id}
                        className={`ig-dot ${
                          idx === simSlideIndex ? 'active' : ''
                        }`}
                        onClick={() => setSimSlideIndex(idx)}
                        style={{ cursor: 'pointer' }}
                      />
                    ))}
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      marginTop: 6,
                    }}
                  >
                    <button
                      id="sim-prev-slide-btn"
                      className="btn btn-sm"
                      disabled={simSlideIndex <= 0}
                      onClick={() => setSimSlideIndex((i) => Math.max(0, i - 1))}
                    >
                      ◀ Swipe Prev
                    </button>
                    <button
                      id="sim-next-slide-btn"
                      className="btn btn-sm"
                      disabled={simSlideIndex >= slides.length - 1}
                      onClick={() =>
                        setSimSlideIndex((i) =>
                          Math.min(slides.length - 1, i + 1)
                        )
                      }
                    >
                      Swipe Next ▶
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* MODAL 3: Export & Instagram Quality Optimization (FR-8, FR-9) */}
      {showExportModal && (
        <div
          className="modal-backdrop"
          onClick={() => !isExporting && setShowExportModal(false)}
        >
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">
                ⬇ Export Carousel Slides ({currentSpec.width}×
                {currentSpec.height}px)
              </h2>
              <button
                className="btn btn-sm"
                disabled={isExporting}
                onClick={() => setShowExportModal(false)}
              >
                ✕ Close
              </button>
            </div>

            <div className="modal-body">
              <div
                style={{
                  background: 'var(--bg-elevated)',
                  padding: 14,
                  borderRadius: 8,
                  border: '1px solid var(--border-subtle)',
                  marginBottom: 14,
                }}
              >
                <div className="control-row">
                  <div>
                    <div style={{ fontWeight: 600 }}>
                      Instagram Highest-Resolution Optimization &amp; 2×
                      Supersampled Downscaling
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      Renders at 1440px width ({currentSpec.width}×
                      {currentSpec.height}px sRGB) for photos &amp; 60fps H.264
                      videos, applies subtle micro-sharpening, and keeps JPEGs
                      within 8 MB for Instagram&apos;s &ldquo;Upload at highest
                      quality&rdquo; setting.
                    </div>
                  </div>
                  <input
                    id="toggle-ig-optimization"
                    type="checkbox"
                    checked={exportSettings.optimizeForInstagram}
                    onChange={(e) =>
                      setExportSettings((s) => ({
                        ...s,
                        optimizeForInstagram: e.target.checked,
                      }))
                    }
                  />
                </div>

                <div className="control-row" style={{ marginTop: 10 }}>
                  <span className="control-label">Photo Export Format</span>
                  <div className="segmented-control">
                    <button
                      className={`seg-btn ${
                        exportSettings.imageFormat === 'jpeg' ? 'active' : ''
                      }`}
                      onClick={() =>
                        setExportSettings((s) => ({
                          ...s,
                          imageFormat: 'jpeg',
                        }))
                      }
                    >
                      JPEG (Recommended)
                    </button>
                    <button
                      className={`seg-btn ${
                        exportSettings.imageFormat === 'png' ? 'active' : ''
                      }`}
                      onClick={() =>
                        setExportSettings((s) => ({ ...s, imageFormat: 'png' }))
                      }
                    >
                      Lossless PNG
                    </button>
                  </div>
                </div>

                {exportSettings.imageFormat === 'jpeg' && (
                  <div className="control-row">
                    <span className="control-label">
                      Target JPEG Quality ({Math.round(exportSettings.jpegQuality * 100)}%)
                    </span>
                    <input
                      type="range"
                      min={0.75}
                      max={1.0}
                      step={0.01}
                      value={exportSettings.jpegQuality}
                      onChange={(e) =>
                        setExportSettings((s) => ({
                          ...s,
                          jpegQuality: Number(e.target.value),
                        }))
                      }
                    />
                  </div>
                )}
              </div>

              <div className="section-heading">
                <span>Slide Content Detection (Photos → JPG · Videos → H.264 MP4)</span>
              </div>

              <div className="export-list">
                {slides.map((s, idx) => {
                  const isVid = slideContainsVideo(
                    slides,
                    idx,
                    slideWidth,
                    assetsById
                  );
                  const prog = exportProgressList.find(
                    (p) => p.slideIndex === idx
                  );
                  return (
                    <div key={s.id} className="export-item">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span style={{ fontWeight: 600 }}>Slide #{idx + 1}</span>
                        <span
                          className={`badge ${isVid ? 'badge-video' : ''}`}
                        >
                          {isVid
                            ? `VIDEO (.MP4 H.264)`
                            : `PHOTO (.${
                                exportSettings.imageFormat === 'png'
                                  ? 'PNG'
                                  : 'JPG'
                              })`}
                        </span>
                        {prog?.sizeBytes && (
                          <span className="control-value">
                            {(prog.sizeBytes / 1024).toFixed(1)} KB
                            {prog.qualityUsed && prog.type === 'photo'
                              ? ` @ Q${Math.round(prog.qualityUsed * 100)}`
                              : ''}
                          </span>
                        )}
                        {prog?.error && (
                          <span
                            style={{
                              fontSize: 11,
                              color: 'var(--accent-rose)',
                            }}
                          >
                            ⚠ {prog.error}
                          </span>
                        )}
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        {prog && (
                          <div className="progress-bar-bg">
                            <div
                              className="progress-bar-fill"
                              style={{ width: `${Math.round(prog.progress * 100)}%` }}
                            />
                          </div>
                        )}
                        {prog?.blob && prog.filename ? (
                          <button
                            className="btn btn-sm btn-sky"
                            onClick={() =>
                              triggerBlobDownload(prog.blob!, prog.filename!)
                            }
                          >
                            ⬇ Save {prog.filename}
                          </button>
                        ) : (
                          <button
                            className="btn btn-sm"
                            disabled={isExporting}
                            onClick={() => handleRunExport(idx)}
                          >
                            Export Slide #{idx + 1}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="modal-footer">
              <button
                id="export-current-slide-btn"
                className="btn"
                disabled={isExporting}
                onClick={() => handleRunExport(activeSlideIndex)}
              >
                Export Current Slide (#{activeSlideIndex + 1})
              </button>
              <button
                id="export-all-zip-btn"
                className="btn btn-primary"
                disabled={isExporting}
                onClick={() => handleRunExport()}
              >
                {isExporting
                  ? 'Rendering & Optimizing…'
                  : `⬇ Export All ${slides.length} Slides as ZIP`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Hidden 1x1px live DOM container so <video> elements keep active hardware decode surfaces */}
      <div
        id="hidden-video-pool"
        ref={hiddenVideoPoolRef}
        aria-hidden="true"
        style={{
          position: 'fixed',
          bottom: 0,
          right: 0,
          width: 1,
          height: 1,
          opacity: 0.01,
          pointerEvents: 'none',
          overflow: 'hidden',
          zIndex: -1,
        }}
      />
    </div>
  );
}

/**
 * Renders a live miniature preview canvas for a slide in the filmstrip or swipe simulator.
 */
function SlideThumbnailCanvas({
  slides,
  slideIndex,
  slideWidth,
  slideHeight,
  assetsById,
  width,
  height,
}: {
  slides: Slide[];
  slideIndex: number;
  slideWidth: number;
  slideHeight: number;
  assetsById: Map<string, MediaAsset>;
  width: number;
  height: number;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const scale = width / Math.max(1, slideWidth);
    renderSlideToCanvas(ctx, {
      slides,
      slideIndex,
      slideWidth,
      slideHeight,
      assetsById,
      scale,
      isExport: true,
    });
  }, [slides, slideIndex, slideWidth, slideHeight, assetsById, width, height]);

  return (
    <canvas
      ref={ref}
      style={{ width, height, display: 'block' }}
    />
  );
}
