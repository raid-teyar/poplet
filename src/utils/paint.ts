import getStroke from "perfect-freehand";
import rough from "roughjs";
import type { RoughCanvas } from "roughjs/bin/canvas";
import type { Options } from "roughjs/bin/core";
import type { Stroke } from "../types";

/// Handwriting stack for sketch-mode text. Ends in `cursive` so a hand-drawn
/// look shows even if none of the named fonts are installed.
const SKETCH_FONT = `"Comic Sans MS", "Segoe Print", "Bradley Hand", "Comic Neue", cursive`;

/// Deterministic seed from a stroke's coordinates so roughjs produces the same
/// wobble on every redraw (no flicker) while differing per shape.
/// Decoded images for `image` strokes, keyed by their data URL. Shared by the
/// live canvas and the export renderer so a picture is decoded once.
const imageCache = new Map<string, HTMLImageElement>();

/// Ensure an image data URL is decoded and cached. Calls `onReady` once it can
/// be drawn (immediately if already decoded), so the engine can redraw.
export function preloadImage(src: string, onReady: () => void): void {
  const existing = imageCache.get(src);
  if (existing) {
    if (existing.complete && existing.naturalWidth > 0) onReady();
    return;
  }
  const img = new Image();
  img.onload = onReady;
  img.src = src;
  imageCache.set(src, img);
}

function sketchSeed(nums: number[]): number {
  let s = 0;
  for (const n of nums) s = (s + Math.round(n)) % 2147483647;
  return s + 1;
}

function roughOpts(stroke: Stroke, seedNums: number[]): Options {
  return {
    stroke: stroke.color,
    strokeWidth: stroke.width,
    roughness: 1.25,
    bowing: 1.15,
    // More passes + larger max offset read as hand-drawn (Excalidraw's look).
    maxRandomnessOffset: 3,
    disableMultiStroke: false,
    seed: sketchSeed(seedNums),
  };
}

