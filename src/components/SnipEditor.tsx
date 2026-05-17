import { useState, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Circle,
  Eraser,
  Minus,
  Pencil,
  Redo2,
  RotateCcw,
  Save,
  Square,
  Undo2,
  X,
} from "lucide-react";
import { useDrawingEngine, SNIP_COLORS } from "../hooks/useDrawingEngine";
import type { CapturedImage, DrawingTool, SnipEditorState } from "../types";

export type { SnipEditorState };

const TOOLS: { tool: DrawingTool; icon: typeof Pencil; label: string }[] = [
  { tool: "pencil", icon: Pencil, label: "Pencil" },
  { tool: "eraser", icon: Eraser, label: "Eraser" },
  { tool: "line", icon: Minus, label: "Line" },
  { tool: "rect", icon: Square, label: "Rectangle" },
  { tool: "circle", icon: Circle, label: "Circle" },
];

interface SnipEditorProps {
  editor: SnipEditorState;
  pencilWidth: number;
  onSave: (savedPath: string) => void;
  onCancel: () => void;
}

const MIN_STROKE_WIDTH = 0.1;
const MAX_STROKE_WIDTH = 8;

export default function SnipEditor({
  editor,
  pencilWidth,
  onSave,
  onCancel,
}: SnipEditorProps) {
  const [snipSaving, setSnipSaving] = useState(false);
  const [snipError, setSnipError] = useState("");
  const [strokeWidth, setStrokeWidth] = useState(pencilWidth);

  const snipCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const engine = useDrawingEngine({
    canvasRef: snipCanvasRef,
    pencilWidth: strokeWidth,
  });

  const canvasCursor = useMemo(() => {
    const size = Math.max(8, Math.round(strokeWidth * 10));
    const half = size / 2;
    const color = encodeURIComponent(engine.activeColor);

    if (engine.activeTool === "pencil") {
      // Filled circle in active color
      const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}'><circle cx='${half}' cy='${half}' r='${half - 1}' fill='${color}' stroke='white' stroke-width='0.5'/></svg>`;
      return `url("data:image/svg+xml,${svg}") ${half} ${half}, crosshair`;
    }
    if (engine.activeTool === "eraser") {
      // Dashed circle outline for eraser
      const r = Math.max(6, Math.round(strokeWidth * 12));
      const rh = r / 2;
      const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${r}' height='${r}'><circle cx='${rh}' cy='${rh}' r='${rh - 1}' fill='none' stroke='white' stroke-width='1.5' stroke-dasharray='3 2'/></svg>`;
      return `url("data:image/svg+xml,${svg}") ${rh} ${rh}, crosshair`;
    }
    // Shapes: crosshair with color accent
    const s = 20;
    const sh = 10;
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${s}' height='${s}'><line x1='${sh}' y1='0' x2='${sh}' y2='${s}' stroke='white' stroke-width='1'/><line x1='0' y1='${sh}' x2='${s}' y2='${sh}' stroke='white' stroke-width='1'/><circle cx='${sh}' cy='${sh}' r='2' fill='${color}'/></svg>`;
    return `url("data:image/svg+xml,${svg}") ${sh} ${sh}, crosshair`;
  }, [engine.activeTool, engine.activeColor, strokeWidth]);

  const handleSave = async () => {
    const drawing = snipCanvasRef.current;
    if (!drawing) return;
    setSnipSaving(true);
    setSnipError("");
    try {
      const saved = await invoke<CapturedImage>("save_annotated_image", {
        basePath: editor.path,
        drawingDataUrl: drawing.toDataURL("image/png"),
      });
      onSave(saved.path);
    } catch (err) {
      setSnipError(String(err));
    } finally {
      setSnipSaving(false);
    }
  };

  return (
    <div className="modal-backdrop snip-backdrop">
      <div className="snip-modal">
        <div className="modal-header">
          <strong>Snip</strong>
          <div className="snip-toolbar">
            <div className="snip-tools">
              {TOOLS.map(({ tool, icon: Icon, label }) => (
                <button
                  key={tool}
                  className={`snip-tool-btn ${engine.activeTool === tool ? "active" : ""}`}
                  onClick={() => engine.setActiveTool(tool)}
                  title={label}
                >
                  <Icon size={14} />
                </button>
              ))}
            </div>
            <div className="snip-colors" aria-label="Pencil color">
              {SNIP_COLORS.map((color) => (
                <button
                  key={color}
                  className={`snip-color ${engine.activeColor === color ? "active" : ""}`}
                  style={{ backgroundColor: color }}
                  onClick={() => engine.setActiveColor(color)}
                  title={`Color ${color}`}
                />
              ))}
            </div>

            <div className="snip-history-btns">
              <button
                className="snip-tool-btn"
                onClick={engine.undo}
                disabled={!engine.canUndo}
                title="Undo"
              >
                <Undo2 size={14} />
              </button>
              <button
                className="snip-tool-btn"
                onClick={engine.redo}
                disabled={!engine.canRedo}
                title="Redo"
              >
                <Redo2 size={14} />
              </button>
            </div>
            <button
              className="snip-tool-btn"
              onClick={engine.clearAll}
              title="Clear drawing"
            >
              <RotateCcw size={14} />
            </button>
            <button className="snip-tool-btn" onClick={onCancel} title="Cancel">
              <X size={14} />
            </button>
          </div>
        </div>
        {snipError && <p className="error-state">{snipError}</p>}
        <div className="snip-stage-wrapper">
          <div className="snip-stage">
            <div className="snip-layer">
              <img
                src={editor.src}
                alt="screen snip"
                onLoad={(event) => {
                  engine.initCanvas(
                    event.currentTarget.naturalWidth,
                    event.currentTarget.naturalHeight,
                  );
                }}
              />
              <canvas
                ref={snipCanvasRef}
                style={{ cursor: canvasCursor }}
                onPointerDown={engine.onPointerDown}
                onPointerMove={engine.onPointerMove}
                onPointerUp={engine.onPointerUp}
                onPointerCancel={engine.onPointerCancel}
                onPointerLeave={engine.onPointerLeave}
              />
            </div>
          </div>
          <div className="snip-width-rail" aria-label="Stroke width">
            <span
              className="snip-width-dot"
              style={{
                width: `${Math.max(4, strokeWidth * 2.5)}px`,
                height: `${Math.max(4, strokeWidth * 2.5)}px`,
              }}
            />
            <input
              type="range"
              min={MIN_STROKE_WIDTH}
              max={MAX_STROKE_WIDTH}
              step={0.1}
              value={strokeWidth}
              onChange={(e) => setStrokeWidth(parseFloat(e.target.value))}
              title={`Width: ${strokeWidth.toFixed(1)}`}
            />
            <span
              className="snip-width-dot"
              style={{ width: "3px", height: "3px" }}
            />
          </div>
        </div>
        <div className="modal-actions">
          <span className="snip-meta">
            {editor.width} x {editor.height}
          </span>
          <button
            className="note-primary-button"
            onClick={handleSave}
            disabled={snipSaving}
          >
            <Save size={14} />
            {snipSaving ? "Saving" : "Copy"}
          </button>
        </div>
      </div>
    </div>
  );
}
