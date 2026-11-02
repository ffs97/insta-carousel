# CarouselFlow Studio

**CarouselFlow Studio** is a web-based Instagram Carousel Photo & Video Editor built with React, TypeScript, HTML5 Canvas, and WebAudio/MediaRecorder. It lets you compose multi-slide Instagram carousels, split wide panoramas seamlessly across slides, combine multiple photos and videos on a single slide, preview swipe transitions, and export highest-resolution `1440px`-wide slides (`JPG`/`PNG` for photo slides and `60fps H.264 MP4` for video slides) optimized for Instagram's **"Upload at highest quality"** setting.

---

## Key Features

- **All 3 Native Instagram Aspect Ratios (Highest Resolution — `1440px` Width)**:
  - **Portrait (`4:5`)**: `1440 × 1800 px` (recommended for maximum vertical feed real estate)
  - **Square (`1:1`)**: `1440 × 1440 px`
  - **Landscape (`1.91:1`)**: `1440 × 754 px`
- **Smart Content-Aware Auto-Crop**:
  - Automatically analyzes luminance contrast, edge gradients, skin-tone warmth, and saturation to keep key subjects centered when cropping.
- **Seamless Multi-Slide Panorama Splitter**:
  - Split any wide photo across `2` to `10` consecutive slides with pixel-accurate edge alignment—either creating new slides or inserting into the current slide.
- **Multi-Photo & Video Collages**:
  - Add multiple photos and videos to a single slide.
  - Arrange layers freeform with magnetic snapping (edges, centerlines, rule-of-thirds, and sibling layers), pin to 10 snap zones (`Full Bleed`, `Center Card`, halves, and all 4 quadrants), or apply 1-click multi-photo collage templates (`2-Up`, `3-Up`, `2×2 Quad Grid`, `Editorial Frame`).
  - Bridge any layer across the seam between two adjacent slides for continuous swipe transitions.
- **Single Slide & Seamless Strip Views**:
  - Edit one slide at a time or switch to **Strip** view to see and edit all carousel slides side by side as a continuous horizontal canvas.
- **Stage Zoom & Precision Inspector**:
  - Zoom slides from `25%` to `300%` (`−` / `+` buttons, slider, writable percentage, `Fit`, or `Ctrl`/`Cmd` + mouse wheel).
  - Customize **Outer Margin (Padding)**, **Inner Collage Gap**, **Corner Radius**, and configurable **Drop Shadows** (`Blur`, `Offset X`, `Offset Y`, `Opacity`, `Color`) via sliders or direct numeric inputs.
  - Solid color, auto-extracted photo palette swatches, or blurred-photo slide backdrops.
