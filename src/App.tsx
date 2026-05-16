import { useState, useEffect, useRef, useMemo } from "react";
import type { PointerEvent } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import Database from "@tauri-apps/plugin-sql";
import {
  Check,
  History,
  Image as ImageIcon,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Scissors,
  Settings,
  Smile,
  StickyNote,
  Trash2,
  X,
} from "lucide-react";
import EmojiPicker from "./components/EmojiPicker";
import GifPicker from "./components/GifPicker";
import "./App.css";

type Tab = "history" | "emoji" | "gif" | "notes" | "settings";

const PICKER_TABS: Tab[] = ["history", "emoji", "gif", "notes"];
const DEFAULT_WINDOW_WIDTH = 450;
const DEFAULT_WINDOW_HEIGHT = 600;
const MIN_WINDOW_WIDTH = 320;
const MAX_WINDOW_WIDTH = 1000;
const MIN_WINDOW_HEIGHT = 360;
const MAX_WINDOW_HEIGHT = 1200;
const MAX_HOVER_PREVIEW_DELAY_MS = 5000;

interface AppSettings {
  enableImagePreview: boolean;
  hoverPreviewDelayMs: number;
  preferredTab: Exclude<Tab, "settings">;
  giphyApiKey: string;
  historyLimit: number;
  hideOnBlurDelayMs: number;
  windowWidth: number;
  windowHeight: number;
}

const DEFAULT_SETTINGS: AppSettings = {
  enableImagePreview: true,
  hoverPreviewDelayMs: 1500,
  preferredTab: "emoji",
  giphyApiKey: "",
  historyLimit: 50,
  hideOnBlurDelayMs: 250,
  windowWidth: DEFAULT_WINDOW_WIDTH,
  windowHeight: DEFAULT_WINDOW_HEIGHT,
};

const SNIP_COLORS = ["#ef4444", "#ffdf3d", "#22c55e", "#38bdf8", "#ffffff"];

interface HistoryItem {
  id: number;
  content: string;
  image_path: string | null;
  timestamp: string;
}

interface NoteItem {
  id: number;
  title: string;
  body: string;
  updated_at: string;
}

type ClipboardEvent =
  | { kind: "text"; content: string }
  | { kind: "image"; path: string; width: number; height: number };

interface ImagePreview {
  src: string;
  width: number;
  height: number;
}

interface CapturedImage {
  path: string;
  width: number;
  height: number;
}

interface SnipEditorState extends CapturedImage {
  src: string;
}