/// Build an SVG path from a perfect-freehand outline (a closed polygon traced
/// with quadratic curves through the midpoints) for the smooth ink look.
function outlineToPath(points: number[][]): string {
  if (points.length < 2) return "";
  const d = points.reduce(
    (acc, [x0, y0], i, arr) => {
      const [x1, y1] = arr[(i + 1) % arr.length];
      acc.push(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
      return acc;
    },
    ["M", points[0][0], points[0][1], "Q"] as (string | number)[],
  );
  d.push("Z");
  return d.join(" ");
}

function paintFreehandSmooth(ctx: CanvasRenderingContext2D, stroke: Stroke) {
  if (stroke.tool !== "pencil") return;
  const outline = getStroke(
    stroke.points.map((p) => [p.x, p.y]),
    {
      size: Math.max(stroke.width * 2.4, 3),
      thinning: 0.5,
      smoothing: 0.7,
      streamline: 0.6,
    },
  );
  const path = outlineToPath(outline as number[][]);
  if (!path) return;
  ctx.fillStyle = stroke.color;
  ctx.fill(new Path2D(path));
}

function paintArrowHead(
  ctx: CanvasRenderingContext2D,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  width: number,
) {
  const angle = Math.atan2(toY - fromY, toX - fromX);
  const head = Math.max(width * 5, 12);
  const spread = Math.PI / 7;
  ctx.beginPath();
  ctx.moveTo(toX, toY);
  ctx.lineTo(
    toX - head * Math.cos(angle - spread),
    toY - head * Math.sin(angle - spread),
  );
  ctx.moveTo(toX, toY);
  ctx.lineTo(
    toX - head * Math.cos(angle + spread),
    toY - head * Math.sin(angle + spread),
  );
  ctx.stroke();
}

/// Render a single stroke. `smoothing` only affects freehand pencil strokes
/// (recognized shapes are stored as their own primitive and always render
/// crisp).
export function paintStroke(
  ctx: CanvasRenderingContext2D,
  stroke: Stroke,
  smoothing: boolean,
  sketch = false,
  rc: RoughCanvas | null = null,
) {
  ctx.save();
  ctx.globalAlpha = stroke.opacity ?? 1;
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = stroke.width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (stroke.tool === "eraser") {
    ctx.globalCompositeOperation = "destination-out";
  }

  switch (stroke.tool) {
    case "pencil": {
      if (smoothing) {
        paintFreehandSmooth(ctx, stroke);
        break;
      }
      if (stroke.points.length < 2) break;
      ctx.beginPath();
      ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
      for (let i = 1; i < stroke.points.length; i++) {
        ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
      }
      ctx.stroke();
      break;
    }
    case "eraser": {
      if (stroke.points.length < 2) break;
      ctx.beginPath();
      ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
      for (let i = 1; i < stroke.points.length; i++) {
        ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
      }
      ctx.stroke();
      break;
    }
    case "line": {
      if (sketch && rc) {
        rc.line(
          stroke.start.x,
          stroke.start.y,
          stroke.end.x,
          stroke.end.y,
          roughOpts(stroke, [
            stroke.start.x,
            stroke.start.y,
            stroke.end.x,
            stroke.end.y,
          ]),
        );
        break;
      }
      ctx.beginPath();
      ctx.moveTo(stroke.start.x, stroke.start.y);
      ctx.lineTo(stroke.end.x, stroke.end.y);
      ctx.stroke();
      break;
    }
    case "arrow": {
      if (sketch && rc) {
        const o = roughOpts(stroke, [
          stroke.start.x,
          stroke.start.y,
          stroke.end.x,
          stroke.end.y,
        ]);
        rc.line(stroke.start.x, stroke.start.y, stroke.end.x, stroke.end.y, o);
        const angle = Math.atan2(
          stroke.end.y - stroke.start.y,
          stroke.end.x - stroke.start.x,
        );
        const head = Math.max(stroke.width * 5, 12);
        const spread = Math.PI / 7;
        rc.line(
          stroke.end.x,
          stroke.end.y,
          stroke.end.x - head * Math.cos(angle - spread),
          stroke.end.y - head * Math.sin(angle - spread),
          o,
        );
        rc.line(
          stroke.end.x,
          stroke.end.y,
          stroke.end.x - head * Math.cos(angle + spread),
          stroke.end.y - head * Math.sin(angle + spread),
          o,
        );
        break;
      }
      ctx.beginPath();
      ctx.moveTo(stroke.start.x, stroke.start.y);
      ctx.lineTo(stroke.end.x, stroke.end.y);
      ctx.stroke();
      paintArrowHead(
        ctx,
        stroke.start.x,
        stroke.start.y,
        stroke.end.x,
        stroke.end.y,
        stroke.width,
      );
      break;
    }
    case "rect": {
      const x = Math.min(stroke.start.x, stroke.end.x);
      const y = Math.min(stroke.start.y, stroke.end.y);
      const w = Math.abs(stroke.end.x - stroke.start.x);
      const h = Math.abs(stroke.end.y - stroke.start.y);
      if (sketch && rc) {
        rc.rectangle(x, y, w, h, roughOpts(stroke, [x, y, w, h]));
        break;
      }
      ctx.strokeRect(x, y, w, h);
      break;
    }
    case "diamond": {
      const x = Math.min(stroke.start.x, stroke.end.x);
      const y = Math.min(stroke.start.y, stroke.end.y);
      const w = Math.abs(stroke.end.x - stroke.start.x);
      const h = Math.abs(stroke.end.y - stroke.start.y);
      const cx = x + w / 2;
      const cy = y + h / 2;
      if (sketch && rc) {
        rc.polygon(
          [
            [cx, y],
            [x + w, cy],
            [cx, y + h],
            [x, cy],
          ],
          roughOpts(stroke, [x, y, w, h]),
        );
        break;
      }
      ctx.beginPath();
      ctx.moveTo(cx, y); // top
      ctx.lineTo(x + w, cy); // right
      ctx.lineTo(cx, y + h); // bottom
      ctx.lineTo(x, cy); // left
      ctx.closePath();
      ctx.stroke();
      break;
    }
    case "triangle": {
      if (sketch && rc) {
        rc.polygon(
          [
            [stroke.a.x, stroke.a.y],
            [stroke.b.x, stroke.b.y],
            [stroke.c.x, stroke.c.y],
          ],
          roughOpts(stroke, [stroke.a.x, stroke.a.y, stroke.b.x, stroke.c.y]),
        );
        break;
      }
      ctx.beginPath();
      ctx.moveTo(stroke.a.x, stroke.a.y);
      ctx.lineTo(stroke.b.x, stroke.b.y);
      ctx.lineTo(stroke.c.x, stroke.c.y);
      ctx.closePath();
      ctx.stroke();
      break;
    }
    case "circle": {
      if (sketch && rc) {
        rc.ellipse(
          stroke.center.x,
          stroke.center.y,
          Math.abs(stroke.radiusX) * 2,
          Math.abs(stroke.radiusY) * 2,
          roughOpts(stroke, [
            stroke.center.x,
            stroke.center.y,
            stroke.radiusX,
            stroke.radiusY,
          ]),
        );
        break;
      }
      ctx.beginPath();
      ctx.ellipse(
        stroke.center.x,
        stroke.center.y,
        Math.abs(stroke.radiusX),
        Math.abs(stroke.radiusY),
        0,
        0,
        Math.PI * 2,
      );
      ctx.stroke();
      break;
    }
    case "text": {
      ctx.fillStyle = stroke.color;
      ctx.textBaseline = "top";
      ctx.font = sketch
        ? `${stroke.fontSize}px ${SKETCH_FONT}`
        : `${stroke.fontSize}px -apple-system, "Segoe UI", Roboto, sans-serif`;
      const lineHeight = stroke.fontSize * 1.25;
      stroke.text.split("\n").forEach((line, i) => {
        ctx.fillText(line, stroke.x, stroke.y + i * lineHeight);
      });
      break;
    }
    case "redact": {
      // Opaque fill so whatever is underneath is fully hidden.
      const x = Math.min(stroke.start.x, stroke.end.x);
      const y = Math.min(stroke.start.y, stroke.end.y);
      const w = Math.abs(stroke.end.x - stroke.start.x);
      const h = Math.abs(stroke.end.y - stroke.start.y);
      ctx.globalAlpha = 1;
      ctx.fillStyle = stroke.color;
      ctx.fillRect(x, y, w, h);
      break;
    }
    case "image": {
      const x = Math.min(stroke.start.x, stroke.end.x);
      const y = Math.min(stroke.start.y, stroke.end.y);
      const w = Math.abs(stroke.end.x - stroke.start.x);
      const h = Math.abs(stroke.end.y - stroke.start.y);
      const img = imageCache.get(stroke.src);
      if (img && img.complete && img.naturalWidth > 0) {
        ctx.drawImage(img, x, y, w, h);
      }
      break;
    }
  }
  ctx.restore();
}

export function paintStrokes(
  ctx: CanvasRenderingContext2D,
  strokes: Stroke[],
  smoothing: boolean,
  sketch = false,
) {
  const rc = sketch ? rough.canvas(ctx.canvas) : null;
  for (const stroke of strokes) {
    if (stroke.hidden) continue;
    paintStroke(ctx, stroke, smoothing, sketch, rc);
  }
}