- **Highest-Resolution Per-Slide Photo & Video Export**:
  - Static slides render with `2×` supersampling (`2880×3600` for `4:5`) downscaled to crisp `1440px`-wide sRGB `JPG` (at `96%` quality up to `8 MB` for Instagram's "Upload at highest quality" setting) or lossless `PNG`.
  - Slides containing video layers export at `1440px` width (`1440×1800` / `1440×1440` / `1440×754`) as `60 fps` `MP4` (`H.264 High Profile @ CRF 17 / 15 Mbps + 256 kbps AAC` when `ffmpeg` is installed, with automatic browser `16 Mbps MediaRecorder` fallback).
  - Download individual slides or bundle the entire numbered carousel (`slide_01`, `slide_02`, ...) into a `.zip` archive.

---

## Prerequisites & Installation

### 1. Prerequisites
- **Node.js**: `v18.0.0` or newer (includes `npm`)
- **FFmpeg** *(optional, recommended for video slides)*: Used by the local dev server to transcode composite video slides into strict Instagram-compliant `H.264` (`yuv420p`) + `AAC` `.mp4` files.
  - **macOS (Homebrew)**: `brew install ffmpeg`
  - **Ubuntu / Debian**: `sudo apt install ffmpeg`
  - **Windows (Winget)**: `winget install Gyan.FFmpeg`

### 2. Install Dependencies
Clone the repository and install the standard npm dependencies (`react`, `react-dom`, `jszip`, `typescript`):

```bash
git clone <your-repo-url>
cd insta-editor
npm install
```

### 3. Start the Application
Run the local development server:

```bash
npm run dev
```

Then open **[http://localhost:5173](http://localhost:5173)** in your browser (Chrome, Edge, Brave, or Firefox recommended).

> To use a custom port, run `PORT=3000 npm run dev`.

---

## How to Use the Tool

### 1. Choose Your Carousel Aspect Ratio
- In the top bar, select **`4:5`** (`1440×1800`), **`1:1`** (`1440×1440`), or **`1.91:1`** (`1440×754`). All slides in an Instagram carousel share this aspect ratio.

### 2. Import Photos & Videos
- Drag and drop `JPG`, `PNG`, `WebP`, `MP4`, or `MOV` files into the **Media Library** on the left sidebar (or click **+ Import Photos & Videos**).
- For each imported item in the library:
  - Click **`+ To Slide N`** to add it to the currently active slide (sized to fit its original proportions).
  - Click **`+ New Slide`** to append a new slide with that media item.
  - Click **`✂ Split Photo Across Multiple Slides`** to slice a wide or panoramic image across `2`–`10` contiguous slides.
  - Click **`🗑 Delete`** to remove the media asset from the library and all slides.

### 3. Arrange, Resize & Crop Layers on the Stage
- **Move & Snap**: Drag any layer on the canvas. Toggle **🧲 Snap** in the top bar to snap to slide edges, centerlines, rule-of-thirds, seams, or neighboring photos.
- **Resize**: Drag any of the 8 handles around the selected layer. By default, **🔒 Ratio Locked** preserves the layer's aspect ratio when resizing; click **Ratio Locked** in the floating stage dock (or hold `Shift`) to resize freeform.
- **Pan / Crop Inside Frame**:
  - Double-click a layer on the canvas (or click **⌗ Pan / Crop** in the floating dock) to pan the image inside its frame.
  - Use the **Inner Crop Zoom** slider in the **Layer** tab of the right sidebar to zoom the image inside its crop window, or pick a **Frame Aspect Preset** (`Match Slide`, `Original Ratio`, `Freeform`, `1:1`, `4:5`, `16:9`, etc.).
  - Click **✨ Auto-Crop** to center on the highest-saliency subject or **⌖ Center Crop** to reset.
- **Unselect**: Click anywhere in the empty buffer area around the slide, or click an already-selected image on the slide without dragging, to unselect it.

### 4. Multi-Photo Layouts, Pinning & Cross-Slide Seams
- **Pin Zones (`Layer` Tab)**: Snap the selected layer to `Full Bleed`, `Center Card`, `Left 1/2`, `Right 1/2`, `Top 1/2`, `Bottom 1/2`, `Top-Left`, `Top-Right`, `Btm-Left`, or `Btm-Right`.
- **Cross-Slide Seam Bridging**: Click **↔ Bridge Layer Across Next Slide Seam** (or switch to **Strip** view in the top bar and drag a photo across the dashed slide boundary) so a photo spans smoothly from Slide `N` into Slide `N+1`.
- **Multi-Photo Collage Templates (`Slide` Tab)**: Switch the right sidebar to the **Slide** tab to apply 1-click multi-photo layouts (`Editorial Frame`, `2-Up Left/Right`, `2-Up Top/Bottom`, `2-Up Offset`, `3-Up Hero`, `3-Up Columns`, `2×2 Quad Grid`).

### 5. Styling: Margins, Collage Gap, Drop Shadow & Backdrops
- **Margins & Spacing (`Slide` Tab)**: Adjust **Outer Margin (Padding)** and **Inner Collage Gap** (`0px` by default) using the matched-scale sliders or by typing exact pixel values into the numeric inputs.
- **Corner Radius & Drop Shadow (`Layer` Tab)**: Round layer corners (`px`) and toggle **Shadow On** to customize **Shadow Blur**, **Offset X**, **Offset Y**, **Opacity**, and **Shadow Color**.
- **Slide Backdrop (`Slide` Tab)**: Choose **Solid / Palette** (including colors automatically extracted from your photos) or **Blurred Photo** for an ambient glass backdrop.

### 6. Stage Guides & Swipe Preview
- **Top Bar Guides**:
  - **⊞ 1:1 Cover**: Previews how Slide #1 will be cropped into a `1:1` square on your Instagram profile grid.
  - **👁 Safe Zones**: Previews Instagram's native slide counter (`1/N`) and bottom tag icon overlays.
  - **◎ Focal**: Displays the detected smart-crop focal point on each photo.
- **📱 Swipe Preview**: Click **Swipe Preview** in the top-right to test your carousel inside an interactive Instagram mobile feed simulator with touch/trackpad drag physics.

### 7. Keyboard Shortcuts
| Shortcut | Action |
| :--- | :--- |
| `Delete` / `Backspace` | Deletes the selected layer, or deletes the active slide when no layer is selected |
| `Arrow Keys` (`↑` `↓` `←` `→`) | Nudges the selected layer by `2px` (`10px` with `Shift`) |
| `Enter` / `Escape` | Exits inner Pan/Crop mode or unselects the active layer |
| `Ctrl`/`Cmd` + `Z` | Undo |
| `Ctrl`/`Cmd` + `Shift` + `Z` (or `Ctrl` + `Y`) | Redo |
| `Ctrl`/`Cmd` + Mouse Wheel | Zoom slide stage in / out (`25%` – `300%`) |

### 8. Export Your Carousel
- Click **⬇ Export** in the top-right corner.
- Choose **JPEG (Optimal IG)** or **PNG (Lossless)** for photo slides, configure quality/sharpening, and click **Render All Slides**.
- Download individual slides (`JPG`/`PNG` or `MP4`) or click **📦 Download All as .ZIP**.
