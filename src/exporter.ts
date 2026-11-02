import {
  ExportSettings,
  ExportSlideProgress,
  MediaAsset,
  Slide,
} from './types';
import {
  drawRoundedRectPath,
  getVisibleLayersForSlide,
  renderSlideToCanvas,
} from './renderer';

declare global {
  interface Window {
    JSZip?: any;
  }
}

/**
 * Determines whether a slide contains any visible video layer.
 */
export function slideContainsVideo(
  slides: Slide[],
  slideIndex: number,
  slideWidth: number,
  assetsById: Map<string, MediaAsset>
): boolean {
  const visible = getVisibleLayersForSlide(slides, slideIndex, slideWidth);
  return visible.some((item) => {
    const asset = assetsById.get(item.layer.assetId);
    return asset?.type === 'video';
  });
}

/**
 * Applies a subtle 3x3 Unsharp Mask pass on a 2D canvas to counteract downscaling softness
 * for maximum Instagram feed crispness.
 */
function applyMicroSharpen(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  amount: number
): void {
  if (amount <= 0.01) return;
  const srcData = ctx.getImageData(0, 0, width, height);
  const dstData = ctx.createImageData(width, height);
  const src = srcData.data;
  const dst = dstData.data;
  const str = Math.min(0.45, Math.max(0, amount));

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      if (x === 0 || x === width - 1 || y === 0 || y === height - 1) {
        dst[idx] = src[idx];
        dst[idx + 1] = src[idx + 1];
        dst[idx + 2] = src[idx + 2];
        dst[idx + 3] = src[idx + 3];
        continue;
      }

      const up = ((y - 1) * width + x) * 4;
      const dn = ((y + 1) * width + x) * 4;
      const lf = (y * width + (x - 1)) * 4;
      const rt = (y * width + (x + 1)) * 4;

      for (let c = 0; c < 3; c++) {
        const center = src[idx + c];
        const neighbors =
          (src[up + c] + src[dn + c] + src[lf + c] + src[rt + c]) * 0.25;
        const val = center + (center - neighbors) * (str * 2.2);
        dst[idx + c] = val < 0 ? 0 : val > 255 ? 255 : val;
      }
      dst[idx + 3] = src[idx + 3];
    }
  }
  ctx.putImageData(dstData, 0, 0);
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  mimeType: string,
  quality?: number
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Canvas toBlob failed'));
      },
      mimeType,
      quality
    );
  });
}

/**
 * Renders and compresses a static photo slide with supersampled downscaling,
 * micro-sharpening, and adaptive Instagram file-size ceiling control.
 */
export async function exportStaticSlide(
  slides: Slide[],
  slideIndex: number,
  slideWidth: number,
  slideHeight: number,
  assetsById: Map<string, MediaAsset>,
  settings: ExportSettings
): Promise<{
  blob: Blob;
  width: number;
  height: number;
  qualityUsed: number;
  ext: string;
}> {
  // Supersample at 2x first for high-acuity anti-aliased step-down resampling
  const superScale = settings.optimizeForInstagram ? 2 : 1;
  const hiCanvas = document.createElement('canvas');
  hiCanvas.width = slideWidth * superScale;
  hiCanvas.height = slideHeight * superScale;
  const hiCtx = hiCanvas.getContext('2d');
  if (!hiCtx) throw new Error('Could not initialize 2D export context');

  hiCtx.imageSmoothingEnabled = true;
  hiCtx.imageSmoothingQuality = 'high';

  renderSlideToCanvas(hiCtx, {
    slides,
    slideIndex,
    slideWidth,
    slideHeight,
    assetsById,
    scale: superScale,
    isExport: true,
  });

  const outCanvas = document.createElement('canvas');
  outCanvas.width = slideWidth;
  outCanvas.height = slideHeight;
  const outCtx = outCanvas.getContext('2d');
  if (!outCtx) throw new Error('Could not initialize output canvas context');

  outCtx.imageSmoothingEnabled = true;
  outCtx.imageSmoothingQuality = 'high';
  outCtx.drawImage(hiCanvas, 0, 0, slideWidth, slideHeight);

  if (settings.optimizeForInstagram && settings.applySharpening) {
    applyMicroSharpen(outCtx, slideWidth, slideHeight, settings.sharpenAmount);
  }

  if (settings.imageFormat === 'png') {
    const blob = await canvasToBlob(outCanvas, 'image/png');
    return {
      blob,
      width: slideWidth,
      height: slideHeight,
      qualityUsed: 1,
      ext: 'png',
    };
  }

  // Adaptive JPEG encoding to stay under Instagram's 8 MB high-res ceiling
  let quality = settings.jpegQuality;
  const maxBytes = (settings.maxFileSizeMB || 8.0) * 1024 * 1024;
  let blob = await canvasToBlob(outCanvas, 'image/jpeg', quality);

  if (settings.optimizeForInstagram) {
    while (blob.size > maxBytes && quality > 0.78) {
      quality = Math.round((quality - 0.03) * 100) / 100;
      blob = await canvasToBlob(outCanvas, 'image/jpeg', quality);
    }
  }

  return {
    blob,
    width: slideWidth,
    height: slideHeight,
    qualityUsed: quality,
    ext: 'jpg',
  };
}

