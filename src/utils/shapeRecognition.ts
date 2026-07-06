// Heuristic recognition of freehand gestures into clean geometric primitives.
// The classifier resamples the stroke by arc length and counts sharp corners
// (curvature peaks). Corner count is the primary signal — 3 → triangle,
// 4 → rectangle, smooth/no corners → circle/ellipse — which avoids the
// edge-fraction misfires (circle→square, triangle→circle). Open strokes are
// matched against straight lines and arrows.

interface Pt {
  x: number;
  y: number;
}

export type Recognized =
  | { type: "line"; start: Pt; end: Pt }
  | { type: "arrow"; start: Pt; end: Pt }
  | { type: "rect"; start: Pt; end: Pt }
  | { type: "diamond"; start: Pt; end: Pt }
  | { type: "triangle"; a: Pt; b: Pt; c: Pt }
  | { type: "circle"; center: Pt; radiusX: number; radiusY: number };

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/// Resample a polyline to `count` points evenly spaced by arc length.
function resample(points: Pt[], count: number): Pt[] {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += dist(points[i], points[i - 1]);
  if (total === 0) return [points[0]];
  const step = total / (count - 1);
  const out: Pt[] = [points[0]];
  let acc = 0;
  let prev = points[0];
  for (let i = 1; i < points.length; i++) {
    let seg = dist(points[i], prev);
    while (acc + seg >= step && out.length < count) {
      const t = (step - acc) / seg;
      const np = { x: prev.x + (points[i].x - prev.x) * t, y: prev.y + (points[i].y - prev.y) * t };
      out.push(np);
      prev = np;
      seg = dist(points[i], prev);
      acc = 0;
    }
    acc += seg;
    prev = points[i];
  }
  while (out.length < count) out.push(points[points.length - 1]);
  return out;
}

/// Indices of sharp corners on a resampled path, via the turning angle between
/// chords `k` samples back and forward. When `cyclic` (closed shapes), indices
/// wrap so the corner sitting on the start/end seam is still found. Greedy
/// non-maximum suppression keeps the strongest corner within each neighborhood.
function findCorners(pts: Pt[], thresholdDeg: number, cyclic: boolean): number[] {
  const n = pts.length;
  const k = Math.max(2, Math.round(n / 12));
  const angles: number[] = new Array(n).fill(0);

  const lo = cyclic ? 0 : k;
  const hi = cyclic ? n : n - k;
  for (let i = lo; i < hi; i++) {
    const a = cyclic ? pts[(i - k + n) % n] : pts[i - k];
    const b = pts[i];
    const c = cyclic ? pts[(i + k) % n] : pts[i + k];
    const v1x = b.x - a.x;
    const v1y = b.y - a.y;
    const v2x = c.x - b.x;
    const v2y = c.y - b.y;
    const m1 = Math.hypot(v1x, v1y);
    const m2 = Math.hypot(v2x, v2y);
    if (m1 === 0 || m2 === 0) continue;
    let cos = (v1x * v2x + v1y * v2y) / (m1 * m2);
    cos = Math.max(-1, Math.min(1, cos));
    angles[i] = (Math.acos(cos) * 180) / Math.PI; // turn angle
  }

  const sep = Math.round(n / 10);
  const apart = (i: number, j: number) => {
    const d = Math.abs(i - j);
    return cyclic ? Math.min(d, n - d) : d;
  };

  // Candidates over threshold, strongest first; greedily suppress neighbors.
  const candidates = angles
    .map((angle, i) => ({ angle, i }))
    .filter((c) => c.angle >= thresholdDeg)
    .sort((p, q) => q.angle - p.angle);

  const chosen: number[] = [];
  for (const c of candidates) {
    if (chosen.every((j) => apart(c.i, j) >= sep)) chosen.push(c.i);
  }
  return chosen.sort((p, q) => p - q);
}

function snapLineAngle(start: Pt, end: Pt): Pt {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (Math.hypot(dx, dy) === 0) return end;
  let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  if (angle < 0) angle += 360;
  const tol = 8;
  const near = (t: number) => Math.abs(((angle - t + 540) % 360) - 180) < tol;
  if (near(0) || near(180)) return { x: end.x, y: start.y };
  if (near(90) || near(270)) return { x: start.x, y: end.y };
  if (near(45) || near(135) || near(225) || near(315)) {
    const m = (Math.abs(dx) + Math.abs(dy)) / 2;
    return { x: start.x + Math.sign(dx) * m, y: start.y + Math.sign(dy) * m };
  }
  return end;
}

