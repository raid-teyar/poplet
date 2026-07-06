export type Tab =
  | "history"
  | "emoji"
  | "gif"
  | "notes"
  | "projects"
  | "vault"
  | "settings";

export interface VaultEntry {
  id: number;
  label: string;
  username: string;
  secret: string;
  url: string;
  notes: string;
  category: string;
  updated_at: string;
}

/** The (non-secret) metadata persisted so the vault can be unlocked later. */
export interface VaultMeta {
  salt: string;
  verifier: string;
  mem_kib: number;
  iters: number;
  parallelism: number;
}

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
  snipSmoothing: boolean;
  snipSketch: boolean;
  showPageNumbers: boolean;
}

export interface HistoryItem {
  id: number;
  content: string;
  image_path: string | null;
  timestamp: string;
  project_id: number | null;
}

export type NoteType = "note" | "image" | "project";

export interface NoteItem {
  id: number;
  title: string;
  body: string;
  updated_at: string;
  type: NoteType;
  /** For image notes: the image the pin is anchored to. */
  image_path: string | null;
  /** Normalized pin position (0..1) within the anchored image. */
  pin_x: number | null;
  pin_y: number | null;
  /** 1 while the note is an unfinished draft. */
  draft: number;
  /** Library project this note belongs to, or null. */
  project_id: number | null;
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

export type EditorSource = "snip" | "import" | "blank";

export interface SnipEditorState extends CapturedImage {
  src: string;
  source: EditorSource;
}

export interface BlankCanvasOptions {
  width: number;
  height: number;
  color: string;
}

export interface EditorPage extends SnipEditorState {
  id: number;
  strokes: Stroke[];
}

// ─── Drawing Engine Types ──────────────────────────────────────────────

// "select" is an interaction mode (no stroke); "triangle" is produced by
// recognition only — neither is ever stored as a freehand/shape stroke tool.
export type DrawingTool =
  | "select"
  | "pencil"
  | "eraser"
  | "line"
  | "rect"
  | "diamond"
  | "circle"
  | "arrow"
  | "triangle"
  | "text"
  | "redact"
  | "image"
  | "pin";

export interface StrokeBase {
  tool: DrawingTool;
  color: string;
  width: number;
  opacity: number;
  /** Optional custom layer name; falls back to a generated "Tool N" label. */
  name?: string;
  /** Strokes sharing a groupId are selected and transformed together. */
  groupId?: number;
  /** Hidden strokes are not painted, exported, or hit-tested on the canvas. */
  hidden?: boolean;
  /** Locked strokes cannot be selected, moved, or deleted from the canvas. */
  locked?: boolean;
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

export interface DiamondStroke extends StrokeBase {
  tool: "diamond";
  start: { x: number; y: number };
  end: { x: number; y: number };
}

export interface CircleStroke extends StrokeBase {
  tool: "circle";
  center: { x: number; y: number };
  radiusX: number;
  radiusY: number;
}

export interface ArrowStroke extends StrokeBase {
  tool: "arrow";
  start: { x: number; y: number };
  end: { x: number; y: number };
}

export interface TriangleStroke extends StrokeBase {
  tool: "triangle";
  a: { x: number; y: number };
  b: { x: number; y: number };
  c: { x: number; y: number };
}

export interface TextStroke extends StrokeBase {
  tool: "text";
  x: number;
  y: number;
  text: string;
  fontSize: number;
}

export interface RedactStroke extends StrokeBase {
  tool: "redact";
  start: { x: number; y: number };
  end: { x: number; y: number };
}

export interface ImageStroke extends StrokeBase {
  tool: "image";
  /** PNG/JPEG data URL, embedded so it travels inside the project file. */
  src: string;
  start: { x: number; y: number };
  end: { x: number; y: number };
}

export type Stroke =
  | FreehandStroke
  | LineStroke
  | RectStroke
  | DiamondStroke
  | CircleStroke
  | ArrowStroke
  | TriangleStroke
  | TextStroke
  | RedactStroke
  | ImageStroke;

// ─── File Detection ────────────────────────────────────────────────────

export interface DetectedFile {
  path: string;
  filename: string;
  extension: string;
}
