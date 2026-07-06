import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Search } from "lucide-react";
import EmojiPicker from "./components/EmojiPicker";
import GifPicker from "./components/GifPicker";
import SnipEditor from "./components/SnipEditor";
import EditLauncher from "./components/EditLauncher";
import NavRail from "./components/NavRail";
import HintBar from "./components/HintBar";
import HistoryTab from "./components/tabs/HistoryTab";
import NotesTab from "./components/tabs/NotesTab";
import ProjectsTab from "./components/tabs/ProjectsTab";
import VaultTab from "./components/tabs/VaultTab";
import SettingsTab from "./components/tabs/SettingsTab";
import { useDatabase } from "./hooks/useDatabase";
import { useAppSettings } from "./hooks/useAppSettings";
import { useHistory } from "./hooks/useHistory";
import { useNotes } from "./hooks/useNotes";
import { useVault } from "./hooks/useVault";
import { useProjects } from "./hooks/useProjects";
import { useEditorSession } from "./hooks/useEditorSession";
import { useBackup } from "./hooks/useBackup";
import { useKeyboardNavigation } from "./hooks/useKeyboardNavigation";
import { restoreSnipWindow } from "./services/snipService";
import { applySystemShortcuts } from "./services/shortcutService";
import { DEFAULT_BLANK_CANVAS } from "./constants";
import type {
  BlankCanvasOptions,
  HistoryItem,
  ImagePreview,
  Tab,
} from "./types";
import {
  imageReferenceFromText,
  detectFilePath,
  isTextReadableFile,
} from "./utils";
import "./App.css";

const SEARCH_PLACEHOLDER: Record<Tab, string> = {
  history: "Search clipboard history…",
  emoji: "Search emoji…",
  gif: "Search GIFs…",
  notes: "Filter notes…",
  projects: "Projects",
  vault: "Search vault…",
  settings: "Settings",
};

