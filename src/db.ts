import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import * as fs from 'fs';
import * as path from 'path';

let db: SqlJsDatabase;
let dbPath: string;

export async function initDb(dataDir: string): Promise<void> {
  const SQL = await initSqlJs();
  dbPath = path.join(dataDir, 'management.db');

  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS apps (
      name TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('static', 'docker', 'docker-compose')),
      prefix TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'running',
      config TEXT NOT NULL DEFAULT '{}',
      container_id TEXT,
      icon TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  saveDb();

  // Migration: remove old CHECK constraint if it only allowed 'static' and 'docker'
  const results = db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='apps'");
  if (results.length > 0) {
    const sql = results[0].values[0][0] as string;
    if (sql.includes("CHECK(type IN ('static', 'docker'))")) {
      db.run("ALTER TABLE apps RENAME TO apps_old");
      db.run(`CREATE TABLE apps (
        name TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        prefix TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'running',
        config TEXT NOT NULL DEFAULT '{}',
        container_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);
      db.run(`INSERT INTO apps (name, type, prefix, status, config, container_id, created_at, updated_at)
        SELECT name, type, prefix, status, config, container_id, created_at, updated_at FROM apps_old`);
      db.run("DROP TABLE apps_old");
      saveDb();
      console.log('Migrated apps table: removed old CHECK constraint');
    }
  }

  // Migration: add icon column to existing databases (the CHECK migration above
  // recreates the table without it, so this must run after either schema path).
  const cols = db.exec("PRAGMA table_info(apps)")[0].values.map(r => r[1] as string);
  if (!cols.includes('icon')) {
    db.run("ALTER TABLE apps ADD COLUMN icon TEXT NOT NULL DEFAULT ''");
    saveDb();
    console.log('Migrated apps table: added icon column');
  }
}

export function saveDb(): void {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(dbPath, buffer);
}

export interface AppRow {
  name: string;
  type: 'static' | 'docker' | 'docker-compose';
  prefix: string;
  status: 'running' | 'stopped' | 'error';
  config: string;
  container_id: string | null;
  icon: string;
  created_at: string;
  updated_at: string;
}

export function listApps(): AppRow[] {
  const stmt = db.prepare('SELECT * FROM apps ORDER BY created_at DESC');
  const rows: AppRow[] = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject() as unknown as AppRow);
  }
  stmt.free();
  return rows;
}

export function getApp(name: string): AppRow | null {
  const stmt = db.prepare('SELECT * FROM apps WHERE name = ?');
  stmt.bind([name]);
  if (stmt.step()) {
    const row = stmt.getAsObject() as unknown as AppRow;
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

export function appExists(name: string): boolean {
  return getApp(name) !== null;
}

export function createApp(app: AppRow): void {
  db.run(
    'INSERT INTO apps (name, type, prefix, status, config, container_id, icon, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [app.name, app.type, app.prefix, app.status, app.config, app.container_id, app.icon, app.created_at, app.updated_at]
  );
  saveDb();
}

export function updateApp(name: string, updates: Partial<Pick<AppRow, 'status' | 'config' | 'container_id' | 'prefix' | 'icon'>> & { updated_at: string }): void {
  const setClauses: string[] = [];
  const values: (string | null)[] = [];

  for (const [key, value] of Object.entries(updates)) {
    setClauses.push(`${key} = ?`);
    values.push(value);
  }

  values.push(name);
  db.run(`UPDATE apps SET ${setClauses.join(', ')} WHERE name = ?`, values);
  saveDb();
}

export function deleteApp(name: string): void {
  db.run('DELETE FROM apps WHERE name = ?', [name]);
  saveDb();
}
