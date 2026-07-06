import { useRef, useState, useCallback, useEffect } from "react";
import type { PointerEvent, RefObject } from "react";
import rough from "roughjs";
import { paintStroke, paintStrokes, preloadImage } from "../utils/paint";
import { recognizeShape } from "../utils/shapeRecognition";
import {
  bboxHandles,
  cloneStroke,
  cloneStrokes,
  hitTest,
  oppositeCorner,
  rectsIntersect,
  remapStroke,
  strokeBBox,
  translateStroke,
  unionBBox,
  type BBox,
  type HandleId,
  type Pt,
} from "../utils/strokeGeometry";
import type { DrawingTool, Stroke, TextStroke } from "../types";

const SNIP_COLORS = ["#000000", "#ef4444", "#ffdf3d", "#22c55e", "#38bdf8", "#ffffff"];
const HISTORY_LIMIT = 100;
/** The eraser footprint is this many times wider than the pencil nib. */
export const ERASER_RATIO = 5;

export interface TextToolRequest {
  x: number;
  y: number;
  /** Index of the text stroke being edited, or null when placing a new one. */
  index: number | null;
  value: string;
  fontSize: number;
}

interface UseDrawingEngineOptions {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  pencilWidth: number;
  opacity: number;
  /** When on, freehand strokes are snapped to clean geometry (line / arrow /
   *  triangle / rect / circle) and anything unrecognized is smoothed ink. */
  smoothing: boolean;
  /** When on, geometric shapes and text render in a hand-drawn (Excalidraw)
   *  style via roughjs + a handwriting font. Independent of `smoothing`. */
  sketch: boolean;
  /** Invoked when the text tool is used (place or edit) so the host can show a
   *  text-entry overlay. */
  onTextTool?: (req: TextToolRequest) => void;
  /** Invoked when the pin tool clicks the canvas (image pixel coords). */
  onPinTool?: (point: { x: number; y: number }) => void;
}

export { SNIP_COLORS };

