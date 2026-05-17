import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  History,
  Image as ImageIcon,
  Scissors,
  Settings,
  Smile,
  StickyNote,
} from "lucide-react";
import EmojiPicker from "./components/EmojiPicker";
import GifPicker from "./components/GifPicker";
import SnipEditor from "./components/SnipEditor";
import HistoryTab from "./components/tabs/HistoryTab";
import NotesTab from "./components/tabs/NotesTab";
import SettingsTab from "./components/tabs/SettingsTab";
import { useDatabase } from "./hooks/useDatabase";
import { useAppSettings } from "./hooks/useAppSettings";
import { useHistory } from "./hooks/useHistory";
import { useNotes } from "./hooks/useNotes";
import { useKeyboardNavigation } from "./hooks/useKeyboardNavigation";
import { startSnipCapture, restoreSnipWindow } from "./services/snipService";
import { applySystemShortcuts } from "./services/shortcutService";
import type { HistoryItem, ImagePreview, SnipEditorState, Tab } from "./types";
import { imageReferenceFromText } from "./utils";
import "./App.css";

function App() {
  const [activeTab, setActiveTab] = useState<Tab>("emoji");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [imagePreview, setImagePreview] = useState<ImagePreview | null>(null);
  const [snipEditor, setSnipEditor] = useState<SnipEditorState | null>(null);
  const [snipStarting, setSnipStarting] = useState(false);
  const [snipError, setSnipError] = useState("");
  const [shortcutStatus, setShortcutStatus] = useState("");

  const inputRef = useRef<HTMLInputElement>(null);
  const snipStartingRef = useRef(false);

  // ─── Data hooks ──────────────────────────────────────────────────────

  const dbRef = useDatabase((db) => {
    loadSettings(db);
    loadHistory(db);
    loadNotes(db);
  });

  const { settings, loadSettings, saveSetting } = useAppSettings(dbRef);
  const { history, loadHistory, clearHistory, addImageToHistory } = useHistory(
    dbRef,
    settings.historyLimit,
  );
  const { notes, loadNotes, saveNote, deleteNote } = useNotes(dbRef);

  // ─── Derived state ───────────────────────────────────────────────────

  const filteredHistory = useMemo(() => {
    if (activeTab !== "history") return [];
    const q = searchQuery.toLowerCase();
    return history.filter((item) => {
      if (item.image_path) return q === "";
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

  // ─��─ Actions ─────────────────────────────────────────────────────────

  const selectHistoryItem = useCallback(async (item: HistoryItem) => {
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
  }, []);

  const startSnip = useCallback(async () => {
    setSnipError("");
    setImagePreview(null);
    setSnipStarting(true);
    snipStartingRef.current = true;
    try {
      const editor = await startSnipCapture(settings);
      setSnipEditor(editor);
    } catch (err) {
      setSnipError(String(err));
    } finally {
      snipStartingRef.current = false;
      setSnipStarting(false);
    }
  }, [settings]);

  const cancelSnip = useCallback(async () => {
    setSnipEditor(null);
    await restoreSnipWindow(settings);
  }, [settings]);

  const applyShortcuts = useCallback(async () => {
    setShortcutStatus("");
    try {
      const message = await applySystemShortcuts(settings);
      setShortcutStatus(message);
    } catch (err) {
      setShortcutStatus(String(err));
    }
  }, [settings]);

  // ─��─ Events ──────────────────────────────────────────────────────────

  useEffect(() => {
    const unlisten = listen("window-shown", async () => {
      if (snipStartingRef.current) return;
      const nextSettings = await loadSettings();
      if (nextSettings.restoreWindowOnShow) {
        await invoke("set_poplet_window_size", {
          width: nextSettings.windowWidth,
          height: nextSettings.windowHeight,
        });
      }
      loadHistory(undefined, nextSettings.historyLimit);
      loadNotes();
      setSearchQuery("");
      setSelectedIndex(0);
      setActiveTab(nextSettings.preferredTab);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  useEffect(() => {
    const maybeStartPendingSnip = async () => {
      if (await invoke<boolean>("take_pending_snip")) {
        startSnip();
      }
    };
    maybeStartPendingSnip();
    const unlisten = listen("start-snip", () => {
      maybeStartPendingSnip();
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [startSnip]);

  useEffect(() => {
    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }, [activeTab]);

  useEffect(() => {
    invoke("set_hide_on_blur_delay", { delayMs: settings.hideOnBlurDelayMs });
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

  // ─── Keyboard ────────────────────────────────────────────────────────

  useKeyboardNavigation({
    filteredHistory,
    selectedIndex,
    setSelectedIndex,
    activeTab,
    setActiveTab,
    snipActive: !!snipEditor,
    onEscape: cancelSnip,
    onEnter: () => {
      if (activeTab === "history" && filteredHistory[selectedIndex]) {
        selectHistoryItem(filteredHistory[selectedIndex]);
      }
    },
  });

  // ─── Render ──────────────────────────────────────────────────────────

  return (
    <div
      className={`app-container ${snipEditor || snipStarting ? "snip-active" : ""}`}
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
          <HistoryTab
            history={history}
            filteredHistory={filteredHistory}
            selectedIndex={selectedIndex}
            onSelect={selectHistoryItem}
            onClear={clearHistory}
            onPreview={setImagePreview}
            previewDelayMs={settings.hoverPreviewDelayMs}
          />
        )}
        {activeTab === "emoji" && <EmojiPicker searchQuery={searchQuery} />}
        {activeTab === "gif" && (
          <GifPicker searchQuery={searchQuery} apiKey={settings.giphyApiKey} />
        )}
        {activeTab === "notes" && (
          <NotesTab
            notes={notes}
            filteredNotes={filteredNotes}
            onSaveNote={saveNote}
            onDeleteNote={deleteNote}
          />
        )}
        {activeTab === "settings" && (
          <SettingsTab
            settings={settings}
            onSaveSetting={saveSetting}
            shortcutStatus={shortcutStatus}
            onApplyShortcuts={applyShortcuts}
            onLoadHistory={(limit) => loadHistory(undefined, limit)}
          />
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

      {snipEditor && (
        <SnipEditor
          editor={snipEditor}
          pencilWidth={settings.snipPencilWidth}
          onSave={async (savedPath) => {
            await addImageToHistory(savedPath);
            setSnipEditor(null);
            await restoreSnipWindow(settings, true);
            setActiveTab("history");
            setSelectedIndex(0);
          }}
          onCancel={cancelSnip}
        />
      )}
    </div>
  );
}

export default App;
