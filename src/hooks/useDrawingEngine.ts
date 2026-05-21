import { useRef, useState, useCallback } from "react";
import type { PointerEvent, RefObject } from "react";
import type { DrawingTool, Stroke } from "../types";

const SNIP_COLORS = ["#ef4444", "#ffdf3d", "#22c55e", "#38bdf8", "#ffffff"];

interface UseDrawingEngineOptions {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  pencilWidth: number;
  opacity: number;
}

export { SNIP_COLORS };

export function useDrawingEngine({
  canvasRef,
  pencilWidth,
  opacity,
}: UseDrawingEngineOptions) {
  const [activeTool, setActiveTool] = useState<DrawingTool>("pencil");
  const [activeColor, setActiveColor] = useState(SNIP_COLORS[0]);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const strokesRef = useRef<Stroke[]>([]);
  const redoStackRef = useRef<Stroke[]>([]);
  const drawingRef = useRef(false);
  const currentStrokeRef = useRef<Stroke | null>(null);
  const startPointRef = useRef<{ x: number; y: number } | null>(null);

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

  const renderStroke = useCallback(
    (ctx: CanvasRenderingContext2D, stroke: Stroke) => {
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
        case "pencil":
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
          ctx.beginPath();
          ctx.moveTo(stroke.start.x, stroke.start.y);
          ctx.lineTo(stroke.end.x, stroke.end.y);
          ctx.stroke();
          break;
        }
        case "rect": {
          const x = Math.min(stroke.start.x, stroke.end.x);
          const y = Math.min(stroke.start.y, stroke.end.y);
          const w = Math.abs(stroke.end.x - stroke.start.x);
          const h = Math.abs(stroke.end.y - stroke.start.y);
          ctx.strokeRect(x, y, w, h);
          break;
        }
        case "circle": {
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
      }
      ctx.restore();
    },
    [],
  );

  const redrawAll = useCallback(
    (previewStroke?: Stroke | null) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const stroke of strokesRef.current) {
        renderStroke(ctx, stroke);
      }
      if (previewStroke) {
        renderStroke(ctx, previewStroke);
      }
    },
    [canvasRef, renderStroke],
  );

  const updateHistoryState = useCallback(() => {
    setCanUndo(strokesRef.current.length > 0);
    setCanRedo(redoStackRef.current.length > 0);
  }, []);

  const undo = useCallback(() => {
    const stroke = strokesRef.current.pop();
    if (stroke) {
      redoStackRef.current.push(stroke);
      redrawAll();
      updateHistoryState();
    }
  }, [redrawAll, updateHistoryState]);

  const redo = useCallback(() => {
    const stroke = redoStackRef.current.pop();
    if (stroke) {
      strokesRef.current.push(stroke);
      redrawAll();
      updateHistoryState();
    }
  }, [redrawAll, updateHistoryState]);

  const clearAll = useCallback(() => {
    strokesRef.current = [];
    redoStackRef.current = [];
    redrawAll();
    updateHistoryState();
  }, [redrawAll, updateHistoryState]);

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

  // ─── Pointer Handlers ─────────────────────────────────────────────────

  const onPointerDown = useCallback(
    (e: PointerEvent<HTMLCanvasElement>) => {
      const canvas = e.currentTarget;
      const point = pointFromEvent(e);
      drawingRef.current = true;
      canvas.setPointerCapture(e.pointerId);
      startPointRef.current = point;

      const lineWidth = getLineWidth(canvas);

      if (activeTool === "pencil" || activeTool === "eraser") {
        currentStrokeRef.current = {
          tool: activeTool,
          color: activeColor,
          width: lineWidth,
          opacity: activeTool === "eraser" ? 1 : opacity,
          points: [point],
        };
      } else {
        // For shapes, we just record the start point; the stroke is built on release
        currentStrokeRef.current = null;
      }
    },
    [activeTool, activeColor, opacity, getLineWidth],
  );

  const onPointerMove = useCallback(
    (e: PointerEvent<HTMLCanvasElement>) => {
      if (!drawingRef.current) return;
      const canvas = e.currentTarget;
      const point = pointFromEvent(e);
      const lineWidth = getLineWidth(canvas);

      if (activeTool === "pencil" || activeTool === "eraser") {
        const stroke = currentStrokeRef.current as
          | (typeof currentStrokeRef.current & {
              points: { x: number; y: number }[];
            })
          | null;
        if (stroke && "points" in stroke) {
          stroke.points.push(point);
          // Incremental draw for freehand (performance)
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
        // Shape preview: redraw everything + in-progress shape
        const start = startPointRef.current;
        if (!start) return;

        let preview: Stroke | null = null;
        if (activeTool === "line") {
          preview = {
            tool: "line",
            color: activeColor,
            width: lineWidth,
            opacity,
            start,
            end: point,
          };
        } else if (activeTool === "rect") {
          preview = {
            tool: "rect",
            color: activeColor,
            width: lineWidth,
            opacity,
            start,
            end: point,
          };
        } else if (activeTool === "circle") {
          const cx = (start.x + point.x) / 2;
          const cy = (start.y + point.y) / 2;
          const rx = Math.abs(point.x - start.x) / 2;
          const ry = Math.abs(point.y - start.y) / 2;
          preview = {
            tool: "circle",
            color: activeColor,
            width: lineWidth,
            opacity,
            center: { x: cx, y: cy },
            radiusX: rx,
            radiusY: ry,
          };
        }
        currentStrokeRef.current = preview;
        redrawAll(preview);
      }
    },
    [activeTool, activeColor, opacity, getLineWidth, redrawAll],
  );

  const onPointerUp = useCallback(
    (e: PointerEvent<HTMLCanvasElement>) => {
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

      if (activeTool === "pencil" || activeTool === "eraser") {
        finalStroke = currentStrokeRef.current;
      } else if (start) {
        if (activeTool === "line") {
          finalStroke = {
            tool: "line",
            color: activeColor,
            width: lineWidth,
            opacity,
            start,
            end: point,
          };
        } else if (activeTool === "rect") {
          finalStroke = {
            tool: "rect",
            color: activeColor,
            width: lineWidth,
            opacity,
            start,
            end: point,
          };
        } else if (activeTool === "circle") {
          const cx = (start.x + point.x) / 2;
          const cy = (start.y + point.y) / 2;
          const rx = Math.abs(point.x - start.x) / 2;
          const ry = Math.abs(point.y - start.y) / 2;
          finalStroke = {
            tool: "circle",
            color: activeColor,
            width: lineWidth,
            opacity,
            center: { x: cx, y: cy },
            radiusX: rx,
            radiusY: ry,
          };
        }
      }

      if (finalStroke) {
        strokesRef.current.push(finalStroke);
        redoStackRef.current = [];
        redrawAll();
        updateHistoryState();
      }

      currentStrokeRef.current = null;
      startPointRef.current = null;
    },
    [
      activeTool,
      activeColor,
      opacity,
      getLineWidth,
      redrawAll,
      updateHistoryState,
    ],
  );

  const onPointerCancel = useCallback(
    (e: PointerEvent<HTMLCanvasElement>) => {
      drawingRef.current = false;
      currentStrokeRef.current = null;
      startPointRef.current = null;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // May already be released
      }
      redrawAll();
    },
    [redrawAll],
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
    initCanvas,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onPointerLeave: onPointerCancel,
  };
}