/// Detect an arrow drawn in one stroke: a long shaft followed by a short
/// barb that doubles back. Returns the shaft endpoints, or null.
function detectArrow(points: Pt[], pathLen: number): { start: Pt; end: Pt } | null {
  const rs = resample(points, 48);
  const corners = findCorners(rs, 45, false);
  if (corners.length < 1 || corners.length > 2) return null;
  const tip = corners[0];
  const shaft = dist(rs[0], rs[tip]);
  // The shaft should dominate; the barb(s) after it should be short.
  if (shaft < 0.55 * pathLen) return null;
  const tail = dist(rs[tip], rs[rs.length - 1]);
  if (tail > 0.45 * shaft) return null;
  return { start: rs[0], end: rs[tip] };
}

export function recognizeShape(points: Pt[]): Recognized | null {
  if (points.length < 4) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const w = maxX - minX;
  const h = maxY - minY;
  const diag = Math.hypot(w, h);
  if (diag < 12) return null;

  let pathLen = 0;
  for (let i = 1; i < points.length; i++) pathLen += dist(points[i], points[i - 1]);

  const start = points[0];
  const end = points[points.length - 1];
  const endGap = dist(start, end);
  const closed = endGap < 0.28 * diag;

  // ── Open strokes: straight line or arrow ─────────────────────────────
  if (!closed) {
    const chord = dist(start, end);
    if (chord > 0 && pathLen / chord < 1.16) {
      return { type: "line", start, end: snapLineAngle(start, end) };
    }
    const arrow = detectArrow(points, pathLen);
    if (arrow) {
      return { type: "arrow", start: arrow.start, end: snapLineAngle(arrow.start, arrow.end) };
    }
    return null;
  }

  // ── Closed strokes: triangle / rectangle / circle by corner count ────
  const rs = resample(points, 64);
  const corners = findCorners(rs, 50, true);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const rx = w / 2;
  const ry = h / 2;

  // Ellipse goodness-of-fit: mean deviation of normalized radius from 1.
  let ellErr = Infinity;
  if (rx > 0 && ry > 0) {
    let sum = 0;
    for (const p of points) {
      sum += Math.abs(Math.hypot((p.x - cx) / rx, (p.y - cy) / ry) - 1);
    }
    ellErr = sum / points.length;
  }

  const circle = (): Recognized => {
    if (Math.abs(w - h) < 0.2 * Math.max(w, h)) {
      const r = (rx + ry) / 2;
      return { type: "circle", center: { x: cx, y: cy }, radiusX: r, radiusY: r };
    }
    return { type: "circle", center: { x: cx, y: cy }, radiusX: rx, radiusY: ry };
  };

  if (corners.length === 3 && ellErr > 0.12) {
    const [a, b, c] = corners.map((i) => rs[i]);
    return { type: "triangle", a, b, c };
  }
  if (corners.length === 4 && ellErr > 0.1) {
    // Rect corners sit at the bbox corners (both coords extreme); diamond
    // corners sit at the edge midpoints (one coord near the centre). Average
    // the smaller normalized offset per corner to tell them apart.
    let sumMin = 0;
    for (const i of corners) {
      const p = rs[i];
      const ndx = rx > 0 ? Math.abs(p.x - cx) / rx : 0;
      const ndy = ry > 0 ? Math.abs(p.y - cy) / ry : 0;
      sumMin += Math.min(ndx, ndy);
    }
    if (sumMin / corners.length < 0.4) {
      return { type: "diamond", start: { x: minX, y: minY }, end: { x: maxX, y: maxY } };
    }
    return { type: "rect", start: { x: minX, y: minY }, end: { x: maxX, y: maxY } };
  }
  if (ellErr < 0.28) {
    return circle();
  }
  if (corners.length === 4) {
    return { type: "rect", start: { x: minX, y: minY }, end: { x: maxX, y: maxY } };
  }
  return null;
}