export function useDrawingEngine({
  canvasRef,
  pencilWidth,
  opacity,
  smoothing,
  sketch,
  onTextTool,
  onPinTool,
}: UseDrawingEngineOptions) {
  const [activeTool, setActiveToolState] = useState<DrawingTool>("pencil");
  const [activeColor, setActiveColor] = useState(SNIP_COLORS[0]);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [selectionCount, setSelectionCount] = useState(0);
  const [selectedIndices, setSelectedIndicesState] = useState<number[]>([]);
  const [canGroup, setCanGroup] = useState(false);
  const [canUngroup, setCanUngroup] = useState(false);
  // Bumped on every committed structural change so views (e.g. the layers
  // panel) re-render even when other state happens to be unchanged.
  const [revision, setRevision] = useState(0);
  const [groupNames, setGroupNames] = useState<Record<number, string>>({});
  const groupNamesRef = useRef<Record<number, string>>({});
  groupNamesRef.current = groupNames;

  const strokesRef = useRef<Stroke[]>([]);
  const drawingRef = useRef(false);
  const currentStrokeRef = useRef<Stroke | null>(null);
  const startPointRef = useRef<{ x: number; y: number } | null>(null);

  // Undo/redo as full-state snapshots so every mutation (add/delete/move/
  // resize/clear/group) is reversible.
  const undoStackRef = useRef<Stroke[][]>([]);
  const redoStackRef = useRef<Stroke[][]>([]);

  // Selection / transform state. `selectedIndicesRef` holds all selected
  // strokes (multi-select); transforms apply to the whole set.
  const selectedIndicesRef = useRef<number[]>([]);
  const dragModeRef = useRef<"none" | "move" | "resize" | "marquee">("none");
  const anchorRef = useRef<Pt | null>(null);
  const origGroupRef = useRef<{ index: number; stroke: Stroke }[]>([]);
  const origBBoxRef = useRef<BBox | null>(null);
  const dragStartRef = useRef<Pt | null>(null);
  const marqueeRef = useRef<BBox | null>(null);
  // Tracks the last click target/time to detect a double-click (drill into a
  // group to select a single child).
  const lastClickRef = useRef<{ t: number; hit: number | null }>({
    t: 0,
    hit: null,
  });
  const transformSnapshotRef = useRef<Stroke[] | null>(null);
  const transformDirtyRef = useRef(false);
  const groupCounterRef = useRef(1);

  // rAF coalescing so a burst of pointermove events repaints at most once per
  // frame — keeps dragging/resizing/free-drawing smooth on big canvases.
  const rafRef = useRef<number | null>(null);
  const pendingPreviewRef = useRef<Stroke | null>(null);

  const updateHistoryState = useCallback(() => {
    setCanUndo(undoStackRef.current.length > 0);
    setCanRedo(redoStackRef.current.length > 0);
    setRevision((r) => r + 1);
  }, []);

  const refreshSelectionState = useCallback((indices: number[]) => {
    setSelectionCount(indices.length);
    setSelectedIndicesState(indices);
    setCanGroup(indices.length >= 2);
    setCanUngroup(indices.some((i) => strokesRef.current[i]?.groupId != null));
  }, []);

  const setSelection = useCallback(
    (indices: number[]) => {
      selectedIndicesRef.current = indices;
      refreshSelectionState(indices);
    },
    [refreshSelectionState],
  );

  // Push the current strokes onto the undo stack (call before a mutation).
  const snapshot = useCallback(() => {
    undoStackRef.current.push(cloneStrokes(strokesRef.current));
    if (undoStackRef.current.length > HISTORY_LIMIT) undoStackRef.current.shift();
    redoStackRef.current = [];
  }, []);

  const selectionBBox = useCallback((): BBox | null => {
    const boxes = selectedIndicesRef.current
      .map((i) => strokesRef.current[i])
      .filter(Boolean)
      .map((s) => strokeBBox(s));
    return unionBBox(boxes);
  }, []);

  // Expand a set of indices so that selecting one member of a group selects
  // the whole group.
  const expandToGroups = useCallback((indices: number[]): number[] => {
    const strokes = strokesRef.current;
    const groups = new Set<number>();
    for (const i of indices) {
      const g = strokes[i]?.groupId;
      if (g != null) groups.add(g);
    }
    const result = new Set<number>(indices);
    if (groups.size) {
      strokes.forEach((s, i) => {
        if (s.groupId != null && groups.has(s.groupId)) result.add(i);
      });
    }
    return [...result].sort((a, b) => a - b);
  }, []);

  const getLineWidth = useCallback(
    (canvas: HTMLCanvasElement) =>
      Math.max(1, (canvas.width / 180) * pencilWidth),
    [pencilWidth],
  );

  const pointFromEvent = (e: PointerEvent<HTMLCanvasElement>) => {
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  // Selection chrome (per-stroke outlines + union box + handles) drawn on top
  // of the strokes. Cleared before saving/exporting so it never bakes in.
  const drawSelectionChrome = useCallback(
    (ctx: CanvasRenderingContext2D) => {
      const canvas = ctx.canvas;
      const lw = Math.max(1, canvas.width / 700);
      const hs = Math.max(5, canvas.width / 130);

      const m = marqueeRef.current;
      if (m) {
        ctx.save();
        ctx.strokeStyle = "#3b82f6";
        ctx.fillStyle = "rgba(59,130,246,0.12)";
        ctx.lineWidth = lw;
        ctx.fillRect(m.x, m.y, m.w, m.h);
        ctx.strokeRect(m.x, m.y, m.w, m.h);
        ctx.restore();
      }

      const indices = selectedIndicesRef.current;
      if (indices.length === 0) return;

      ctx.save();
      ctx.strokeStyle = "rgba(59,130,246,0.7)";
      ctx.lineWidth = lw;
      for (const i of indices) {
        const s = strokesRef.current[i];
        if (!s) continue;
        const sb = strokeBBox(s);
        ctx.strokeRect(sb.x, sb.y, sb.w, sb.h);
      }
      ctx.restore();

      const b = selectionBBox();
      if (!b) return;
      ctx.save();
      ctx.strokeStyle = "#3b82f6";
      ctx.lineWidth = lw;
      ctx.setLineDash([hs, hs * 0.6]);
      ctx.strokeRect(b.x, b.y, b.w, b.h);
      ctx.setLineDash([]);
      ctx.fillStyle = "#ffffff";
      for (const h of Object.values(bboxHandles(b))) {
        ctx.fillRect(h.x - hs / 2, h.y - hs / 2, hs, hs);
        ctx.strokeRect(h.x - hs / 2, h.y - hs / 2, hs, hs);
      }
      ctx.restore();
    },
    [selectionBBox],
  );

  const redrawAll = useCallback(
    (previewStroke?: Stroke | null) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      paintStrokes(ctx, strokesRef.current, smoothing, sketch);
      if (previewStroke) {
        const rc = sketch ? rough.canvas(canvas) : null;
        paintStroke(ctx, previewStroke, smoothing, sketch, rc);
      }
      drawSelectionChrome(ctx);
    },
    [canvasRef, smoothing, sketch, drawSelectionChrome],
  );

  // Coalesced redraw for drag-driven updates.
  const scheduleRedraw = useCallback(
    (preview?: Stroke | null) => {
      pendingPreviewRef.current = preview ?? null;
      if (rafRef.current != null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        redrawAll(pendingPreviewRef.current);
      });
    },
    [redrawAll],
  );

  // Drop a pending coalesced frame so it can't repaint a stale preview after a
  // gesture has already committed.
  const cancelScheduledRedraw = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    pendingPreviewRef.current = null;
  }, []);

  useEffect(
    () => () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  // Re-render when the smoothing mode flips so freehand ink updates live.
  useEffect(() => {
    redrawAll();
  }, [smoothing, redrawAll]);

  const deselect = useCallback(() => {
    if (selectedIndicesRef.current.length === 0 && !marqueeRef.current) return;
    selectedIndicesRef.current = [];
    marqueeRef.current = null;
    refreshSelectionState([]);
    redrawAll();
  }, [redrawAll, refreshSelectionState]);

  const setActiveTool = useCallback(
    (tool: DrawingTool) => {
      setActiveToolState(tool);
      const had = selectedIndicesRef.current.length > 0;
      selectedIndicesRef.current = [];
      marqueeRef.current = null;
      refreshSelectionState([]);
      if (had) redrawAll();
    },
    [redrawAll, refreshSelectionState],
  );

  // Select exactly the given strokes from outside the canvas (the layers
  // panel) — no group expansion, so a single group member can be picked. The
  // panel decides whether to pass one index or a whole group's indices.
  const selectStrokes = useCallback(
    (indices: number[], additive = false) => {
      setActiveToolState("select");
      const base = additive ? selectedIndicesRef.current : [];
      const merged = [...new Set([...base, ...indices])].sort((a, b) => a - b);
      setSelection(merged);
      redrawAll();
    },
    [setSelection, redrawAll],
  );

  // Escape: step a drilled-in child selection back up to its whole group,
  // otherwise just deselect.
  const escapeSelection = useCallback(() => {
    const sel = selectedIndicesRef.current;
    if (!sel.length) return;
    const strokes = strokesRef.current;
    const gids = new Set(
      sel.map((i) => strokes[i]?.groupId).filter((g): g is number => g != null),
    );
    if (gids.size === 1) {
      const gid = [...gids][0];
      const members: number[] = [];
      strokes.forEach((s, i) => {
        if (s.groupId === gid) members.push(i);
      });
      if (sel.length < members.length) {
        setSelection(members);
        redrawAll();
        return;
      }
    }
    deselect();
  }, [setSelection, deselect, redrawAll]);

  // After dragging a subset of a group, any moved member that no longer
  // overlaps the rest of its group pops out of the group (Figma-style).
  const applyGroupPopOut = useCallback(() => {
    const sel = selectedIndicesRef.current;
    if (!sel.length) return;
    const strokes = strokesRef.current;
    const byGid = new Map<number, number[]>();
    for (const i of sel) {
      const g = strokes[i]?.groupId;
      if (g == null) continue;
      const arr = byGid.get(g) ?? [];
      arr.push(i);
      byGid.set(g, arr);
    }
    for (const [gid, movedMembers] of byGid) {
      const all: number[] = [];
      strokes.forEach((s, i) => {
        if (s.groupId === gid) all.push(i);
      });
      const remaining = all.filter((i) => !movedMembers.includes(i));
      if (remaining.length === 0) continue; // whole group moved → stays grouped
      const remainBox = unionBBox(remaining.map((i) => strokeBBox(strokes[i])));
      if (!remainBox) continue;
      for (const i of movedMembers) {
        if (!rectsIntersect(strokeBBox(strokes[i]), remainBox)) {
          strokes[i] = { ...strokes[i], groupId: undefined };
        }
      }
    }
  }, []);

  // Select every visible, unlocked stroke (Ctrl/Cmd+A).
  const selectAll = useCallback(() => {
    setActiveToolState("select");
    const all: number[] = [];
    strokesRef.current.forEach((s, i) => {
      if (!s.hidden && !s.locked) all.push(i);
    });
    setSelection(all);
    redrawAll();
  }, [setSelection, redrawAll]);

  const undo = useCallback(() => {
    if (!undoStackRef.current.length) return;
    redoStackRef.current.push(cloneStrokes(strokesRef.current));
    strokesRef.current = undoStackRef.current.pop()!;
    selectedIndicesRef.current = [];
    refreshSelectionState([]);
    redrawAll();
    updateHistoryState();
  }, [redrawAll, refreshSelectionState, updateHistoryState]);

  const redo = useCallback(() => {
    if (!redoStackRef.current.length) return;
    undoStackRef.current.push(cloneStrokes(strokesRef.current));
    strokesRef.current = redoStackRef.current.pop()!;
    selectedIndicesRef.current = [];
    refreshSelectionState([]);
    redrawAll();
    updateHistoryState();
  }, [redrawAll, refreshSelectionState, updateHistoryState]);

  const clearAll = useCallback(() => {
    if (strokesRef.current.length === 0) return;
    snapshot();
    strokesRef.current = [];
    selectedIndicesRef.current = [];
    marqueeRef.current = null;
    refreshSelectionState([]);
    redrawAll();
    updateHistoryState();
  }, [snapshot, redrawAll, refreshSelectionState, updateHistoryState]);

  const deleteSelected = useCallback(() => {
    const indices = selectedIndicesRef.current;
    if (indices.length === 0) return;
    snapshot();
    for (const i of [...indices].sort((a, b) => b - a)) {
      strokesRef.current.splice(i, 1);
    }
    selectedIndicesRef.current = [];
    refreshSelectionState([]);
    redrawAll();
    updateHistoryState();
  }, [snapshot, redrawAll, refreshSelectionState, updateHistoryState]);

  const groupSelected = useCallback(() => {
    const sel = selectedIndicesRef.current;
    if (sel.length < 2) return;
    snapshot();
    const gid = groupCounterRef.current++;
    for (const i of sel) {
      strokesRef.current[i] = { ...strokesRef.current[i], groupId: gid };
    }
    refreshSelectionState(sel);
    redrawAll();
    updateHistoryState();
  }, [snapshot, redrawAll, refreshSelectionState, updateHistoryState]);

  const ungroupSelected = useCallback(() => {
    const sel = selectedIndicesRef.current;
    if (!sel.length) return;
    snapshot();
    for (const i of sel) {
      strokesRef.current[i] = { ...strokesRef.current[i], groupId: undefined };
    }
    refreshSelectionState(sel);
    redrawAll();
    updateHistoryState();
  }, [snapshot, redrawAll, refreshSelectionState, updateHistoryState]);

  const renameGroup = useCallback((groupId: number, name: string) => {
    setGroupNames((prev) => ({ ...prev, [groupId]: name }));
  }, []);

  // Restore group names and bump the id counter past any loaded ids (project
  // import). Strokes themselves are loaded per page via setStrokes.
  const restoreGroups = useCallback((names: Record<number, string>) => {
    setGroupNames(names);
    const ids = Object.keys(names).map(Number);
    if (ids.length) {
      groupCounterRef.current = Math.max(groupCounterRef.current, ...ids) + 1;
    }
  }, []);

  // Duplicate the selection: clone with a small offset, remap group ids (so the
  // copy is its own group), and select the copies.
  const duplicateSelected = useCallback(() => {
    const sel = selectedIndicesRef.current;
    if (!sel.length) return;
    snapshot();
    const offset = 16;
    const gidRemap = new Map<number, number>();
    const nameAdds: Record<number, string> = {};
    const startLen = strokesRef.current.length;
    for (const i of sel) {
      const original = strokesRef.current[i];
      let copy = translateStroke(original, offset, offset);
      if (original.groupId != null) {
        let ng = gidRemap.get(original.groupId);
        if (ng == null) {
          ng = groupCounterRef.current++;
          gidRemap.set(original.groupId, ng);
          const base = groupNamesRef.current[original.groupId];
          if (base) nameAdds[ng] = `${base} copy`;
        }
        copy = { ...copy, groupId: ng };
      }
      strokesRef.current.push(copy);
    }
    if (Object.keys(nameAdds).length) {
      setGroupNames((prev) => ({ ...prev, ...nameAdds }));
    }
    const newIndices = sel.map((_, k) => startLen + k);
    setSelection(newIndices);
    redrawAll();
    updateHistoryState();
  }, [snapshot, setSelection, redrawAll, updateHistoryState]);

  // Reorder the selected strokes one step in z-order (toward front/back). A
  // single pass of adjacent swaps — O(n), no new stroke allocations.
  const moveSelected = useCallback(
    (dir: "forward" | "backward") => {
      const sel = selectedIndicesRef.current;
      if (!sel.length) return;
      const strokes = strokesRef.current;
      const n = strokes.length;
      const selected = new Array(n).fill(false);
      for (const i of sel) selected[i] = true;
      snapshot();
      const swap = (a: number, b: number) => {
        const t = strokes[a];
        strokes[a] = strokes[b];
        strokes[b] = t;
        selected[a] = !selected[a];
        selected[b] = !selected[b];
      };
      if (dir === "forward") {
        for (let i = n - 2; i >= 0; i--) {
          if (selected[i] && !selected[i + 1]) swap(i, i + 1);
        }
      } else {
        for (let i = 1; i < n; i++) {
          if (selected[i] && !selected[i - 1]) swap(i, i - 1);
        }
      }
      const next: number[] = [];
      selected.forEach((on, i) => {
        if (on) next.push(i);
      });
      setSelection(next);
      redrawAll();
      updateHistoryState();
    },
    [snapshot, setSelection, redrawAll, updateHistoryState],
  );

  // Set a flag (hidden / locked) on EXACTLY the given strokes — no group
  // expansion, so toggling one member of a group affects only that member.
  // The panel passes a single index for an item, or all member indices for a
  // group header.
  const setFlag = useCallback(
    (indices: number[], key: "hidden" | "locked", value: boolean) => {
      for (const i of indices) {
        const s = strokesRef.current[i];
        if (s) strokesRef.current[i] = { ...s, [key]: value };
      }
      setRevision((r) => r + 1);
      redrawAll();
    },
    [redrawAll],
  );

  const setHidden = useCallback(
    (indices: number[], value: boolean) => setFlag(indices, "hidden", value),
    [setFlag],
  );

  const setLocked = useCallback(
    (indices: number[], value: boolean) => setFlag(indices, "locked", value),
    [setFlag],
  );

  const renameStroke = useCallback(
    (index: number, name: string) => {
      const s = strokesRef.current[index];
      if (!s) return;
      snapshot();
      const trimmed = name.trim();
      strokesRef.current[index] = { ...s, name: trimmed || undefined };
      setRevision((r) => r + 1);
    },
    [snapshot],
  );

  const initCanvas = useCallback(
    (width: number, height: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = width;
      canvas.height = height;
      redrawAll();
    },
    [canvasRef, redrawAll],
  );

  // Swap the stroke set in/out — used by the page switcher. History is reset so
  // undo never crosses page boundaries.
  const getStrokes = useCallback(
    () => strokesRef.current.map((s) => cloneStroke(s)),
    [],
  );
  const setStrokes = useCallback(
    (next: Stroke[]) => {
      strokesRef.current = next.map((s) => cloneStroke(s));
      undoStackRef.current = [];
      redoStackRef.current = [];
      selectedIndicesRef.current = [];
      marqueeRef.current = null;
      // Decode any embedded images so they paint once ready.
      for (const s of strokesRef.current) {
        if (s.tool === "image") preloadImage(s.src, redrawAll);
      }
      refreshSelectionState([]);
      redrawAll();
      updateHistoryState();
    },
    [redrawAll, refreshSelectionState, updateHistoryState],
  );

  const beginTransform = useCallback(() => {
    origGroupRef.current = selectedIndicesRef.current.map((index) => ({
      index,
      stroke: cloneStroke(strokesRef.current[index]),
    }));
    origBBoxRef.current = selectionBBox();
    transformSnapshotRef.current = cloneStrokes(strokesRef.current);
    transformDirtyRef.current = false;
  }, [selectionBBox]);

  const buildShapeStroke = useCallback(
    (
      tool: DrawingTool,
      start: { x: number; y: number },
      end: { x: number; y: number },
      width: number,
    ): Stroke | null => {
      const base = { color: activeColor, width, opacity };
      if (tool === "line") return { tool: "line", ...base, start, end };
      if (tool === "arrow") return { tool: "arrow", ...base, start, end };
      if (tool === "rect") return { tool: "rect", ...base, start, end };
      if (tool === "diamond") return { tool: "diamond", ...base, start, end };
      // Redaction is always an opaque black block, regardless of active color.
      if (tool === "redact")
        return { tool: "redact", color: "#000000", width, opacity: 1, start, end };
      if (tool === "circle") {
        return {
          tool: "circle",
          ...base,
          center: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
          radiusX: Math.abs(end.x - start.x) / 2,
          radiusY: Math.abs(end.y - start.y) / 2,
        };
      }
      return null;
    },
    [activeColor, opacity],
  );

  // Commit a new text stroke placed by the text-entry overlay.
  const addText = useCallback(
    (x: number, y: number, text: string, fontSize: number) => {
      if (!text.trim()) return;
      snapshot();
      strokesRef.current.push({
        tool: "text",
        color: activeColor,
        width: 1,
        opacity,
        x,
        y,
        text,
        fontSize,
      });
      redrawAll();
      updateHistoryState();
    },
    [activeColor, opacity, snapshot, redrawAll, updateHistoryState],
  );

  // Insert an image (data URL). It's decoded, scaled to fit within ~45% of the
  // canvas, centered, added as a movable/resizable stroke, and selected.
  const addImage = useCallback(
    (src: string) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const probe = new Image();
      probe.onload = () => {
        const maxW = canvas.width * 0.45;
        const maxH = canvas.height * 0.45;
        const scale = Math.min(1, maxW / probe.naturalWidth, maxH / probe.naturalHeight);
        const w = probe.naturalWidth * scale;
        const h = probe.naturalHeight * scale;
        const x = (canvas.width - w) / 2;
        const y = (canvas.height - h) / 2;
        snapshot();
        strokesRef.current.push({
          tool: "image",
          color: "#000000",
          width: 1,
          opacity: 1,
          src,
          start: { x, y },
          end: { x: x + w, y: y + h },
        });
        const newIndex = strokesRef.current.length - 1;
        preloadImage(src, redrawAll);
        setActiveToolState("select");
        selectedIndicesRef.current = [newIndex];
        refreshSelectionState([newIndex]);
        redrawAll();
        updateHistoryState();
      };
      probe.src = src;
    },
    [canvasRef, snapshot, redrawAll, refreshSelectionState, updateHistoryState],
  );

  // Replace the text of an existing text stroke (empty text deletes it).
  const updateText = useCallback(
    (index: number, text: string) => {
      const s = strokesRef.current[index];
      if (!s || s.tool !== "text") return;
      snapshot();
      if (!text.trim()) {
        strokesRef.current.splice(index, 1);
      } else {
        strokesRef.current[index] = { ...s, text };
      }
      redrawAll();
      updateHistoryState();
    },
    [snapshot, redrawAll, updateHistoryState],
  );

  // ─── Pointer Handlers ─────────────────────────────────────────────────

  const onPointerDown = useCallback(
    (e: PointerEvent<HTMLCanvasElement>) => {
      const canvas = e.currentTarget;
      const point = pointFromEvent(e);

      // ── Select mode: handle / stroke / shift-toggle / marquee ──────────
      if (activeTool === "select") {
        canvas.setPointerCapture(e.pointerId);
        const handleTol = Math.max(canvas.width / 110, 10);
        const selected = selectedIndicesRef.current;

        const ub = selectionBBox();
        if (ub) {
          for (const [id, h] of Object.entries(bboxHandles(ub))) {
            if (Math.hypot(point.x - h.x, point.y - h.y) <= handleTol) {
              dragModeRef.current = "resize";
              anchorRef.current = oppositeCorner(ub, id as HandleId);
              dragStartRef.current = point;
              beginTransform();
              return;
            }
          }
        }

        let hit: number | null = null;
        for (let i = strokesRef.current.length - 1; i >= 0; i--) {
          const s = strokesRef.current[i];
          if (s.hidden || s.locked) continue;
          if (hitTest(s, point, handleTol)) {
            hit = i;
            break;
          }
        }

        if (hit !== null) {
          const now = performance.now();
          const isDouble =
            hit === lastClickRef.current.hit &&
            now - lastClickRef.current.t < 350;
          lastClickRef.current = { t: now, hit };

          const group = expandToGroups([hit]);
          if (e.shiftKey) {
            const allIn = group.every((i) => selected.includes(i));
            const next = allIn
              ? selected.filter((i) => !group.includes(i))
              : [...new Set([...selected, ...group])].sort((a, b) => a - b);
            setSelection(next);
            dragModeRef.current = "none";
            redrawAll();
            return;
          }
          // Double-click a text stroke opens the text editor.
          if (isDouble && strokesRef.current[hit].tool === "text") {
            const t = strokesRef.current[hit] as TextStroke;
            onTextTool?.({
              x: t.x,
              y: t.y,
              index: hit,
              value: t.text,
              fontSize: t.fontSize,
            });
            dragModeRef.current = "none";
            return;
          }
          // Double-click drills into a group: select just this child (it stays
          // in the group). Single-click selects the whole group.
          const target = isDouble ? [hit] : group;
          if (!target.every((i) => selected.includes(i)) || isDouble) {
            setSelection(target);
          }
          dragModeRef.current = "move";
          dragStartRef.current = point;
          beginTransform();
          redrawAll();
          return;
        }
        lastClickRef.current = { t: 0, hit: null };

        if (!e.shiftKey && selected.length) setSelection([]);
        dragModeRef.current = "marquee";
        dragStartRef.current = point;
        marqueeRef.current = { x: point.x, y: point.y, w: 0, h: 0 };
        redrawAll();
        return;
      }

      // Text tool: hand off to the host's text-entry overlay (no stroke drawn
      // until the user commits text).
      if (activeTool === "text") {
        const fontSize = Math.max(16, Math.round(canvas.width / 45));
        onTextTool?.({ x: point.x, y: point.y, index: null, value: "", fontSize });
        return;
      }

      // Pin tool: hand the image-pixel coords to the host to attach a note.
      if (activeTool === "pin") {
        onPinTool?.({ x: point.x, y: point.y });
        return;
      }

      drawingRef.current = true;
      canvas.setPointerCapture(e.pointerId);
      startPointRef.current = point;

      const lineWidth = getLineWidth(canvas);

      if (activeTool === "pencil" || activeTool === "eraser") {
        currentStrokeRef.current = {
          tool: activeTool,
          color: activeColor,
          width:
            activeTool === "eraser" ? lineWidth * ERASER_RATIO : lineWidth,
          opacity: activeTool === "eraser" ? 1 : opacity,
          points: [point],
        };
      } else {
        currentStrokeRef.current = null;
      }
    },
    [
      activeTool,
      activeColor,
      opacity,
      getLineWidth,
      selectionBBox,
      expandToGroups,
      beginTransform,
      setSelection,
      redrawAll,
      onTextTool,
      onPinTool,
    ],
  );

  const onPointerMove = useCallback(
    (e: PointerEvent<HTMLCanvasElement>) => {
      // ── Select mode: move / resize the group, or extend the marquee ────
      if (activeTool === "select") {
        const mode = dragModeRef.current;
        if (mode === "none") return;
        const point = pointFromEvent(e);
        const startPt = dragStartRef.current;
        if (!startPt) return;

        if (mode === "marquee") {
          marqueeRef.current = {
            x: Math.min(startPt.x, point.x),
            y: Math.min(startPt.y, point.y),
            w: Math.abs(point.x - startPt.x),
            h: Math.abs(point.y - startPt.y),
          };
          scheduleRedraw();
          return;
        }

        const ob = origBBoxRef.current;
        const group = origGroupRef.current;
        if (!ob || group.length === 0) return;

        let nb: BBox;
        if (mode === "move") {
          const dx = point.x - startPt.x;
          const dy = point.y - startPt.y;
          nb = { x: ob.x + dx, y: ob.y + dy, w: ob.w, h: ob.h };
        } else {
          const anchor = anchorRef.current;
          if (!anchor) return;
          const w = Math.max(Math.abs(point.x - anchor.x), 4);
          const h = Math.max(Math.abs(point.y - anchor.y), 4);
          nb = {
            x: Math.min(anchor.x, anchor.x + Math.sign(point.x - anchor.x) * w),
            y: Math.min(anchor.y, anchor.y + Math.sign(point.y - anchor.y) * h),
            w,
            h,
          };
        }
        transformDirtyRef.current = true;
        for (const { index, stroke } of group) {
          strokesRef.current[index] = remapStroke(stroke, ob, nb);
        }
        scheduleRedraw();
        return;
      }

      if (!drawingRef.current) return;
      const canvas = e.currentTarget;
      const point = pointFromEvent(e);
      const lineWidth = getLineWidth(canvas);

      if (activeTool === "pencil" || activeTool === "eraser") {
        const stroke = currentStrokeRef.current;
        if (stroke && "points" in stroke) {
          stroke.points.push(point);
          if (smoothing && activeTool === "pencil") {
            scheduleRedraw(stroke);
            return;
          }
          // Incremental segment draw for raw freehand / eraser (cheap).
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.save();
            ctx.globalAlpha = stroke.opacity ?? 1;
            ctx.strokeStyle = stroke.color;
            ctx.lineWidth = stroke.width;
            ctx.lineCap = "round";
            ctx.lineJoin = "round";
            if (activeTool === "eraser") {
              ctx.globalCompositeOperation = "destination-out";
            }
            const pts = stroke.points;
            ctx.beginPath();
            ctx.moveTo(pts[pts.length - 2].x, pts[pts.length - 2].y);
            ctx.lineTo(point.x, point.y);
            ctx.stroke();
            ctx.restore();
          }
        }
      } else {
        const start = startPointRef.current;
        if (!start) return;
        const preview = buildShapeStroke(activeTool, start, point, lineWidth);
        currentStrokeRef.current = preview;
        scheduleRedraw(preview);
      }
    },
    [activeTool, smoothing, getLineWidth, buildShapeStroke, scheduleRedraw],
  );

  const snapFreehand = useCallback((stroke: Stroke): Stroke => {
    if (stroke.tool !== "pencil" || stroke.points.length < 4) return stroke;
    const shape = recognizeShape(stroke.points);
    if (!shape) return stroke;
    const base = {
      color: stroke.color,
      width: Math.max(stroke.width, 1.5),
      opacity: stroke.opacity,
    };
    switch (shape.type) {
      case "line":
        return { tool: "line", ...base, start: shape.start, end: shape.end };
      case "arrow":
        return { tool: "arrow", ...base, start: shape.start, end: shape.end };
      case "rect":
        return { tool: "rect", ...base, start: shape.start, end: shape.end };
      case "diamond":
        return { tool: "diamond", ...base, start: shape.start, end: shape.end };
      case "triangle":
        return { tool: "triangle", ...base, a: shape.a, b: shape.b, c: shape.c };
      case "circle":
        return {
          tool: "circle",
          ...base,
          center: shape.center,
          radiusX: shape.radiusX,
          radiusY: shape.radiusY,
        };
    }
  }, []);

  const onPointerUp = useCallback(
    (e: PointerEvent<HTMLCanvasElement>) => {
      cancelScheduledRedraw();
      if (activeTool === "select") {
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          // May already be released
        }
        const mode = dragModeRef.current;
        if (mode === "marquee" && marqueeRef.current) {
          const m = marqueeRef.current;
          if (m.w > 2 || m.h > 2) {
            const hits: number[] = [];
            strokesRef.current.forEach((s, i) => {
              if (s.hidden || s.locked) return;
              if (rectsIntersect(strokeBBox(s), m)) hits.push(i);
            });
            setSelection(expandToGroups(hits));
          }
          marqueeRef.current = null;
        } else if (
          (mode === "move" || mode === "resize") &&
          transformDirtyRef.current &&
          transformSnapshotRef.current
        ) {
          // A partial-group move can pop members out of their group.
          if (mode === "move") {
            applyGroupPopOut();
            refreshSelectionState(selectedIndicesRef.current);
          }
          // Commit the pre-transform state to history.
          undoStackRef.current.push(transformSnapshotRef.current);
          if (undoStackRef.current.length > HISTORY_LIMIT) {
            undoStackRef.current.shift();
          }
          redoStackRef.current = [];
          updateHistoryState();
        }
        dragModeRef.current = "none";
        anchorRef.current = null;
        origGroupRef.current = [];
        origBBoxRef.current = null;
        dragStartRef.current = null;
        transformSnapshotRef.current = null;
        transformDirtyRef.current = false;
        redrawAll();
        return;
      }

      if (!drawingRef.current) return;
      drawingRef.current = false;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // May already be released
      }

      const canvas = e.currentTarget;
      const point = pointFromEvent(e);
      const start = startPointRef.current;
      const lineWidth = getLineWidth(canvas);

      let finalStroke: Stroke | null = null;

      if (activeTool === "pencil") {
        finalStroke = currentStrokeRef.current;
        if (smoothing && finalStroke) finalStroke = snapFreehand(finalStroke);
      } else if (activeTool === "eraser") {
        finalStroke = currentStrokeRef.current;
      } else if (start) {
        finalStroke = buildShapeStroke(activeTool, start, point, lineWidth);
      }

      if (finalStroke) {
        snapshot();
        strokesRef.current.push(finalStroke);
        redrawAll();
        updateHistoryState();
      }

      currentStrokeRef.current = null;
      startPointRef.current = null;
    },
    [
      activeTool,
      smoothing,
      getLineWidth,
      buildShapeStroke,
      snapFreehand,
      snapshot,
      expandToGroups,
      setSelection,
      applyGroupPopOut,
      refreshSelectionState,
      cancelScheduledRedraw,
      redrawAll,
      updateHistoryState,
    ],
  );

  const onPointerCancel = useCallback(
    (e: PointerEvent<HTMLCanvasElement>) => {
      cancelScheduledRedraw();
      drawingRef.current = false;
      currentStrokeRef.current = null;
      startPointRef.current = null;
      dragModeRef.current = "none";
      marqueeRef.current = null;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // May already be released
      }
      redrawAll();
    },
    [cancelScheduledRedraw, redrawAll],
  );

  return {
    activeTool,
    setActiveTool,
    activeColor,
    setActiveColor,
    canUndo,
    canRedo,
    undo,
    redo,
    clearAll,
    selectionCount,
    selectedIndices,
    revision,
    selectStrokes,
    selectAll,
    escapeSelection,
    canGroup,
    canUngroup,
    groupSelected,
    ungroupSelected,
    duplicateSelected,
    moveSelected,
    addText,
    addImage,
    updateText,
    setHidden,
    setLocked,
    renameStroke,
    renameGroup,
    restoreGroups,
    groupNames,
    deleteSelected,
    deselect,
    initCanvas,
    getStrokes,
    setStrokes,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onPointerLeave: onPointerCancel,
  };
}
