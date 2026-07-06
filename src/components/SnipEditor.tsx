import { useState, useRef, useMemo, useEffect } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Circle,
  Diamond,
  Download,
  Eraser,
  Feather,
  FileDown,
  FileUp,
  FolderPlus,
  Group,
  Hash,
  ImagePlus,
  Library,
  Maximize2,
  Minimize2,
  Minus,
  MousePointer2,
  PanelLeft,
  Pencil,
  Plus,
  Redo2,
  RotateCcw,
  Save,
  ScanText,
  MapPin,
  Sparkles,
  Square,
  Trash2,
  Type,
  Undo2,
  Ungroup,
  EyeOff,
  X,
} from "lucide-react";
import { useDrawingEngine, SNIP_COLORS, ERASER_RATIO } from "../hooks/useDrawingEngine";
import { preloadImage } from "../utils/paint";
import AssetsPanel from "./AssetsPanel";
import OcrPanel from "./OcrPanel";
import {
  extractTextFromImage,
  openProjectFile,
  saveProjectFile,
  type PopletProject,
} from "../services/editorService";
import type { ProjectListItem } from "../hooks/useProjects";
import { paintStrokes } from "../utils/paint";
import {
  Button,
  IconButton,
  Input,
  Textarea,
  Modal,
  ModalHeader,
} from "../ui";
import type {
  CapturedImage,
  DrawingTool,
  EditorPage,
  NoteItem,
  SnipEditorState,
} from "../types";

export type { SnipEditorState };

const TOOLS: { tool: DrawingTool; icon: typeof Pencil; label: string }[] = [
  {
    tool: "select",
    icon: MousePointer2,
    label: "Select / move / resize (drag a box or Shift-click for several)",
  },
  { tool: "pencil", icon: Pencil, label: "Pencil" },
  { tool: "eraser", icon: Eraser, label: "Eraser" },
  { tool: "line", icon: Minus, label: "Line" },
  { tool: "arrow", icon: ArrowUpRight, label: "Arrow" },
  { tool: "rect", icon: Square, label: "Rectangle" },
  { tool: "diamond", icon: Diamond, label: "Diamond" },
  { tool: "circle", icon: Circle, label: "Circle" },
  { tool: "text", icon: Type, label: "Text" },
  { tool: "redact", icon: EyeOff, label: "Redact (hide)" },
  { tool: "pin", icon: MapPin, label: "Pin a note" },
];

interface SnipEditorProps {
  editor: SnipEditorState;
  pencilWidth: number;
  smoothing: boolean;
  sketch: boolean;
  showPageNumbers: boolean;
  notes: NoteItem[];
  libraryProjects: ProjectListItem[];
  /** When opening an existing project: its materialized pages, group names,
   *  and id (so saving can update it in place). */
  initialPages?: EditorPage[];
  initialGroupNames?: Record<number, string>;
  initialProjectId?: number | null;
  initialProjectName?: string;
  onSaveToLibrary: (name: string, data: string) => Promise<void>;
  onUpdateProject: (id: number, data: string) => Promise<void>;
  onGetProject: (id: number) => Promise<string | null>;
  onDeleteProject: (id: number) => void;
  onToggleSmoothing: (next: boolean) => void;
  onToggleSketch: (next: boolean) => void;
  onTogglePageNumbers: (next: boolean) => void;
  onCreateImageNote: (
    imagePath: string,
    pinX: number,
    pinY: number,
    title: string,
    body: string,
  ) => void;
  onSaveNote: (title: string, body: string, id: number) => void;
  onDeleteNote: (id: number) => void;
  onSave: (savedPath: string) => void;
  onCancel: () => void;
}

