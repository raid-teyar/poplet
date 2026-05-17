import { useState, useCallback, type MutableRefObject } from "react";
import Database from "@tauri-apps/plugin-sql";
import type { NoteItem } from "../types";

export function useNotes(dbRef: MutableRefObject<Database | null>) {
  const [notes, setNotes] = useState<NoteItem[]>([]);

  const loadNotes = useCallback(async (db = dbRef.current) => {
    if (!db) return;
    try {
      const result = await db.select<NoteItem[]>(
        "SELECT * FROM notes ORDER BY updated_at DESC, id DESC",
      );
      setNotes(result);
    } catch (err) {
      console.error("Load Notes Error:", err);
    }
  }, []);

  const saveNote = useCallback(async (
    title: string,
    body: string,
    id: number | null,
  ) => {
    const db = dbRef.current;
    if (!db) return;
    if (id !== null) {
      await db.execute(
        "UPDATE notes SET title = ?, body = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [title, body, id],
      );
    } else {
      await db.execute(
        "INSERT INTO notes (title, body, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
        [title, body],
      );
    }
    loadNotes(db);
  }, [loadNotes]);

  const deleteNote = useCallback(async (id: number) => {
    const db = dbRef.current;
    if (!db) return;
    await db.execute("DELETE FROM notes WHERE id = ?", [id]);
    loadNotes(db);
  }, [loadNotes]);

  return { notes, loadNotes, saveNote, deleteNote };
}