function App() {
  const [activeTab, setActiveTab] = useState<Tab>("emoji");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [imagePreview, setImagePreview] = useState<ImagePreview | null>(null);
  const [shortcutStatus, setShortcutStatus] = useState("");
  const [editLauncherOpen, setEditLauncherOpen] = useState(false);
  const [blankOpts, setBlankOpts] = useState<BlankCanvasOptions>(
    DEFAULT_BLANK_CANVAS,
  );
  const [newProjectName, setNewProjectName] = useState("");

  const inputRef = useRef<HTMLInputElement>(null);

  // ─── Data hooks ──────────────────────────────────────────────────────

  const dbRef = useDatabase((db) => {
    loadSettings(db);
    loadHistory(db);
    loadNotes(db);
    vault.refreshStatus();
    projects.loadProjects(db);
  });

  const { settings, loadSettings, saveSetting } = useAppSettings(dbRef);
  const {
    history,
    loadHistory,
    clearHistory,
    addImageToHistory,
    assignToProject,
  } = useHistory(dbRef, settings.historyLimit);
  const {
    notes,
    loadNotes,
    saveNote,
    createImageNote,
    setNoteProject,
    deleteNote,
  } = useNotes(dbRef);
  const vault = useVault(dbRef);
  const projects = useProjects(dbRef);

  const onLaunchStart = useCallback(() => {
    setImagePreview(null);
    setEditLauncherOpen(false);
  }, []);
  const {
    snipEditor,
    setSnipEditor,
    editorInit,
    snipStarting,
    snipError,
    snipStartingRef,
    startSnip,
    importImage,
    createBlankCanvas,
    openProjectInEditor,
    startNewProject,
    cancelSnip,
  } = useEditorSession({ settings, blankOpts, projects, onLaunchStart });

  // Copy a secret without it landing in clipboard history; auto-cleared in ~20s.
  const copySecret = useCallback(async (text: string) => {
    await invoke("copy_secret", { text });
  }, []);

  const selectTab = useCallback(
    (tab: Tab) => {
      setActiveTab(tab);
      setSelectedIndex(0);
      if (tab === "vault") vault.refreshStatus();
    },
    [vault],
  );

  const { exportBackup, importBackup } = useBackup({
    dbRef,
    vault,
    projects,
    loadNotes,
  });

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
        (note.title ?? "").toLowerCase().includes(q) ||
        (note.body ?? "").toLowerCase().includes(q),
    );
  }, [notes, searchQuery, activeTab]);

  // ─��─ Actions ─────────────────────────────────────────────────────────

  const selectHistoryItem = useCallback(async (item: HistoryItem) => {
    try {
      if (item.image_path) {
        await invoke("set_clipboard_image", { path: item.image_path });
      } else {
        const detectedFile = detectFilePath(item.content);
        if (detectedFile && isTextReadableFile(detectedFile)) {
          await invoke("read_and_copy_file_content", {
            path: detectedFile.path,
          });
        } else {
          await writeText(imageReferenceFromText(item.content) ?? item.content);
        }
      }
      await invoke("perform_paste");
    } catch (err) {
      console.error("Paste Error:", err);
    }
  }, []);

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

  // Auto-lock the vault whenever Poplet is hidden — a locked vault is wiped
  // from memory, so leaving the app ends the session.
  useEffect(() => {
    const onHide = () => {
      if (document.hidden) vault.lock();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [vault.lock]);

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
      <div className="app-shell">
        <NavRail
          activeTab={activeTab}
          onSelect={selectTab}
          onSnip={startSnip}
          onOpenEditor={() => setEditLauncherOpen(true)}
        />
        <div className="app-main">
          <div className="command-bar">
            <Search size={16} className="command-bar-icon" />
            <input
              ref={inputRef}
              type="text"
              className="command-bar-input"
              placeholder={SEARCH_PLACEHOLDER[activeTab]}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              autoFocus
            />
          </div>

          <div className="content">
            {snipError && <p className="error-state">{snipError}</p>}
        {activeTab === "history" && (
          <HistoryTab
            history={history}
            filteredHistory={filteredHistory}
            selectedIndex={selectedIndex}
            projects={projects.projects}
            onSelect={selectHistoryItem}
            onClear={clearHistory}
            onPreview={setImagePreview}
            onAssignToProject={assignToProject}
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
            projects={projects.projects}
            onSaveNote={saveNote}
            onDeleteNote={deleteNote}
            onCopy={(text) => writeText(text)}
          />
        )}
        {activeTab === "projects" && (
          <ProjectsTab
            projects={projects.projects}
            notes={notes}
            captures={history.filter((h) => h.image_path)}
            onCreate={projects.createProject}
            onRename={projects.renameProject}
            onDelete={projects.deleteProject}
            onUnassignNote={(id) => setNoteProject(id, null)}
            onUnassignCapture={(id) => assignToProject(id, null)}
            onOpen={openProjectInEditor}
          />
        )}
        {activeTab === "vault" && (
          <VaultTab
            status={vault.status}
            entries={vault.entries}
            searchQuery={searchQuery}
            onSetup={vault.setup}
            onUnlock={vault.unlock}
            onLock={vault.lock}
            onSave={vault.saveEntry}
            onDelete={vault.deleteEntry}
            onCopy={copySecret}
            onExportBackup={exportBackup}
            onImportBackup={importBackup}
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

          <HintBar tab={activeTab} />
        </div>
      </div>

      {imagePreview && settings.enableImagePreview && (
        <div className="image-preview">
          <img src={imagePreview.src} alt="clipboard preview" />
          <div className="image-preview-meta">
            {imagePreview.width} x {imagePreview.height}
          </div>
        </div>
      )}

      {editLauncherOpen && !snipEditor && (
        <EditLauncher
          blankOpts={blankOpts}
          setBlankOpts={setBlankOpts}
          newProjectName={newProjectName}
          setNewProjectName={setNewProjectName}
          projects={projects.projects}
          onClose={() => setEditLauncherOpen(false)}
          onImportImage={importImage}
          onCreateBlankCanvas={createBlankCanvas}
          onStartNewProject={startNewProject}
          onOpenProject={openProjectInEditor}
        />
      )}

      {snipEditor && (
        <SnipEditor
          key={snipEditor.path}
          editor={snipEditor}
          pencilWidth={settings.snipPencilWidth}
          smoothing={settings.snipSmoothing}
          sketch={settings.snipSketch}
          showPageNumbers={settings.showPageNumbers}
          notes={notes}
          libraryProjects={projects.projects}
          initialPages={editorInit?.pages}
          initialGroupNames={editorInit?.groupNames}
          initialProjectId={editorInit?.projectId}
          initialProjectName={editorInit?.projectName}
          onSaveToLibrary={projects.saveProjectToLibrary}
          onUpdateProject={projects.updateProjectData}
          onGetProject={projects.getProjectData}
          onDeleteProject={projects.deleteProject}
          onToggleSmoothing={(next) => saveSetting("snipSmoothing", next)}
          onToggleSketch={(next) => saveSetting("snipSketch", next)}
          onTogglePageNumbers={(next) => saveSetting("showPageNumbers", next)}
          onCreateImageNote={(imagePath, pinX, pinY, title, body) =>
            createImageNote(title, body, imagePath, pinX, pinY)
          }
          onSaveNote={(title, body, id) => saveNote(title, body, id)}
          onDeleteNote={deleteNote}
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