/// Draw a page number centered at the bottom, with a light halo so it reads on
/// both bright and dark backgrounds. Used for the live overlay and export.
function drawPageNumber(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  label: string,
) {
  const fontSize = Math.max(14, Math.round(width * 0.016));
  ctx.save();
  ctx.font = `600 ${fontSize}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  const x = width / 2;
  const y = height - Math.max(12, Math.round(height * 0.025));
  ctx.lineWidth = Math.max(2, fontSize * 0.18);
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.strokeText(label, x, y);
  ctx.fillStyle = "rgba(20,20,20,0.85)";
  ctx.fillText(label, x, y);
  ctx.restore();
}

const MIN_STROKE_WIDTH = 0.1;
const MAX_STROKE_WIDTH = 8;

// Surfaced so the whole toolbar can be driven from the keyboard instead of
// clicking. These mirror the handlers in the editor keydown effect.
const ARENA_HINTS: { keys: string; label: string }[] = [
  { keys: "V", label: "select" },
  { keys: "P", label: "pencil" },
  { keys: "T", label: "text" },
  { keys: "⌘Z", label: "undo" },
  { keys: "⌘D", label: "duplicate" },
  { keys: "⌘G", label: "group" },
  { keys: "Del", label: "remove" },
  { keys: "⌘S", label: "save" },
  { keys: "Esc", label: "close" },
];

export default function SnipEditor({
  editor,
  pencilWidth,
  smoothing,
  sketch,
  showPageNumbers,
  notes,
  libraryProjects,
  initialPages,
  initialGroupNames,
  initialProjectId,
  initialProjectName,
  onSaveToLibrary,
  onUpdateProject,
  onGetProject,
  onDeleteProject,
  onToggleSmoothing,
  onToggleSketch,
  onTogglePageNumbers,
  onCreateImageNote,
  onSaveNote,
  onDeleteNote,
  onSave,
  onCancel,
}: SnipEditorProps) {
  const [snipSaving, setSnipSaving] = useState(false);
  const [snipError, setSnipError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState("");
  const [strokeWidth, setStrokeWidth] = useState(pencilWidth);
  const [strokeOpacity, setStrokeOpacity] = useState(1);

  const [ocrOpen, setOcrOpen] = useState(false);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrText, setOcrText] = useState("");
  const [ocrError, setOcrError] = useState("");
  const [ocrCopied, setOcrCopied] = useState(false);

  // ─── Pages ───────────────────────────────────────────────────────────
  const hasInitial = !!initialPages && initialPages.length > 0;
  const [pages, setPages] = useState<EditorPage[]>(() =>
    hasInitial ? initialPages! : [{ id: 0, ...editor, strokes: [] }],
  );
  const [current, setCurrent] = useState(0);
  const [addingPage, setAddingPage] = useState(false);
  const [showAssets, setShowAssets] = useState(true);
  const [actualSize, setActualSize] = useState(false);
  const [applyingCanvas, setApplyingCanvas] = useState(false);
  const [projectBusy, setProjectBusy] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);
  const [librarySearch, setLibrarySearch] = useState("");
  // The library project this session is editing (open → save updates it).
  const [projectId, setProjectId] = useState<number | null>(
    initialProjectId ?? null,
  );
  const [projectName, setProjectName] = useState(initialProjectName ?? "");
  const nextIdRef = useRef(
    hasInitial ? Math.max(...initialPages!.map((p) => p.id)) + 1 : 1,
  );

  // Refs mirror state so the image onLoad callback (which fires after commit)
  // always reads the page it just switched to.
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const currentRef = useRef(current);
  currentRef.current = current;

  const snipCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const layerRef = useRef<HTMLDivElement | null>(null);
  const textInputRef = useRef<HTMLTextAreaElement | null>(null);
  // True once the text box has actually received focus, so the spurious blur
  // fired during the placing click doesn't dismiss it before you can type.
  const textReadyRef = useRef(false);
  // True while a text/pin overlay is open — keystrokes must not become tool
  // shortcuts even if focus briefly leaves the input.
  const overlayOpenRef = useRef(false);

  const [textDraft, setTextDraft] = useState<{
    x: number;
    y: number;
    index: number | null;
    value: string;
    fontSize: number;
  } | null>(null);

  // Pin note editor: id null = creating a new pin, otherwise editing one.
  const [pinEditor, setPinEditor] = useState<{
    id: number | null;
    pinX: number;
    pinY: number;
    title: string;
    body: string;
  } | null>(null);

  const page = pages[current];
  overlayOpenRef.current = !!textDraft || !!pinEditor;

  // Warm the image cache for every page's inserted images so multi-page export
  // (which renders pages you may not have visited) always includes them.
  useEffect(() => {
    for (const p of pages) {
      for (const s of p.strokes) {
        if (s.tool === "image") preloadImage(s.src, () => {});
      }
    }
  }, [pages]);

  const engine = useDrawingEngine({
    canvasRef: snipCanvasRef,
    pencilWidth: strokeWidth,
    opacity: strokeOpacity,
    smoothing,
    sketch,
    onTextTool: (req) => setTextDraft({ ...req }),
    onPinTool: ({ x, y }) =>
      setPinEditor({
        id: null,
        pinX: x / page.width,
        pinY: y / page.height,
        title: "",
        body: "",
      }),
  });

  // Reliably focus the text box after paint (autoFocus alone can miss on a
  // freshly-mounted overlay in WebKitGTK); select existing text when editing.
  useEffect(() => {
    if (!textDraft) return;
    textReadyRef.current = false;
    const id = requestAnimationFrame(() => {
      const el = textInputRef.current;
      if (el) {
        el.focus();
        el.select();
      }
      textReadyRef.current = true;
    });
    return () => cancelAnimationFrame(id);
  }, [textDraft?.x, textDraft?.y, textDraft?.index]);

  // Restore group names once when opening an existing project.
  useEffect(() => {
    if (initialGroupNames && Object.keys(initialGroupNames).length) {
      engine.restoreGroups(initialGroupNames);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const commitText = () => {
    if (!textDraft) return;
    if (textDraft.index === null) {
      engine.addText(textDraft.x, textDraft.y, textDraft.value, textDraft.fontSize);
    } else {
      engine.updateText(textDraft.index, textDraft.value);
    }
    setTextDraft(null);
  };

  // Image-anchored note pins for the current page.
  const pins = notes.filter(
    (n) =>
      n.type === "image" &&
      n.image_path === page.path &&
      n.pin_x != null &&
      n.pin_y != null,
  );

  const commitPin = () => {
    if (!pinEditor) return;
    const title = pinEditor.title.trim();
    const body = pinEditor.body.trim();
    if (!title && !body) {
      setPinEditor(null);
      return;
    }
    if (pinEditor.id === null) {
      onCreateImageNote(page.path, pinEditor.pinX, pinEditor.pinY, title || "Pin", body);
    } else {
      onSaveNote(title || "Pin", body, pinEditor.id);
    }
    setPinEditor(null);
  };

  const canvasCursor = useMemo(() => {
    const size = Math.max(8, Math.round(strokeWidth * 10));
    const half = size / 2;
    const color = encodeURIComponent(engine.activeColor);

    if (engine.activeTool === "select") {
      return engine.selectionCount > 0 ? "move" : "default";
    }
    if (engine.activeTool === "text") return "text";
    if (engine.activeTool === "pin") return "crosshair";
    if (engine.activeTool === "pencil") {
      const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}'><circle cx='${half}' cy='${half}' r='${half - 1}' fill='${color}' stroke='white' stroke-width='0.5'/></svg>`;
      return `url("data:image/svg+xml,${svg}") ${half} ${half}, crosshair`;
    }
    if (engine.activeTool === "eraser") {
      // Match the 5× footprint (clamped to the browser's custom-cursor limit).
      const r = Math.min(120, Math.max(12, Math.round(strokeWidth * 10 * ERASER_RATIO)));
      const rh = r / 2;
      // Dark backing ring + white dashes so the eraser is visible on both
      // light and dark backgrounds.
      const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${r}' height='${r}'><circle cx='${rh}' cy='${rh}' r='${rh - 1.5}' fill='none' stroke='black' stroke-width='2.5'/><circle cx='${rh}' cy='${rh}' r='${rh - 1.5}' fill='none' stroke='white' stroke-width='1.2' stroke-dasharray='3 2'/></svg>`;
      return `url("data:image/svg+xml,${svg}") ${rh} ${rh}, crosshair`;
    }
    const s = 20;
    const sh = 10;
    // Black backing under the white crosshair so it reads on white backgrounds.
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${s}' height='${s}'><line x1='${sh}' y1='0' x2='${sh}' y2='${s}' stroke='black' stroke-width='2.5'/><line x1='0' y1='${sh}' x2='${s}' y2='${sh}' stroke='black' stroke-width='2.5'/><line x1='${sh}' y1='0' x2='${sh}' y2='${s}' stroke='white' stroke-width='1'/><line x1='0' y1='${sh}' x2='${s}' y2='${sh}' stroke='white' stroke-width='1'/><circle cx='${sh}' cy='${sh}' r='2' fill='${color}'/></svg>`;
    return `url("data:image/svg+xml,${svg}") ${sh} ${sh}, crosshair`;
  }, [engine.activeTool, engine.activeColor, engine.selectionCount, strokeWidth]);

  // Editor keyboard shortcuts: undo/redo, group/ungroup, delete.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT")) {
        return;
      }
      // A text/pin overlay is open — don't let stray keys become tool
      // shortcuts (focus may have briefly left the input).
      if (overlayOpenRef.current) return;
      // Escape steps a drilled-in selection back up to its group, then
      // deselects — only falling through to close the editor when nothing is
      // selected. Runs in capture phase so it pre-empts the global handler.
      if (e.key === "Escape") {
        if (engine.selectionCount > 0) {
          e.preventDefault();
          e.stopImmediatePropagation();
          engine.escapeSelection();
        }
        return;
      }

      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      if (mod && key === "z") {
        e.preventDefault();
        if (e.shiftKey) engine.redo();
        else engine.undo();
        return;
      }
      if (mod && key === "y") {
        e.preventDefault();
        engine.redo();
        return;
      }
      if (mod && key === "g") {
        e.preventDefault();
        if (e.shiftKey) engine.ungroupSelected();
        else engine.groupSelected();
        return;
      }
      if (mod && key === "d") {
        e.preventDefault();
        engine.duplicateSelected();
        return;
      }
      if (mod && key === "a") {
        e.preventDefault();
        engine.selectAll();
        return;
      }
      if (mod && key === "s") {
        e.preventDefault();
        saveToLibrary();
        return;
      }
      if (engine.selectionCount > 0 && (e.key === "Delete" || e.key === "Backspace")) {
        e.preventDefault();
        engine.deleteSelected();
        return;
      }

      // Single-key tool shortcuts (ignored while a modifier is held).
      if (mod || e.altKey) return;
      const toolKeys: Record<string, DrawingTool> = {
        v: "select",
        p: "pencil",
        e: "eraser",
        l: "line",
        a: "arrow",
        r: "rect",
        d: "diamond",
        o: "circle",
        t: "text",
        x: "redact",
        n: "pin",
      };
      if (toolKeys[key]) {
        e.preventDefault();
        engine.setActiveTool(toolKeys[key]);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [engine]);

  // Persist the live strokes of the current page back into state.
  const captureCurrentStrokes = (list: EditorPage[]) =>
    list.map((p, i) =>
      i === currentRef.current ? { ...p, strokes: engine.getStrokes() } : p,
    );

  const goToPage = (idx: number) => {
    if (idx === current || idx < 0 || idx >= pages.length) return;
    engine.deselect();
    setPages((prev) => captureCurrentStrokes(prev));
    setCurrent(idx);
  };

  const addPage = async () => {
    setSnipError("");
    engine.deselect();
    setAddingPage(true);
    try {
      const created = await invoke<CapturedImage>("create_blank_canvas", {
        width: page.width,
        height: page.height,
        color: "#ffffff",
      });
      const id = nextIdRef.current++;
      const newIndex = pages.length;
      setPages((prev) => [
        ...captureCurrentStrokes(prev),
        {
          id,
          ...created,
          src: convertFileSrc(created.path),
          source: "blank",
          strokes: [],
        },
      ]);
      setCurrent(newIndex);
    } catch (err) {
      setSnipError(String(err));
    } finally {
      setAddingPage(false);
    }
  };

  // Resize the current page and repaint its background, keeping the drawings.
  const applyCanvas = async (width: number, height: number, color: string) => {
    setSnipError("");
    setApplyingCanvas(true);
    try {
      const created = await invoke<CapturedImage>("create_blank_canvas", {
        width: Math.round(width),
        height: Math.round(height),
        color,
      });
      const keptStrokes = engine.getStrokes();
      setPages((prev) =>
        prev.map((p, i) =>
          i === current
            ? {
                ...p,
                path: created.path,
                src: convertFileSrc(created.path),
                width: created.width,
                height: created.height,
                source: "blank",
                strokes: keptStrokes,
              }
            : p,
        ),
      );
    } catch (err) {
      setSnipError(String(err));
    } finally {
      setApplyingCanvas(false);
    }
  };

  const handleSave = async () => {
    const drawing = snipCanvasRef.current;
    if (!drawing) return;
    // Clear selection chrome so it isn't baked into the saved PNG.
    engine.deselect();
    setSnipSaving(true);
    setSnipError("");
    try {
      const saved = await invoke<CapturedImage>("save_annotated_image", {
        basePath: page.path,
        drawingDataUrl: drawing.toDataURL("image/png"),
      });
      onSave(saved.path);
    } catch (err) {
      setSnipError(String(err));
    } finally {
      setSnipSaving(false);
    }
  };

  // Render one page's strokes (plus optional page number) onto a transparent
  // offscreen canvas and return it as a PNG data URL for compositing in Rust.
  const renderPageDrawing = (p: EditorPage, index: number, total: number) => {
    const off = document.createElement("canvas");
    off.width = p.width;
    off.height = p.height;
    const ctx = off.getContext("2d");
    if (!ctx) return "";
    paintStrokes(ctx, p.strokes, smoothing, sketch);
    if (showPageNumbers) {
      drawPageNumber(ctx, p.width, p.height, `${index + 1} / ${total}`);
    }
    return off.toDataURL("image/png");
  };

  const exportAll = async () => {
    setSnipError("");
    setExportMsg("");
    const allPages = captureCurrentStrokes(pages);
    let dir: string | null = null;
    try {
      const picked = await open({ directory: true, multiple: false });
      dir = typeof picked === "string" ? picked : null;
    } catch (err) {
      setSnipError(String(err));
      return;
    }
    if (!dir) return;
    setExporting(true);
    try {
      const payload = allPages.map((p, i) => ({
        basePath: p.path,
        drawingDataUrl: renderPageDrawing(p, i, allPages.length),
      }));
      const count = await invoke<number>("export_pages", { dir, pages: payload });
      setExportMsg(`Exported ${count} page${count === 1 ? "" : "s"}`);
      setTimeout(() => setExportMsg(""), 2500);
    } catch (err) {
      setSnipError(String(err));
    } finally {
      setExporting(false);
    }
  };

  // Serialize all pages (base images embedded as data URLs) + groups to a file.
  // Serialize the current session (pages + base images + strokes + groups).
  const buildProject = async (): Promise<PopletProject> => {
    const all = captureCurrentStrokes(pages);
    const projectPages = await Promise.all(
      all.map(async (p) => ({
        width: p.width,
        height: p.height,
        base: await invoke<string>("read_image_as_data_url", { path: p.path }),
        strokes: p.strokes,
      })),
    );
    return { version: 1, groupNames: engine.groupNames, pages: projectPages };
  };

  // Rebuild editor pages from a project (used by file-open and library-open).
  const loadProjectData = async (project: PopletProject) => {
    const startId = nextIdRef.current;
    const loaded = await Promise.all(
      project.pages.map(async (p, idx) => {
        const created = await invoke<CapturedImage>("save_data_url_image", {
          dataUrl: p.base,
        });
        return {
          id: startId + idx,
          path: created.path,
          src: convertFileSrc(created.path),
          width: created.width,
          height: created.height,
          source: "import" as const,
          strokes: p.strokes ?? [],
        };
      }),
    );
    if (!loaded.length) return;
    nextIdRef.current = startId + loaded.length;
    engine.restoreGroups(project.groupNames ?? {});
    engine.deselect();
    setCurrent(0);
    setPages(loaded);
  };

  const saveProject = async () => {
    setSnipError("");
    setProjectBusy(true);
    try {
      const ok = await saveProjectFile(await buildProject());
      if (ok) {
        setExportMsg("Project saved");
        setTimeout(() => setExportMsg(""), 2500);
      }
    } catch (err) {
      setSnipError(String(err));
    } finally {
      setProjectBusy(false);
    }
  };

  const loadProject = async () => {
    setSnipError("");
    setProjectBusy(true);
    try {
      const project = await openProjectFile();
      if (project) await loadProjectData(project);
    } catch (err) {
      setSnipError(String(err));
    } finally {
      setProjectBusy(false);
    }
  };

  const saveToLibrary = async () => {
    setSnipError("");
    setProjectBusy(true);
    try {
      const data = JSON.stringify(await buildProject());
      if (projectId !== null) {
        await onUpdateProject(projectId, data);
        setExportMsg("Project updated");
      } else {
        await onSaveToLibrary(`Project ${new Date().toLocaleString()}`, data);
        setExportMsg("Saved to library");
      }
      setTimeout(() => setExportMsg(""), 2500);
    } catch (err) {
      setSnipError(String(err));
    } finally {
      setProjectBusy(false);
    }
  };

  const openFromLibrary = async (id: number) => {
    setShowLibrary(false);
    setProjectBusy(true);
    try {
      const data = await onGetProject(id);
      if (data) {
        await loadProjectData(JSON.parse(data) as PopletProject);
        setProjectId(id); // subsequent saves update this project
        setProjectName(
          libraryProjects.find((p) => p.id === id)?.name ?? "Project",
        );
      }
    } catch (err) {
      setSnipError(String(err));
    } finally {
      setProjectBusy(false);
    }
  };

  const insertImage = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [
          {
            name: "Image",
            extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"],
          },
        ],
      });
      if (!selected || typeof selected !== "string") return;
      const dataUrl = await invoke<string>("read_image_as_data_url", {
        path: selected,
      });
      engine.addImage(dataUrl);
    } catch (err) {
      setSnipError(String(err));
    }
  };

  const runOcr = async () => {
    setOcrOpen(true);
    setOcrLoading(true);
    setOcrError("");
    setOcrCopied(false);
    try {
      const text = await extractTextFromImage(page.path);
      setOcrText(text);
    } catch (err) {
      setOcrError(String(err));
      setOcrText("");
    } finally {
      setOcrLoading(false);
    }
  };

  const copyOcr = async () => {
    if (!ocrText) return;
    await writeText(ocrText);
    setOcrCopied(true);
    setTimeout(() => setOcrCopied(false), 1500);
  };

  return (
    <div className="modal-backdrop snip-backdrop">
      <div className="snip-modal">
        <div className="modal-header">
          <strong className="snip-title">
            {projectId !== null ? (
              <>
                <span className="snip-project-dot" />
                {projectName || "Project"}
              </>
            ) : (
              <span className="snip-title-untitled">Untitled project</span>
            )}
          </strong>
          <div className="snip-toolbar">
            <button
              className={`snip-tool-btn ${showAssets ? "active" : ""}`}
              onClick={() => setShowAssets((v) => !v)}
              title="Toggle layers panel"
            >
              <PanelLeft size={14} />
            </button>
            <button
              className={`snip-tool-btn ${actualSize ? "active" : ""}`}
              onClick={() => setActualSize((v) => !v)}
              title={actualSize ? "Fit to screen" : "Actual size (scroll)"}
            >
              {actualSize ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
            <span className="snip-sep" />
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

            <button
              className={`snip-tool-btn ${smoothing ? "active" : ""}`}
              onClick={() => onToggleSmoothing(!smoothing)}
              title={
                smoothing
                  ? "Snap to shapes: on (freehand lines/arrows/triangles/circles/rectangles are cleaned up)"
                  : "Snap to shapes: off"
              }
            >
              <Sparkles size={14} />
            </button>
            <button
              className={`snip-tool-btn ${sketch ? "active" : ""}`}
              onClick={() => onToggleSketch(!sketch)}
              title={
                sketch
                  ? "Draw as sketch: on (shapes and text render hand-drawn, Excalidraw-style)"
                  : "Draw as sketch: off"
              }
            >
              <Feather size={14} />
            </button>
            <button
              className={`snip-tool-btn ${showPageNumbers ? "active" : ""}`}
              onClick={() => onTogglePageNumbers(!showPageNumbers)}
              title="Show page numbers"
            >
              <Hash size={14} />
            </button>

            <span className="snip-sep" />
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
              onClick={engine.groupSelected}
              disabled={!engine.canGroup}
              title="Group (Ctrl/Cmd+G)"
            >
              <Group size={14} />
            </button>
            <button
              className="snip-tool-btn"
              onClick={engine.ungroupSelected}
              disabled={!engine.canUngroup}
              title="Ungroup (Ctrl/Cmd+Shift+G)"
            >
              <Ungroup size={14} />
            </button>
            <button
              className="snip-tool-btn"
              onClick={engine.deleteSelected}
              disabled={engine.selectionCount === 0}
              title="Delete selected (Del)"
            >
              <Trash2 size={14} />
            </button>
            <button
              className="snip-tool-btn"
              onClick={engine.clearAll}
              title="Clear drawing"
            >
              <RotateCcw size={14} />
            </button>
            <span className="snip-sep" />
            <button
              className="snip-tool-btn"
              onClick={insertImage}
              title="Insert an image onto the canvas"
            >
              <ImagePlus size={14} />
            </button>
            <button
              className={`snip-tool-btn ${ocrOpen ? "active" : ""}`}
              onClick={runOcr}
              title="Extract text (OCR)"
            >
              <ScanText size={14} />
            </button>
            <button
              className="snip-tool-btn"
              onClick={exportAll}
              disabled={exporting}
              title="Export all pages to a folder"
            >
              <Download size={14} />
            </button>
            <button
              className="snip-tool-btn"
              onClick={saveProject}
              disabled={projectBusy}
              title="Save project to a file"
            >
              <FileDown size={14} />
            </button>
            <button
              className="snip-tool-btn"
              onClick={loadProject}
              disabled={projectBusy}
              title="Open a project file"
            >
              <FileUp size={14} />
            </button>
            <button
              className="snip-tool-btn"
              onClick={saveToLibrary}
              disabled={projectBusy}
              title={projectId !== null ? "Update this project" : "Save project to library"}
            >
              <FolderPlus size={14} />
            </button>
            <button
              className="snip-tool-btn"
              onClick={() => setShowLibrary(true)}
              title="Open from library"
            >
              <Library size={14} />
            </button>
            <button className="snip-tool-btn" onClick={onCancel} title="Cancel">
              <X size={14} />
            </button>
          </div>
        </div>
        {snipError && <p className="error-state">{snipError}</p>}
        <div className="snip-opacity-rail" aria-label="Stroke opacity">
          <span className="snip-opacity-label">Opacity</span>
          <input
            type="range"
            min={0.05}
            max={1}
            step={0.05}
            value={strokeOpacity}
            onChange={(e) => setStrokeOpacity(parseFloat(e.target.value))}
            title={`Opacity: ${Math.round(strokeOpacity * 100)}%`}
          />
          <span className="snip-opacity-value">
            {Math.round(strokeOpacity * 100)}%
          </span>
        </div>
        <div className="snip-body">
          {showAssets && (
            <AssetsPanel
              strokes={engine.getStrokes()}
              selectedIndices={engine.selectedIndices}
              groupNames={engine.groupNames}
              onSelect={(index, additive) =>
                engine.selectStrokes([index], additive)
              }
              onSelectMany={(indices) => engine.selectStrokes(indices, false)}
              onSetHidden={engine.setHidden}
              onSetLocked={engine.setLocked}
              onRenameGroup={engine.renameGroup}
              onRenameStroke={engine.renameStroke}
              onGroup={engine.groupSelected}
              onUngroup={engine.ungroupSelected}
              onDuplicate={engine.duplicateSelected}
              onMove={engine.moveSelected}
              onDelete={engine.deleteSelected}
              canGroup={engine.canGroup}
              canUngroup={engine.canUngroup}
              selectionCount={engine.selectionCount}
              canvasWidth={page.width}
              canvasHeight={page.height}
              applying={applyingCanvas}
              onApplyCanvas={applyCanvas}
            />
          )}
          <div className="snip-stage-wrapper">
            <div className={`snip-stage ${actualSize ? "actual" : ""}`}>
              <div
                ref={layerRef}
                className={`snip-layer ${actualSize ? "actual" : ""}`}
              >
                <img
                  // Fragment keeps the src unique per page so switching always
                  // re-fires onLoad even when two blank pages share a file.
                  src={`${page.src}#p${page.id}`}
                  alt="edit surface"
                  onLoad={(event) => {
                    engine.initCanvas(
                      event.currentTarget.naturalWidth,
                      event.currentTarget.naturalHeight,
                    );
                    engine.setStrokes(
                      pagesRef.current[currentRef.current]?.strokes ?? [],
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
                {showPageNumbers && (
                  <span className="snip-page-number">
                    {current + 1} / {pages.length}
                  </span>
                )}
                {textDraft && (
                  <textarea
                    ref={textInputRef}
                    className="text-draft"
                    autoFocus
                    value={textDraft.value}
                    style={{
                      left: `${(textDraft.x / page.width) * 100}%`,
                      top: `${(textDraft.y / page.height) * 100}%`,
                      fontSize: `${
                        textDraft.fontSize *
                        (layerRef.current
                          ? layerRef.current.clientWidth / page.width
                          : 1)
                      }px`,
                      color: engine.activeColor,
                    }}
                    onChange={(e) =>
                      setTextDraft({ ...textDraft, value: e.target.value })
                    }
                    onBlur={() => {
                      // Ignore the spurious blur before the box has focused.
                      if (textReadyRef.current) commitText();
                    }}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        commitText();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        setTextDraft(null);
                      }
                    }}
                  />
                )}
                {pins.map((n, i) => (
                  <button
                    key={n.id}
                    className="pin-marker"
                    style={{
                      left: `${(n.pin_x ?? 0) * 100}%`,
                      top: `${(n.pin_y ?? 0) * 100}%`,
                    }}
                    title={n.title}
                    onClick={() =>
                      setPinEditor({
                        id: n.id,
                        pinX: n.pin_x ?? 0,
                        pinY: n.pin_y ?? 0,
                        title: n.title,
                        body: n.body,
                      })
                    }
                  >
                    {i + 1}
                  </button>
                ))}
                {pinEditor && (
                  <div
                    className="pin-popover"
                    style={{
                      left: `${pinEditor.pinX * 100}%`,
                      top: `${pinEditor.pinY * 100}%`,
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                  >
                    <Input
                      placeholder="Title"
                      autoFocus
                      value={pinEditor.title}
                      onChange={(e) =>
                        setPinEditor({ ...pinEditor, title: e.target.value })
                      }
                    />
                    <Textarea
                      placeholder="Note"
                      value={pinEditor.body}
                      onKeyDown={(e) => e.stopPropagation()}
                      onChange={(e) =>
                        setPinEditor({ ...pinEditor, body: e.target.value })
                      }
                    />
                    <div className="pin-popover-actions">
                      {pinEditor.id !== null && (
                        <IconButton
                          title="Delete note"
                          onClick={() => {
                            if (pinEditor.id !== null) onDeleteNote(pinEditor.id);
                            setPinEditor(null);
                          }}
                        >
                          <Trash2 size={13} />
                        </IconButton>
                      )}
                      <Button onClick={() => setPinEditor(null)}>Cancel</Button>
                      <Button
                        variant="primary"
                        icon={<Save size={13} />}
                        onClick={commitPin}
                      >
                        Save
                      </Button>
                    </div>
                  </div>
                )}
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

          {ocrOpen && (
            <OcrPanel
              text={ocrText}
              loading={ocrLoading}
              error={ocrError}
              copied={ocrCopied}
              onCopy={copyOcr}
              onClose={() => setOcrOpen(false)}
              onChangeText={setOcrText}
            />
          )}
        </div>
        <div className="snip-hints">
          {ARENA_HINTS.map((h, i) => (
            <span className="hint" key={i}>
              <kbd>{h.keys}</kbd>
              <span className="hint-label">{h.label}</span>
            </span>
          ))}
        </div>
        <div className="modal-actions">
          <div className="snip-pages" aria-label="Pages">
            <button
              className="snip-tool-btn"
              onClick={() => goToPage(current - 1)}
              disabled={current === 0}
              title="Previous page"
            >
              <ChevronLeft size={14} />
            </button>
            <span className="snip-page-indicator">
              {current + 1} / {pages.length}
            </span>
            <button
              className="snip-tool-btn"
              onClick={() => goToPage(current + 1)}
              disabled={current === pages.length - 1}
              title="Next page"
            >
              <ChevronRight size={14} />
            </button>
            <button
              className="snip-tool-btn"
              onClick={addPage}
              disabled={addingPage}
              title="Add page"
            >
              <Plus size={14} />
            </button>
            {exportMsg && <span className="snip-export-msg">{exportMsg}</span>}
          </div>
          <span className="snip-meta">
            {page.width} x {page.height}
          </span>
          {projectId !== null && (
            <Button
              icon={<FolderPlus size={14} />}
              onClick={saveToLibrary}
              disabled={projectBusy}
              title="Save into project (Ctrl+S)"
            >
              {projectBusy ? "Saving" : "Save"}
            </Button>
          )}
          <Button
            variant="primary"
            icon={<Save size={14} />}
            onClick={handleSave}
            disabled={snipSaving}
            title="Copy the flattened image to the clipboard"
          >
            {snipSaving ? "Saving" : "Copy"}
          </Button>
        </div>
      </div>

      {showLibrary && (
        <Modal onClose={() => setShowLibrary(false)}>
          <ModalHeader title="Project library" onClose={() => setShowLibrary(false)} />
          {libraryProjects.length === 0 ? (
            <p className="empty-state">No saved projects yet</p>
          ) : (
            <>
              <Input
                autoFocus
                placeholder="Search projects…"
                value={librarySearch}
                onChange={(e) => setLibrarySearch(e.target.value)}
              />
              <div className="notes-list">
                {libraryProjects
                  .filter((p) =>
                    p.name
                      .toLowerCase()
                      .includes(librarySearch.trim().toLowerCase()),
                  )
                  .map((p) => (
                    <div className="note-item library-row" key={p.id}>
                      <button
                        className="library-open"
                        onClick={() => openFromLibrary(p.id)}
                      >
                        <Library size={13} />
                        <span className="layer-name">{p.name}</span>
                      </button>
                      <IconButton
                        title="Delete project"
                        onClick={() => onDeleteProject(p.id)}
                      >
                        <Trash2 size={13} />
                      </IconButton>
                    </div>
                  ))}
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
