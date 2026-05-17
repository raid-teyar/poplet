import { useEffect, useRef } from "react";
import Database from "@tauri-apps/plugin-sql";

export function useDatabase(onReady: (db: Database) => void) {
  const dbRef = useRef<Database | null>(null);

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
        try {
          await db.execute("ALTER TABLE history ADD COLUMN image_path TEXT");
        } catch {
          // column already exists
        }
        dbRef.current = db;
        onReady(db);
      } catch (err) {
        console.error("DB Init Error:", err);
      }
    }
    initDb();
  }, []);

  return dbRef;
}
