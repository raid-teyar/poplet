export type Tab = "history" | "emoji" | "gif" | "notes" | "settings";

export interface AppSettings {
  enableImagePreview: boolean;
  hoverPreviewDelayMs: number;
  preferredTab: Exclude<Tab, "settings">;
  giphyApiKey: string;
  historyLimit: number;
  hideOnBlurDelayMs: number;
  windowWidth: number;
  windowHeight: number;
  popletShortcut: string;
  snipShortcut: string;
  fullscreenShortcut: string;
  restoreWindowOnShow: boolean;
  snipPencilWidth: number;
}

export interface HistoryItem {
  id: number;
  content: string;
  image_path: string | null;
  timestamp: string;
}

export interface NoteItem {
  id: number;
  title: string;
  body: string;
  updated_at: string;
}

export type ClipboardEvent =
  | { kind: "text"; content: string }
  | { kind: "image"; path: string; width: number; height: number };

export interface ImagePreview {
  src: string;
  width: number;
  height: number;
}

export interface CapturedImage {
  path: string;
  width: number;
  height: number;
}

export interface ShortcutApplyResult {
  desktop: string;
  applied: boolean;
  message: string;
}

export interface SnipEditorState extends CapturedImage {
  src: string;
}

// ─── Drawing Engine Types ──────────────────────────────────────────────

export type DrawingTool = "pencil" | "eraser" | "line" | "rect" | "circle";

export interface StrokeBase {
  tool: DrawingTool;
  color: string;
  width: number;
  opacity: number;
}

export interface FreehandStroke extends StrokeBase {
  tool: "pencil" | "eraser";
  points: { x: number; y: number }[];
}

export interface LineStroke extends StrokeBase {
  tool: "line";
  start: { x: number; y: number };
  end: { x: number; y: number };
}

export interface RectStroke extends StrokeBase {
  tool: "rect";
  start: { x: number; y: number };
  end: { x: number; y: number };
}

export interface CircleStroke extends StrokeBase {
  tool: "circle";
  center: { x: number; y: number };
  radiusX: number;
  radiusY: number;
}

export type Stroke = FreehandStroke | LineStroke | RectStroke | CircleStroke;

// ─── File Detection ────────────────────────────────────────────────────

export interface DetectedFile {
  path: string;
  filename: string;
  extension: string;
}
