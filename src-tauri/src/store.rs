use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::error::Result;

/// App-wide index of boards the user has opened. Board contents live in
/// each board's own repo; this only remembers where they are.
pub struct Store {
    conn: Mutex<Connection>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentBoard {
    pub path: String,
    pub name: String,
    pub last_opened: String,
    pub exists: bool,
}

impl Store {
    pub fn open(db_path: &Path) -> Result<Self> {
        let conn = Connection::open(db_path)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS recent_boards (
                path TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                last_opened TEXT NOT NULL
            );",
        )?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    pub fn touch(&self, path: &str, name: &str) -> Result<()> {
        let now = chrono::Utc::now().to_rfc3339();
        self.conn.lock().unwrap().execute(
            "INSERT INTO recent_boards (path, name, last_opened) VALUES (?1, ?2, ?3)
             ON CONFLICT(path) DO UPDATE SET name = excluded.name, last_opened = excluded.last_opened",
            params![path, name, now],
        )?;
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<RecentBoard>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT path, name, last_opened FROM recent_boards ORDER BY last_opened DESC LIMIT 50",
        )?;
        let rows = stmt.query_map([], |r| {
            let path: String = r.get(0)?;
            let exists = crate::boards::board_file(Path::new(&path)).is_file();
            Ok(RecentBoard { path, name: r.get(1)?, last_opened: r.get(2)?, exists })
        })?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    /// Removes a board from the recent list. Never touches files on disk.
    pub fn forget(&self, path: &str) -> Result<()> {
        self.conn
            .lock()
            .unwrap()
            .execute("DELETE FROM recent_boards WHERE path = ?1", params![path])?;
        Ok(())
    }
}
