import { useState, useCallback, useEffect, type MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Database from "@tauri-apps/plugin-sql";
import type { ClipboardEvent, HistoryItem } from "../types";

export function useHistory(
  dbRef: MutableRefObject<Database | null>,
  defaultLimit: number,
) {
  const [history, setHistory] = useState<HistoryItem[]>([]);

  const loadHistory = useCallback(async (
    db = dbRef.current,
    limit = defaultLimit,
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
  }, [defaultLimit]);

  const clearHistory = useCallback(async () => {
    const db = dbRef.current;
    if (!db) return;
    try {
      await db.execute("DELETE FROM history");
      await invoke("clear_image_cache");
      setHistory([]);
    } catch (err) {
      console.error("Clear History Error:", err);
    }
  }, []);

  const addImageToHistory = useCallback(async (path: string) => {
    const db = dbRef.current;
    if (!db) return;
    await db.execute("DELETE FROM history WHERE image_path = ?", [path]);
    await db.execute(
      "INSERT INTO history (content, image_path) VALUES ('', ?)",
      [path],
    );
    await loadHistory(db);
  }, [loadHistory]);

  const assignToProject = useCallback(
    async (id: number, projectId: number | null) => {
      const db = dbRef.current;
      if (!db) return;
      await db.execute("UPDATE history SET project_id = ? WHERE id = ?", [
        projectId,
        id,
      ]);
      await loadHistory(db);
    },
    [loadHistory],
  );

  // Listen for clipboard changes from Rust
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
        loadHistory(db);
      },
    );
    return () => {
      unlisten.then((f) => f());
    };
  }, [loadHistory]);

  return {
    history,
    loadHistory,
    clearHistory,
    addImageToHistory,
    assignToProject,
  };
}
