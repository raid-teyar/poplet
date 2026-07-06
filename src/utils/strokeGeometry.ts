import type { Stroke } from "../types";

export interface Pt {
  x: number;
  y: number;
}
export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/// The points that define a stroke's extent.
function definingPoints(s: Stroke): Pt[] {
  switch (s.tool) {
    case "pencil":
    case "eraser":
      return s.points;
    case "line":
    case "arrow":
    case "rect":
    case "diamond":
    case "redact":
    case "image":
      return [s.start, s.end];
    case "triangle":
      return [s.a, s.b, s.c];
    case "circle":
      return [
        { x: s.center.x - Math.abs(s.radiusX), y: s.center.y - Math.abs(s.radiusY) },
        { x: s.center.x + Math.abs(s.radiusX), y: s.center.y + Math.abs(s.radiusY) },
      ];
    case "text": {
      const lines = s.text.split("\n");
      const longest = lines.reduce((m, l) => Math.max(m, l.length), 1);
      const w = Math.max(s.fontSize * 0.5, longest * s.fontSize * 0.55);
      const h = lines.length * s.fontSize * 1.25;
      return [
        { x: s.x, y: s.y },
        { x: s.x + w, y: s.y + h },
      ];
    }
  }
}

export function strokeBBox(s: Stroke): BBox {
  const pts = definingPoints(s);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/// Bounding box enclosing several boxes (null if empty).
export function unionBBox(boxes: BBox[]): BBox | null {
  if (boxes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of boxes) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function rectsIntersect(a: BBox, b: BBox): boolean {
  return (
    a.x <= b.x + b.w &&
    a.x + a.w >= b.x &&
    a.y <= b.y + b.h &&
    a.y + a.h >= b.y
  );
}

/// Hit-test a point against a stroke's bounding box (inflated by `tol`).
export function hitTest(s: Stroke, p: Pt, tol: number): boolean {
  const b = strokeBBox(s);
  return (
    p.x >= b.x - tol &&
    p.x <= b.x + b.w + tol &&
    p.y >= b.y - tol &&
    p.y <= b.y + b.h + tol
  );
}

/// Remap a stroke from its original bounding box to a new one, scaling and
/// translating every defining point proportionally. Handles both moving
/// (same-size box, shifted) and resizing (different-size box).
export function remapStroke(s: Stroke, ob: BBox, nb: BBox): Stroke {
  const sx = ob.w > 1e-6 ? nb.w / ob.w : 1;
  const sy = ob.h > 1e-6 ? nb.h / ob.h : 1;
  const map = (p: Pt): Pt => ({
    x: nb.x + (p.x - ob.x) * sx,
    y: nb.y + (p.y - ob.y) * sy,
  });
  switch (s.tool) {
    case "pencil":
    case "eraser":
      return { ...s, points: s.points.map(map) };
    case "line":
    case "arrow":
    case "rect":
    case "diamond":
    case "redact":
    case "image":
      return { ...s, start: map(s.start), end: map(s.end) };
    case "triangle":
      return { ...s, a: map(s.a), b: map(s.b), c: map(s.c) };
    case "circle":
      return {
        ...s,
        center: map(s.center),
        radiusX: Math.abs(s.radiusX) * sx,
        radiusY: Math.abs(s.radiusY) * sy,
      };
    case "text": {
      const p = map({ x: s.x, y: s.y });
      return { ...s, x: p.x, y: p.y, fontSize: Math.max(4, s.fontSize * sy) };
    }
  }
}

/// Deep-clone a stroke (including its nested points) so history snapshots and
/// transform baselines never share mutable references with the live strokes.
export function cloneStroke(s: Stroke): Stroke {
  switch (s.tool) {
    case "pencil":
    case "eraser":
      return { ...s, points: s.points.map((p) => ({ ...p })) };
    case "line":
    case "arrow":
    case "rect":
    case "diamond":
    case "redact":
    case "image":
      return { ...s, start: { ...s.start }, end: { ...s.end } };
    case "triangle":
      return { ...s, a: { ...s.a }, b: { ...s.b }, c: { ...s.c } };
    case "circle":
      return { ...s, center: { ...s.center } };
    case "text":
      return { ...s };
  }
}

export const cloneStrokes = (arr: Stroke[]): Stroke[] => arr.map(cloneStroke);

/// Translate a stroke by (dx, dy).
export function translateStroke(s: Stroke, dx: number, dy: number): Stroke {
  const b = strokeBBox(s);
  return remapStroke(s, b, { x: b.x + dx, y: b.y + dy, w: b.w, h: b.h });
}

export type HandleId = "nw" | "ne" | "se" | "sw";

export function bboxHandles(b: BBox): Record<HandleId, Pt> {
  return {
    nw: { x: b.x, y: b.y },
    ne: { x: b.x + b.w, y: b.y },
    se: { x: b.x + b.w, y: b.y + b.h },
    sw: { x: b.x, y: b.y + b.h },
  };
}

/// The corner that stays fixed while dragging the given handle.
export function oppositeCorner(b: BBox, handle: HandleId): Pt {
  const h = bboxHandles(b);
  return { nw: h.se, ne: h.sw, se: h.nw, sw: h.ne }[handle];
}
