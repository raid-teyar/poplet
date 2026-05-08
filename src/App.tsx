import { useState, useEffect, useRef, useMemo } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import Database from "@tauri-apps/plugin-sql";
import { History, Smile, Image as ImageIcon, Trash2 } from "lucide-react";
import EmojiPicker from "./components/EmojiPicker";
import GifPicker from "./components/GifPicker";
import "./App.css";

type Tab = "history" | "emoji" | "gif";

interface HistoryItem {
  id: number;
  content: string;
  image_path: string | null;
  timestamp: string;
}

type ClipboardEvent =
  | { kind: "text"; content: string }
  | { kind: "image"; path: string; width: number; height: number };

function App() {
  const [activeTab, setActiveTab] = useState<Tab>("emoji");
  const [searchQuery, setSearchQuery] = useState("");
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const dbRef = useRef<Database | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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
        // Add image_path column for users on the pre-image schema; harmless if it exists.
        try {
          await db.execute("ALTER TABLE history ADD COLUMN image_path TEXT");
        } catch {
          // column already exists
        }
        dbRef.current = db;
        loadHistory(db);
      } catch (err) {
        console.error("DB Init Error:", err);
      }
    }
    initDb();
  }, []);

  const loadHistory = async (db = dbRef.current) => {
    if (!db) return;
    try {
      const result = await db.select<HistoryItem[]>(
        "SELECT * FROM history ORDER BY id DESC LIMIT 50",
      );
      setHistory(result);
    } catch (err) {
      console.error("Load History Error:", err);
    }
  };

  useEffect(() => {
    const unlisten = listen("window-shown", () => {
      loadHistory();
      setSearchQuery("");
      setSelectedIndex(0);
      setActiveTab("emoji");
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
        const tabs: Tab[] = ["history", "emoji", "gif"];
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

  const selectHistoryItem = async (item: HistoryItem) => {
    try {
      if (item.image_path) {
        await invoke("set_clipboard_image", { path: item.image_path });
      } else {
        await writeText(item.content);
      }
      await invoke("perform_paste");
    } catch (err) {
      console.error("Paste Error:", err);
    }
  };

  return (
    <div className="app-container">
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
      </div>

      <div className="content">
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
              <div
                key={item.id}
                className={`history-item ${
                  index === selectedIndex ? "selected" : ""
                }`}
                onClick={() => selectHistoryItem(item)}
              >
                {item.image_path ? (
                  <>
                    <img
                      src={convertFileSrc(item.image_path)}
                      alt="clipboard image"
                      style={{
                        maxHeight: "60px",
                        maxWidth: "100%",
                        objectFit: "contain",
                        borderRadius: "4px",
                        background: "rgba(255,255,255,0.05)",
                      }}
                    />
                    <div className="history-meta">Image</div>
                  </>
                ) : (
                  <>
                    <div className="history-text">{item.content}</div>
                    <div className="history-meta">Text</div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
        {activeTab === "emoji" && <EmojiPicker searchQuery={searchQuery} />}
        {activeTab === "gif" && <GifPicker searchQuery={searchQuery} />}
      </div>
    </div>
  );
}

export default App;
