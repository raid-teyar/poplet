import type Database from "@tauri-apps/plugin-sql";

/// A single forward schema step. `up` must be safe to re-run: if the app is
/// killed after `up` completes but before the version bump is persisted, the
/// runner will invoke `up` again on the next launch. Prefer `IF NOT EXISTS`,
/// state checks, and idempotent copies over blind DDL.
interface Migration {
  version: number;
  name: string;
  up: (db: Database) => Promise<void>;
}

/// Ordered forward migrations. Never edit or reorder a shipped migration —
/// only append new ones. `user_version` records the highest applied step.
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "baseline schema",
    up: async (db) => {
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
      // Secrets vault. vault_meta holds only non-secret unlock parameters;
      // vault_entries.data is an encrypted JSON blob (opaque at rest).
      await db.execute(`
        CREATE TABLE IF NOT EXISTS vault_meta (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          salt TEXT NOT NULL,
          verifier TEXT NOT NULL,
          mem_kib INTEGER NOT NULL,
          iters INTEGER NOT NULL,
          parallelism INTEGER NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await db.execute(`
        CREATE TABLE IF NOT EXISTS vault_entries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          data TEXT NOT NULL,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      // Editor projects saved into the app (project library). In v1 the arena
      // document lived in projects.data; v2 splits it into `documents`.
      await db.execute(`
        CREATE TABLE IF NOT EXISTS projects (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL DEFAULT 'Project',
          data TEXT NOT NULL,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      // Columns added incrementally over the app's life. On an install that
      // predates the migration runner these may already exist, so each ALTER
      // is tolerated individually.
      const optionalColumns = [
        "ALTER TABLE history ADD COLUMN image_path TEXT",
        "ALTER TABLE history ADD COLUMN project_id INTEGER",
        "ALTER TABLE notes ADD COLUMN type TEXT NOT NULL DEFAULT 'note'",
        "ALTER TABLE notes ADD COLUMN image_path TEXT",
        "ALTER TABLE notes ADD COLUMN pin_x REAL",
        "ALTER TABLE notes ADD COLUMN pin_y REAL",
        "ALTER TABLE notes ADD COLUMN draft INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE notes ADD COLUMN project_id INTEGER",
      ];
      for (const sql of optionalColumns) {
        try {
          await db.execute(sql);
        } catch {
          // column already exists
        }
      }
    },
  },
  {
    version: 2,
    name: "split editor documents out of projects",
    up: async (db) => {
      // A project is a named container that notes and captures are assigned
      // to; its editor arena drawing is a separate document. Give the drawing
      // its own table keyed by project so the container no longer carries an
      // (often empty) blob and NOT NULL data.
      await db.execute(`
        CREATE TABLE IF NOT EXISTS documents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER NOT NULL,
          data TEXT NOT NULL,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // If `projects.data` still exists we have not finished the split yet
      // (fresh install, or a prior run was interrupted). Re-copy from scratch
      // — `documents` is introduced by this migration, so clearing it first
      // makes the copy safe to repeat.
      const projectCols = await db.select<{ name: string }[]>(
        "PRAGMA table_info(projects)",
      );
      const stillHasDataColumn = projectCols.some((c) => c.name === "data");
      if (!stillHasDataColumn) return; // already migrated

      await db.execute("DELETE FROM documents");
      await db.execute(
        `INSERT INTO documents (project_id, data, updated_at)
           SELECT id, data, updated_at FROM projects
           WHERE data IS NOT NULL AND LENGTH(data) > 0`,
      );

      // Rebuild projects without the data column, preserving ids so existing
      // notes.project_id / history.project_id references stay valid.
      await db.execute(`
        CREATE TABLE projects_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL DEFAULT 'Project',
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await db.execute(
        "INSERT INTO projects_new (id, name, updated_at) SELECT id, name, updated_at FROM projects",
      );
      await db.execute("DROP TABLE projects");
      await db.execute("ALTER TABLE projects_new RENAME TO projects");
    },
  },
];

/// Bring the database schema up to date. Reads the current `user_version`,
/// applies every pending migration in order, and stamps the version after
/// each one so an interrupted run resumes from the right place.
export async function runMigrations(db: Database): Promise<void> {
  const rows = await db.select<{ user_version: number }[]>(
    "PRAGMA user_version",
  );
  const current = rows[0]?.user_version ?? 0;

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    await migration.up(db);
    // PRAGMA does not accept bound parameters; the version is one of our own
    // integer literals, so interpolation is safe here.
    await db.execute(`PRAGMA user_version = ${migration.version}`);
  }
}