const IMG_SRC_RE = /<img\b[^>]*\bsrc=(["']?)([^"'\s>]+)\1[^>]*>/i;

function imageReferenceFromText(content: string): string | null {
  const trimmed = content.trim();
  const htmlSrc = trimmed.match(IMG_SRC_RE)?.[2];
  const candidate = htmlSrc ?? trimmed.split(/\r?\n/).find(Boolean)?.trim();
  return candidate ?? null;
}

function imageSrcFromText(content: string): string | null {
  const candidate = imageReferenceFromText(content);
  if (!candidate) return null;
  if (/^https?:\/\//i.test(candidate) || /^data:image\//i.test(candidate)) {
    return candidate;
  }
  if (/^file:\/\//i.test(candidate)) {
    return convertFileSrc(decodeURI(candidate.replace(/^file:\/\//i, "")));
  }
  if (/^\/.*\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(candidate)) {
    return convertFileSrc(candidate);
  }
  return null;
}

function clampNumber(
  value: number,
  min: number,
  max: number,
  fallback: number,
) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

function clampHoverPreviewDelayMs(value: number) {
  return clampNumber(value, 0, MAX_HOVER_PREVIEW_DELAY_MS, 1500);
}

function clampWindowWidth(value: number) {
  return clampNumber(
    value,
    MIN_WINDOW_WIDTH,
    MAX_WINDOW_WIDTH,
    DEFAULT_WINDOW_WIDTH,
  );
}

function clampWindowHeight(value: number) {
  return clampNumber(
    value,
    MIN_WINDOW_HEIGHT,
    MAX_WINDOW_HEIGHT,
    DEFAULT_WINDOW_HEIGHT,
  );
}

function App() {
  const [activeTab, setActiveTab] = useState<Tab>("emoji");
  const [searchQuery, setSearchQuery] = useState("");
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [notes, setNotes] = useState<NoteItem[]>([]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [noteModalOpen, setNoteModalOpen] = useState(false);
  const [noteModalMode, setNoteModalMode] = useState<"add" | "edit">("add");
  const [noteModalId, setNoteModalId] = useState<number | null>(null);
  const [noteTitle, setNoteTitle] = useState("");
  const [noteBody, setNoteBody] = useState("");
  const [imagePreview, setImagePreview] = useState<ImagePreview | null>(null);
  const [snipEditor, setSnipEditor] = useState<SnipEditorState | null>(null);
  const [snipError, setSnipError] = useState("");
  const [snipSaving, setSnipSaving] = useState(false);
  const [snipColor, setSnipColor] = useState(SNIP_COLORS[0]);
  const dbRef = useRef<Database | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const snipImageRef = useRef<HTMLImageElement | null>(null);
  const snipCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);

  useEffect(() => {
    async function initDb() {
      try {
        const db = await Database.load("sqlite:poplet.db");
        await db.execute(`
          CREATE TABLE IF NOT EXISTS history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content TEXT NOT NULL DEFAULT '',
            image_path TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);
        await db.execute(`
          CREATE TABLE IF NOT EXISTS notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL DEFAULT '',
            body TEXT NOT NULL DEFAULT '',
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);
        await db.execute(`
          CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          )
        `);
        // Add image_path column for users on the pre-image schema; harmless if it exists.
        try {
          await db.execute("ALTER TABLE history ADD COLUMN image_path TEXT");
        } catch {
          // column already exists
        }
        dbRef.current = db;
        await loadSettings(db);
        loadHistory(db);
        loadNotes(db);
      } catch (err) {
        console.error("DB Init Error:", err);
      }
    }
    initDb();
  }, []);

  const loadSettings = async (db = dbRef.current) => {
    if (!db) return DEFAULT_SETTINGS;
    try {
      const rows = await db.select<Array<{ key: string; value: string }>>(
        "SELECT key, value FROM settings",
      );
      const next = { ...DEFAULT_SETTINGS };
      for (const row of rows) {
        if (row.key === "enableImagePreview") {
          next.enableImagePreview = row.value !== "false";
        } else if (row.key === "hoverPreviewDelayMs") {
          next.hoverPreviewDelayMs = clampHoverPreviewDelayMs(
            Number(row.value),
          );
        } else if (
          row.key === "preferredTab" &&
          PICKER_TABS.includes(row.value as Tab)
        ) {
          next.preferredTab = row.value as AppSettings["preferredTab"];
        } else if (row.key === "giphyApiKey") {
          next.giphyApiKey = row.value;
        } else if (row.key === "historyLimit") {
          const limit = Number(row.value);
          if (Number.isFinite(limit)) {
            next.historyLimit = Math.min(Math.max(limit, 10), 200);
          }
        } else if (row.key === "hideOnBlurDelayMs") {
          const delay = Number(row.value);
          if (Number.isFinite(delay)) {
            next.hideOnBlurDelayMs = Math.min(Math.max(delay, 0), 2000);
          }
        } else if (row.key === "windowWidth") {
          next.windowWidth = clampWindowWidth(Number(row.value));
        } else if (row.key === "windowHeight") {
          next.windowHeight = clampWindowHeight(Number(row.value));
        }
      }
      setSettings(next);
      return next;
    } catch (err) {
      console.error("Load Settings Error:", err);
      return DEFAULT_SETTINGS;
    }
  };

  const saveSetting = async <K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K],
  ) => {
    const db = dbRef.current;
    const next = { ...settings, [key]: value };
    setSettings(next);
    if (!db) return;
    await db.execute(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [key, String(value)],
    );
  };

  const loadHistory = async (
    db = dbRef.current,
    limit = settings.historyLimit,
  ) => {
    if (!db) return;
    try {
      const result = await db.select<HistoryItem[]>(
        "SELECT * FROM history ORDER BY id DESC LIMIT ?",
        [limit],
      );
      setHistory(result);
    } catch (err) {
      console.error("Load History Error:", err);
    }
  };

  const loadNotes = async (db = dbRef.current) => {
    if (!db) return;
    try {
      const result = await db.select<NoteItem[]>(
        "SELECT * FROM notes ORDER BY updated_at DESC, id DESC",
      );
      setNotes(result);
    } catch (err) {
      console.error("Load Notes Error:", err);
    }
  };

  useEffect(() => {
    const unlisten = listen("window-shown", async () => {
      const nextSettings = await loadSettings();
      loadHistory(undefined, nextSettings.historyLimit);
      loadNotes();
      setSearchQuery("");
      setSelectedIndex(0);
      setActiveTab(nextSettings.preferredTab);
      // Defer focus to the next paint so the OS window is actually visible
      // by the time we ask for it; some compositors drop focus requests
      // issued before the surface is mapped.
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  // Refocus the search box whenever the user switches tabs so they can
  // start typing immediately without clicking the input.
  useEffect(() => {
    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }, [activeTab]);

  useEffect(() => {
    invoke("set_hide_on_blur_delay", {
      delayMs: settings.hideOnBlurDelayMs,
    });
  }, [settings.hideOnBlurDelayMs]);

  useEffect(() => {
    invoke("set_poplet_window_size", {
      width: settings.windowWidth,
      height: settings.windowHeight,
    });
  }, [settings.windowWidth, settings.windowHeight]);

  useEffect(() => {
    if (!settings.enableImagePreview || !imagePreview) {
      invoke("hide_preview_window");
    }
  }, [imagePreview, settings.enableImagePreview]);

  // Listen for clipboard changes (text or image) from Rust
  useEffect(() => {
    const unlisten = listen<ClipboardEvent>(
      "clipboard-changed",
      async (event) => {
        const db = dbRef.current;
        if (!db) return;
        const payload = event.payload;
        if (payload.kind === "text") {
          await db.execute(
            "DELETE FROM history WHERE content = ? AND image_path IS NULL",
            [payload.content],
          );
          await db.execute("INSERT INTO history (content) VALUES (?)", [
            payload.content,
          ]);
        } else {
          await db.execute("DELETE FROM history WHERE image_path = ?", [
            payload.path,
          ]);
          await db.execute(
            "INSERT INTO history (content, image_path) VALUES ('', ?)",
            [payload.path],
          );
        }
        loadHistory();
      },
    );
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  const filteredHistory = useMemo(() => {
    if (activeTab !== "history") return [];
    const q = searchQuery.toLowerCase();
    return history.filter((item) => {
      if (item.image_path) {
        // Images can't be text-searched; show only when no query is active.
        return q === "";
      }
      return item.content.toLowerCase().includes(q);
    });
  }, [history, searchQuery, activeTab]);

  const filteredNotes = useMemo(() => {
    if (activeTab !== "notes") return [];
    const q = searchQuery.trim().toLowerCase();
    if (!q) return notes;
    return notes.filter(
      (note) =>
        note.title.toLowerCase().includes(q) ||
        note.body.toLowerCase().includes(q),
    );
  }, [notes, searchQuery, activeTab]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        setSelectedIndex((prev) =>
          Math.min(prev + 1, filteredHistory.length - 1),
        );
      } else if (e.key === "ArrowUp") {
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
      } else if (e.key === "Enter") {
        if (activeTab === "history" && filteredHistory[selectedIndex]) {
          selectHistoryItem(filteredHistory[selectedIndex]);
        }
      } else if (e.key === "Tab") {
        e.preventDefault();
        const tabs: Tab[] = ["history", "emoji", "gif", "notes", "settings"];
        const nextIndex = (tabs.indexOf(activeTab) + 1) % tabs.length;
        setActiveTab(tabs[nextIndex]);
        setSelectedIndex(0);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [filteredHistory, selectedIndex, activeTab]);

  const clearHistory = async () => {
    const db = dbRef.current;
    if (!db) return;
    try {
      await db.execute("DELETE FROM history");
      await invoke("clear_image_cache");
      setHistory([]);
      setSelectedIndex(0);
    } catch (err) {
      console.error("Clear History Error:", err);
    }
  };

  const addImageToHistory = async (path: string) => {
    const db = dbRef.current;
    if (!db) return;
    await db.execute("DELETE FROM history WHERE image_path = ?", [path]);
    await db.execute("INSERT INTO history (content, image_path) VALUES ('', ?)", [
      path,
    ]);
    await loadHistory();
  };

  const startSnip = async () => {
    setSnipError("");
    setImagePreview(null);
    try {
      const captured = await invoke<CapturedImage>("capture_screenshot_area");
      setSnipEditor({ ...captured, src: convertFileSrc(captured.path) });
    } catch (err) {
      setSnipError(String(err));
    }
  };

  const resetSnipCanvas = () => {
    const canvas = snipCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx?.clearRect(0, 0, canvas.width, canvas.height);
  };

  const snipPointFromEvent = (event: PointerEvent<HTMLCanvasElement>) => {
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  const beginSnipDraw = (event: PointerEvent<HTMLCanvasElement>) => {
    const canvas = event.currentTarget;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const point = snipPointFromEvent(event);
    drawingRef.current = true;
    canvas.setPointerCapture(event.pointerId);
    ctx.strokeStyle = snipColor;
    ctx.lineWidth = Math.max(3, Math.round(canvas.width / 180));
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(point.x, point.y);
  };

  const continueSnipDraw = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    const ctx = event.currentTarget.getContext("2d");
    if (!ctx) return;
    const point = snipPointFromEvent(event);
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
  };

  const endSnipDraw = (event: PointerEvent<HTMLCanvasElement>) => {
    drawingRef.current = false;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer may already be released by the browser.
    }
  };

  const saveSnip = async () => {
    const drawing = snipCanvasRef.current;
    if (!snipEditor || !drawing) return;
    setSnipSaving(true);
    setSnipError("");
    try {
      const saved = await invoke<CapturedImage>("save_annotated_image", {
        basePath: snipEditor.path,
        drawingDataUrl: drawing.toDataURL("image/png"),
      });
      await addImageToHistory(saved.path);
      setSnipEditor(null);
      setActiveTab("history");
      setSelectedIndex(0);
    } catch (err) {
      setSnipError(String(err));
    } finally {
      setSnipSaving(false);
    }
  };

  const openAddNote = () => {
    setNoteModalMode("add");
    setNoteModalId(null);
    setNoteTitle("");
    setNoteBody("");
    setNoteModalOpen(true);
  };

  const openEditNote = (note: NoteItem) => {
    setNoteModalMode("edit");
    setNoteModalId(note.id);
    setNoteTitle(note.title);
    setNoteBody(note.body);
    setNoteModalOpen(true);
  };

  const closeNoteModal = () => {
    setNoteModalOpen(false);
    setNoteModalId(null);
    setNoteTitle("");
    setNoteBody("");
  };

  const saveNote = async () => {
    const title = noteTitle.trim();
    const body = noteBody.trim();
    if (!title && !body) return;
    const db = dbRef.current;
    if (!db) return;
    if (noteModalMode === "edit" && noteModalId !== null) {
      await db.execute(
        "UPDATE notes SET title = ?, body = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [title || "Untitled", noteBody, noteModalId],
      );
    } else {
      await db.execute(
        "INSERT INTO notes (title, body, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
        [title || "Untitled", body],
      );
    }
    closeNoteModal();
    loadNotes();
  };

  const deleteNote = async (id: number) => {
    const db = dbRef.current;
    if (!db) return;
    await db.execute("DELETE FROM notes WHERE id = ?", [id]);
    if (noteModalId === id) closeNoteModal();
    loadNotes();
  };

  const selectHistoryItem = async (item: HistoryItem) => {
    try {
      if (item.image_path) {
        await invoke("set_clipboard_image", { path: item.image_path });
      } else {
        await writeText(imageReferenceFromText(item.content) ?? item.content);
      }
      await invoke("perform_paste");
    } catch (err) {
      console.error("Paste Error:", err);
    }
  };

  return (
    <div
      className="app-container"
      onMouseEnter={() => invoke("set_pointer_inside", { inside: true })}
      onMouseLeave={() => {
        setImagePreview(null);
        invoke("set_pointer_inside", { inside: false });
      }}
    >
      <div className="search-container">
        <input
          ref={inputRef}
          type="text"
          className="search-input"
          placeholder={`Search ${activeTab}...`}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          autoFocus
        />
      </div>

      <div className="tabs">
        <button className="tab snip-tab" onClick={startSnip} title="Snip area">
          <Scissors size={16} />
        </button>
        <div
          className={`tab ${activeTab === "history" ? "active" : ""}`}
          onClick={() => {
            setActiveTab("history");
            setSelectedIndex(0);
          }}
        >
          <History size={16} />
        </div>
        <div
          className={`tab ${activeTab === "emoji" ? "active" : ""}`}
          onClick={() => {
            setActiveTab("emoji");
            setSelectedIndex(0);
          }}
        >
          <Smile size={16} />
        </div>
        <div
          className={`tab ${activeTab === "gif" ? "active" : ""}`}
          onClick={() => {
            setActiveTab("gif");
            setSelectedIndex(0);
          }}
        >
          <ImageIcon size={16} />
        </div>
        <div
          className={`tab ${activeTab === "notes" ? "active" : ""}`}
          onClick={() => {
            setActiveTab("notes");
            setSelectedIndex(0);
          }}
          title="Notes"
        >
          <StickyNote size={16} />
        </div>
        <div
          className={`tab settings-tab ${activeTab === "settings" ? "active" : ""}`}
          onClick={() => {
            setActiveTab("settings");
            setSelectedIndex(0);
          }}
          title="Settings"
        >
          <Settings size={16} />
        </div>
      </div>

      <div className="content">
        {snipError && <p className="error-state">{snipError}</p>}
        {activeTab === "history" && (
          <div className="history-list">
            {history.length > 0 && (
              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  padding: "4px 8px",
                }}
              >
                <button
                  onClick={clearHistory}
                  title="Clear all history"
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "rgba(255,255,255,0.5)",
                    cursor: "pointer",
                    padding: "4px 8px",
                    borderRadius: "4px",
                    display: "flex",
                    alignItems: "center",
                    gap: "4px",
                    fontSize: "12px",
                  }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.color = "rgba(255,200,200,1)")
                  }
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.color = "rgba(255,255,255,0.5)")
                  }
                >
                  <Trash2 size={12} />
                  Clear
                </button>
              </div>
            )}
            {filteredHistory.length === 0 && (
              <p
                style={{
                  padding: "20px",
                  color: "rgba(255,255,255,0.4)",
                  textAlign: "center",
                  fontSize: "13px",
                }}
              >
                {history.length === 0 ? "No history yet" : "No matches"}
              </p>
            )}
            {filteredHistory.map((item, index) => (
              <HistoryRow
                key={item.id}
                item={item}
                selected={index === selectedIndex}
                onSelect={() => selectHistoryItem(item)}
                onPreview={setImagePreview}
                previewDelayMs={settings.hoverPreviewDelayMs}
              />
            ))}
          </div>
        )}
        {activeTab === "emoji" && <EmojiPicker searchQuery={searchQuery} />}
        {activeTab === "gif" && (
          <GifPicker searchQuery={searchQuery} apiKey={settings.giphyApiKey} />
        )}
        {activeTab === "notes" && (
          <div className="notes-panel">
            <div className="notes-toolbar">
              <button className="note-primary-button" onClick={openAddNote}>
                <Plus size={14} />
                Add note
              </button>
            </div>

            {filteredNotes.length === 0 && (
              <p className="empty-state">
                {notes.length === 0 ? "No notes yet" : "No matches"}
              </p>
            )}

            <div className="notes-list">
              {filteredNotes.map((note) => (
                <div className="note-item" key={note.id}>
                  <div className="note-header">
                    <div className="note-title">{note.title}</div>
                    <div className="note-actions">
                      <button
                        className="icon-button"
                        title="Edit note"
                        onClick={() => openEditNote(note)}
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        className="icon-button"
                        title="Delete note"
                        onClick={() => deleteNote(note.id)}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                  {note.body && <div className="note-body">{note.body}</div>}
                </div>
              ))}
            </div>
          </div>
        )}
        {activeTab === "settings" && (
          <div className="settings-panel">
            <label className="setting-row">
              <span>
                <strong>Image preview</strong>
                <small>Show a floating preview when hovering images.</small>
              </span>
              <input
                type="checkbox"
                checked={settings.enableImagePreview}
                onChange={(e) =>
                  saveSetting("enableImagePreview", e.target.checked)
                }
              />
            </label>

            <label className="setting-row">
              <span>
                <strong>Preferred tab</strong>
                <small>Tab opened when Poplet is shown.</small>
              </span>
              <select
                value={settings.preferredTab}
                onChange={(e) =>
                  saveSetting(
                    "preferredTab",
                    e.target.value as AppSettings["preferredTab"],
                  )
                }
              >
                <option value="history">History</option>
                <option value="emoji">Emoji</option>
                <option value="gif">GIF</option>
                <option value="notes">Notes</option>
              </select>
            </label>

            <label className="setting-field">
              <span>
                <strong>Giphy API key</strong>
                <small>Used by the GIF tab without rebuilding Poplet.</small>
              </span>
              <input
                type="password"
                value={settings.giphyApiKey}
                onChange={(e) => saveSetting("giphyApiKey", e.target.value)}
                placeholder="giphy api key"
              />
            </label>

            <label className="setting-field">
              <span>
                <strong>Preview delay</strong>
                <small>
                  Milliseconds to wait before showing hover previews.
                </small>
              </span>
              <input
                type="number"
                min={0}
                max={MAX_HOVER_PREVIEW_DELAY_MS}
                step={100}
                value={settings.hoverPreviewDelayMs}
                onChange={(e) =>
                  saveSetting(
                    "hoverPreviewDelayMs",
                    clampHoverPreviewDelayMs(Number(e.target.value)),
                  )
                }
              />
            </label>

            <label className="setting-field">
              <span>
                <strong>History limit</strong>
                <small>Number of clipboard rows to load.</small>
              </span>
              <input
                type="number"
                min={10}
                max={200}
                value={settings.historyLimit}
                onChange={(e) => {
                  const value = Math.min(
                    Math.max(Number(e.target.value) || 50, 10),
                    200,
                  );
                  saveSetting("historyLimit", value);
                  loadHistory(undefined, value);
                }}
              />
            </label>

            <label className="setting-field">
              <span>
                <strong>Window width</strong>
                <small>Poplet window width in pixels.</small>
              </span>
              <input
                type="number"
                min={MIN_WINDOW_WIDTH}
                max={MAX_WINDOW_WIDTH}
                step={10}
                value={settings.windowWidth}
                onChange={(e) =>
                  saveSetting(
                    "windowWidth",
                    clampWindowWidth(Number(e.target.value)),
                  )
                }
              />
            </label>

            <label className="setting-field">
              <span>
                <strong>Window height</strong>
                <small>Poplet window height in pixels.</small>
              </span>
              <input
                type="number"
                min={MIN_WINDOW_HEIGHT}
                max={MAX_WINDOW_HEIGHT}
                step={10}
                value={settings.windowHeight}
                onChange={(e) =>
                  saveSetting(
                    "windowHeight",
                    clampWindowHeight(Number(e.target.value)),
                  )
                }
              />
            </label>

            <label className="setting-field">
              <span>
                <strong>Hide delay</strong>
                <small>Grace period after focus loss, in milliseconds.</small>
              </span>
              <input
                type="number"
                min={0}
                max={2000}
                step={50}
                value={settings.hideOnBlurDelayMs}
                onChange={(e) =>
                  saveSetting(
                    "hideOnBlurDelayMs",
                    Math.min(Math.max(Number(e.target.value) || 0, 0), 2000),
                  )
                }
              />
            </label>
          </div>
        )}
      </div>
      {imagePreview && settings.enableImagePreview && (
        <div className="image-preview">
          <img src={imagePreview.src} alt="clipboard preview" />
          <div className="image-preview-meta">
            {imagePreview.width} x {imagePreview.height}
          </div>
        </div>
      )}
      {noteModalOpen && (
        <div className="modal-backdrop" onMouseDown={closeNoteModal}>
          <div className="note-modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <strong>
                {noteModalMode === "edit" ? "Edit note" : "Add note"}
              </strong>
              <button className="icon-button" onClick={closeNoteModal}>
                <X size={14} />
              </button>
            </div>
            <input
              className="note-title-input"
              value={noteTitle}
              onChange={(e) => setNoteTitle(e.target.value)}
              placeholder="Title"
              autoFocus
            />
            <textarea
              className="note-body-input note-modal-body"
              value={noteBody}
              onChange={(e) => setNoteBody(e.target.value)}
              placeholder="Note"
            />
            <div className="modal-actions">
              <button className="secondary-button" onClick={closeNoteModal}>
                Cancel
              </button>
              <button className="note-primary-button" onClick={saveNote}>
                <Check size={14} />
                Save
              </button>
            </div>
          </div>
        </div>
      )}
      {snipEditor && (
        <div className="modal-backdrop snip-backdrop">
          <div className="snip-modal">
            <div className="modal-header">
              <strong>Snip</strong>
              <div className="snip-actions">
                <div className="snip-colors" aria-label="Pencil color">
                  {SNIP_COLORS.map((color) => (
                    <button
                      key={color}
                      className={`snip-color ${snipColor === color ? "active" : ""}`}
                      style={{ backgroundColor: color }}
                      onClick={() => setSnipColor(color)}
                      title={`Pencil color ${color}`}
                    />
                  ))}
                </div>
                <button
                  className="icon-button"
                  onClick={resetSnipCanvas}
                  title="Clear drawing"
                >
                  <RotateCcw size={14} />
                </button>
                <button
                  className="icon-button"
                  onClick={() => setSnipEditor(null)}
                  title="Cancel"
                >
                  <X size={14} />
                </button>
              </div>
            </div>
            <div className="snip-stage">
              <img
                ref={snipImageRef}
                src={snipEditor.src}
                alt="screen snip"
                onLoad={(event) => {
                  const canvas = snipCanvasRef.current;
                  if (!canvas) return;
                  canvas.width = event.currentTarget.naturalWidth;
                  canvas.height = event.currentTarget.naturalHeight;
                  resetSnipCanvas();
                }}
              />
              <canvas
                ref={snipCanvasRef}
                onPointerDown={beginSnipDraw}
                onPointerMove={continueSnipDraw}
                onPointerUp={endSnipDraw}
                onPointerCancel={endSnipDraw}
                onPointerLeave={endSnipDraw}
              />
            </div>
            <div className="modal-actions">
              <span className="snip-meta">
                {snipEditor.width} x {snipEditor.height}
              </span>
              <button
                className="note-primary-button"
                onClick={saveSnip}
                disabled={snipSaving}
              >
                <Save size={14} />
                {snipSaving ? "Saving" : "Copy"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function HistoryRow({
  item,
  selected,
  onSelect,
  onPreview,
  previewDelayMs,
}: {
  item: HistoryItem;
  selected: boolean;
  onSelect: () => void;
  onPreview: (preview: ImagePreview | null) => void;
  previewDelayMs: number;
}) {
  const previewTimerRef = useRef<number | null>(null);
  const textImageSrc = item.image_path ? null : imageSrcFromText(item.content);
  const imageSrc = item.image_path
    ? convertFileSrc(item.image_path)
    : textImageSrc;
  const isImageLike = Boolean(imageSrc);

  const clearPreviewTimer = () => {
    if (previewTimerRef.current !== null) {
      window.clearTimeout(previewTimerRef.current);
      previewTimerRef.current = null;
    }
  };

  useEffect(() => clearPreviewTimer, []);

  return (
    <div
      className={`history-item ${selected ? "selected" : ""}`}
      onClick={onSelect}
      onMouseLeave={() => {
        clearPreviewTimer();
        onPreview(null);
      }}
    >
      {isImageLike && imageSrc ? (
        <>
          <img
            src={imageSrc}
            alt="clipboard image"
            className="history-image"
            onMouseEnter={(e) => {
              const img = e.currentTarget;
              clearPreviewTimer();
              previewTimerRef.current = window.setTimeout(() => {
                onPreview({
                  src: imageSrc,
                  width: img.naturalWidth,
                  height: img.naturalHeight,
                });
              }, previewDelayMs);
            }}
          />
          <div className="history-meta">
            {item.image_path ? "Image" : "Image link"}
          </div>
        </>
      ) : (
        <>
          <div className="history-text">{item.content}</div>
          <div className="history-meta">Text</div>
        </>
      )}
    </div>
  );
}

export default App;
