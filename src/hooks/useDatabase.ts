import { useEffect, useRef } from "react";
import Database from "@tauri-apps/plugin-sql";
import { runMigrations } from "../db/migrations";

export function useDatabase(onReady: (db: Database) => void) {
  const dbRef = useRef<Database | null>(null);

  useEffect(() => {
    async function initDb() {
      try {
        const db = await Database.load("sqlite:poplet.db");
        await runMigrations(db);
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