function canvasToPngBase64(canvas: HTMLCanvasElement): string {
  const dataUrl = canvas.toDataURL('image/png');
  const commaIdx = dataUrl.indexOf(',');
  return commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
}

function createRoundedMaskPngBase64(
  width: number,
  height: number,
  borderRadius: number
): string {
  const w = Math.max(2, Math.round(width));
  const h = Math.max(2, Math.round(height));
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = w;
  maskCanvas.height = h;
  const mctx = maskCanvas.getContext('2d');
  if (!mctx) throw new Error('Could not initialize rounded mask canvas');

  // Black = transparent (0), White = opaque (255) for ffmpeg alphamerge
  mctx.fillStyle = '#000000';
  mctx.fillRect(0, 0, w, h);
  mctx.fillStyle = '#ffffff';
  drawRoundedRectPath(mctx, 0, 0, w, h, borderRadius);
  mctx.fill();

  return canvasToPngBase64(maskCanvas);
}

/**
 * Renders and encodes a slide containing one or more videos into an Instagram-ready .mp4.
 * Uses deterministic offline server-side `ffmpeg` compositing (`POST /api/render-video-slide`)
 * directly from cached original source video files so exported videos have zero frame drops or lag.
 */
export async function exportVideoSlide(
  slides: Slide[],
  slideIndex: number,
  slideWidth: number,
  slideHeight: number,
  assetsById: Map<string, MediaAsset>,
  onProgress: (ratio: number) => void
): Promise<{
  blob: Blob;
  width: number;
  height: number;
  ext: string;
}> {
  const visible = getVisibleLayersForSlide(slides, slideIndex, slideWidth);
  const videoItems = visible.filter(
    (item) => assetsById.get(item.layer.assetId)?.type === 'video'
  );

  // Determine total composite slide duration (longest trimmed video clip, capped at 60s)
  let totalDuration = 0.5;
  for (const item of videoItems) {
    const asset = assetsById.get(item.layer.assetId);
    const clipEnd =
      item.layer.trimEnd > item.layer.trimStart
        ? item.layer.trimEnd
        : asset?.duration || 5;
    const clipDur = Math.max(0.5, clipEnd - (item.layer.trimStart || 0));
    if (clipDur > totalDuration) {
      totalDuration = clipDur;
    }
  }
  totalDuration = Math.min(60, Math.max(1, totalDuration));

  // Primary path: deterministic offline ffmpeg compositing from original cached source files
  const canUseOfflineFfmpeg =
    videoItems.length > 0 &&
    videoItems.every((item) =>
      Boolean(assetsById.get(item.layer.assetId)?.serverVideoId)
    );

  if (canUseOfflineFfmpeg) {
    onProgress(0.08);
    const firstVideoZ = Math.min(...videoItems.map((v) => v.layer.zIndex));

    // 1. Render static underlay PNG (background + all drop shadows + static photos below video layers)
    const underlayCanvas = document.createElement('canvas');
    underlayCanvas.width = slideWidth;
    underlayCanvas.height = slideHeight;
    const underlayCtx = underlayCanvas.getContext('2d');
    if (!underlayCtx) {
      throw new Error('Could not initialize underlay export canvas');
    }
    underlayCtx.imageSmoothingEnabled = true;
    underlayCtx.imageSmoothingQuality = 'high';

    renderSlideToCanvas(underlayCtx, {
      slides,
      slideIndex,
      slideWidth,
      slideHeight,
      assetsById,
      scale: 1,
      isExport: true,
      skipBackground: false,
      layerFilter: (layer, asset) =>
        asset.type !== 'video' && layer.zIndex <= firstVideoZ,
      renderShadowForFilteredOutLayers: true,
    });
    const underlayPngBase64 = canvasToPngBase64(underlayCanvas);

    // 2. Render optional foreground static overlay PNG (static photos stacked above video layers)
    const hasForegroundPhotos = visible.some((item) => {
      const a = assetsById.get(item.layer.assetId);
      return a && a.type !== 'video' && item.layer.zIndex > firstVideoZ;
    });

    let overlayPngBase64: string | null = null;
    if (hasForegroundPhotos) {
      const overlayCanvas = document.createElement('canvas');
      overlayCanvas.width = slideWidth;
      overlayCanvas.height = slideHeight;
      const overlayCtx = overlayCanvas.getContext('2d');
      if (overlayCtx) {
        overlayCtx.imageSmoothingEnabled = true;
        overlayCtx.imageSmoothingQuality = 'high';
        renderSlideToCanvas(overlayCtx, {
          slides,
          slideIndex,
          slideWidth,
          slideHeight,
          assetsById,
          scale: 1,
          isExport: true,
          skipBackground: true,
          layerFilter: (layer, asset) =>
            asset.type !== 'video' && layer.zIndex > firstVideoZ,
          renderShadowForFilteredOutLayers: false,
        });
        overlayPngBase64 = canvasToPngBase64(overlayCanvas);
      }
    }

    // 3. Build per-video-layer placement, crop, trim, and rounded-corner mask recipe
    const videoLayersPayload = videoItems.map((item) => {
      const asset = assetsById.get(item.layer.assetId)!;
      const dx = Math.round(item.localX);
      const dy = Math.round(item.layer.y);
      const dw = Math.max(2, Math.round(item.layer.width));
      const dh = Math.max(2, Math.round(item.layer.height));
      const radius = Math.round(item.layer.borderRadius || 0);
      const maskPngBase64 =
        radius > 0 ? createRoundedMaskPngBase64(dw, dh, radius) : null;

      const trimStart = Math.max(0, item.layer.trimStart || 0);
      const trimEnd =
        item.layer.trimEnd > trimStart
          ? item.layer.trimEnd
          : asset.duration || totalDuration;

      return {
        serverVideoId: asset.serverVideoId!,
        dx,
        dy,
        dw,
        dh,
        crop: item.layer.crop,
        trimStart,
        trimEnd,
        muted: Boolean(item.layer.muted),
        endBehavior: item.layer.endBehavior || 'loop',
        maskPngBase64,
      };
    });

    onProgress(0.2);
    let simulatedProgress = 0.2;
    const progressTimer = window.setInterval(() => {
      simulatedProgress = Math.min(0.92, simulatedProgress + 0.04);
      onProgress(simulatedProgress);
    }, 250);

    try {
      const resp = await fetch('/api/render-video-slide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slideWidth,
          slideHeight,
          totalDuration,
          underlayPngBase64,
          overlayPngBase64,
          videoLayers: videoLayersPayload,
        }),
      });
      window.clearInterval(progressTimer);

      if (!resp.ok) {
        const errJson = await resp.json().catch(() => ({}));
        throw new Error(
          errJson.details ||
            errJson.error ||
            `Offline ffmpeg video slide render failed (HTTP ${resp.status})`
        );
      }

      const mp4Blob = await resp.blob();
      onProgress(1);
      return {
        blob: mp4Blob,
        width: slideWidth,
        height: slideHeight,
        ext: 'mp4',
      };
    } catch (err) {
      window.clearInterval(progressTimer);
      throw err;
    }
  }

  // Create isolated video clones so export playback doesn't conflict with editor stage
  const clonedAssetsMap = new Map<string, MediaAsset>(assetsById);
  const activeVideoElements: {
    video: HTMLVideoElement;
    trimStart: number;
    trimEnd: number;
    endBehavior: 'loop' | 'freeze';
    muted: boolean;
  }[] = [];

  for (const item of videoItems) {
    const origAsset = assetsById.get(item.layer.assetId);
    if (!origAsset) continue;

    const vid = document.createElement('video');
    vid.src = origAsset.url;
    vid.crossOrigin = 'anonymous';
    vid.playsInline = true;
    vid.muted = item.layer.muted;
    vid.preload = 'auto';

    await new Promise<void>((resolve) => {
      const done = () => resolve();
      vid.addEventListener('loadeddata', done, { once: true });
      vid.addEventListener('error', done, { once: true });
      vid.load();
    });

    const trimStart = Math.max(0, item.layer.trimStart || 0);
    const trimEnd =
      item.layer.trimEnd > trimStart
        ? item.layer.trimEnd
        : origAsset.duration || 5;
    vid.currentTime = trimStart;

    activeVideoElements.push({
      video: vid,
      trimStart,
      trimEnd,
      endBehavior: item.layer.endBehavior || 'loop',
      muted: item.layer.muted,
    });

    clonedAssetsMap.set(origAsset.id, {
      ...origAsset,
      element: vid,
    });
  }

  const canvas = document.createElement('canvas');
  canvas.width = slideWidth;
  canvas.height = slideHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not initialize video export canvas');

  const stream = canvas.captureStream(60);

  // Mix unmuted audio tracks via Web Audio API if available
  let audioCtx: AudioContext | null = null;
  try {
    const unmuted = activeVideoElements.filter((v) => !v.muted);
    if (unmuted.length > 0) {
      audioCtx = new AudioContext();
      const dest = audioCtx.createMediaStreamDestination();
      for (const v of unmuted) {
        try {
          const sourceNode = audioCtx.createMediaElementSource(v.video);
          sourceNode.connect(dest);
        } catch {
          // Video may have no audio track or synthetic stream
        }
      }
      for (const track of dest.stream.getAudioTracks()) {
        stream.addTrack(track);
      }
    }
  } catch {
    // Proceed with video-only stream if AudioContext blocked
  }

  const mimeCandidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4',
  ];
  const supportedMime =
    mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';

  const recorder = new MediaRecorder(stream, {
    ...(supportedMime ? { mimeType: supportedMime } : {}),
    videoBitsPerSecond: 16_000_000,
  });

  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  const recordingDone = new Promise<Blob>((resolve) => {
    recorder.onstop = () => {
      resolve(new Blob(chunks, { type: supportedMime || 'video/webm' }));
    };
  });

  // Start playback of all video layers
  for (const v of activeVideoElements) {
    v.video.currentTime = v.trimStart;
    try {
      await v.video.play();
    } catch {
      v.video.muted = true;
      await v.video.play().catch(() => {});
    }
  }

  recorder.start(100);
  const startTime = performance.now();

  await new Promise<void>((resolve) => {
    const tick = () => {
      const elapsedSec = (performance.now() - startTime) / 1000;
      const ratio = Math.min(1, elapsedSec / totalDuration);
      onProgress(ratio * 0.78);

      for (const v of activeVideoElements) {
        const clipLen = Math.max(0.2, v.trimEnd - v.trimStart);
        if (v.video.currentTime >= v.trimEnd) {
          if (v.endBehavior === 'loop') {
            v.video.currentTime = v.trimStart + (elapsedSec % clipLen);
            if (v.video.paused) v.video.play().catch(() => {});
          } else {
            v.video.pause();
            v.video.currentTime = v.trimEnd;
          }
        }
      }

      renderSlideToCanvas(ctx, {
        slides,
        slideIndex,
        slideWidth,
        slideHeight,
        assetsById: clonedAssetsMap,
        scale: 1,
        isExport: true,
      });

      if (elapsedSec >= totalDuration) {
        resolve();
      } else {
        requestAnimationFrame(tick);
      }
    };
    requestAnimationFrame(tick);
  });

  for (const v of activeVideoElements) {
    v.video.pause();
    v.video.src = '';
  }
  if (audioCtx) {
    audioCtx.close().catch(() => {});
  }

  recorder.stop();
  const rawBlob = await recordingDone;
  onProgress(0.85);

  // Transcode via local server /api/transcode-mp4 (native ffmpeg libx264 + aac) for strict Instagram MP4 compliance
  try {
    const resp = await fetch('/api/transcode-mp4', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: await rawBlob.arrayBuffer(),
    });
    if (resp.ok) {
      const mp4Blob = await resp.blob();
      onProgress(1);
      return {
        blob: mp4Blob,
        width: slideWidth,
        height: slideHeight,
        ext: 'mp4',
      };
    }
  } catch {
    // Fallback to client blob if server endpoint unavailable
  }

  onProgress(1);
  return {
    blob: rawBlob,
    width: slideWidth,
    height: slideHeight,
    ext: supportedMime.includes('mp4') ? 'mp4' : 'webm',
  };
}

/**
 * Triggers a browser file download for a Blob.
 */
export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/**
 * Bundles multiple exported slide blobs into a single numbered .zip file using JSZip.
 */
export async function bundleExportsIntoZip(
  items: ExportSlideProgress[],
  zipFilename = 'instagram-carousel.zip'
): Promise<void> {
  if (!window.JSZip) {
    // Fallback: download individually if JSZip not loaded
    for (const item of items) {
      if (item.blob && item.filename) {
        triggerBlobDownload(item.blob, item.filename);
      }
    }
    return;
  }

  const zip = new window.JSZip();
  for (const item of items) {
    if (item.blob && item.filename) {
      zip.file(item.filename, item.blob);
    }
  }

  const zipBlob = await zip.generateAsync({ type: 'blob' });
  triggerBlobDownload(zipBlob, zipFilename);
}
