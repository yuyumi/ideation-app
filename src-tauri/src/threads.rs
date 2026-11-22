//! Chat threads, one JSON file each in `<board>/.board/chat/` (gitignored).
//! The frontend owns the thread structure; this module stores it safely.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use crate::error::{AppError, Result};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSummary {
    pub id: String,
    pub title: String,
    pub updated_at: String,
    pub message_count: usize,
}

fn chat_dir(board: &Path) -> PathBuf {
    board.join(crate::boards::BOARD_DIR).join("chat")
}

/// Thread ids become file names, so allow only a safe character set.
fn thread_file(board: &Path, id: &str) -> Result<PathBuf> {
    let ok = !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if !ok {
        return Err(AppError::msg(format!("invalid thread id {id:?}")));
    }
    Ok(chat_dir(board).join(format!("{id}.json")))
}

pub fn list(board: &Path) -> Result<Vec<ThreadSummary>> {
    let dir = chat_dir(board);
    let Ok(entries) = fs::read_dir(&dir) else {
        return Ok(vec![]);
    };
    let mut out: Vec<ThreadSummary> = entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| {
            let v: Value = serde_json::from_str(&fs::read_to_string(e.path()).ok()?).ok()?;
            Some(ThreadSummary {
                id: v["id"].as_str()?.to_string(),
                title: v["title"].as_str().unwrap_or("Untitled").to_string(),
                updated_at: v["updatedAt"].as_str().unwrap_or("").to_string(),
                message_count: v["messages"].as_array().map_or(0, Vec::len),
            })
        })
        .collect();
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(out)
}

pub fn load(board: &Path, id: &str) -> Result<Value> {
    Ok(serde_json::from_str(&fs::read_to_string(thread_file(board, id)?)?)?)
}

pub fn save(board: &Path, thread: &Value) -> Result<()> {
    let id = thread["id"].as_str().ok_or_else(|| AppError::msg("thread has no id"))?;
    let path = thread_file(board, id)?;
    fs::create_dir_all(chat_dir(board))?;
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, serde_json::to_string_pretty(thread)?)?;
    fs::rename(&tmp, &path)?;
    Ok(())
}

/// Deletes a chat thread file. Threads are app data in a gitignored folder.
pub fn delete(board: &Path, id: &str) -> Result<()> {
    let path = thread_file(board, id)?;
    if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let board = std::env::temp_dir().join(format!("ideation-threads-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&board).unwrap();
        assert!(list(&board).unwrap().is_empty());
        let t1 = serde_json::json!({"id": "a1", "title": "First", "updatedAt": "2026-01-01", "messages": [1, 2]});
        let t2 = serde_json::json!({"id": "b2", "title": "Second", "updatedAt": "2026-02-01", "messages": []});
        save(&board, &t1).unwrap();
        save(&board, &t2).unwrap();
        let l = list(&board).unwrap();
        assert_eq!(l.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["b2", "a1"]);
        assert_eq!(l[1].message_count, 2);
        assert_eq!(load(&board, "a1").unwrap()["title"], "First");
        assert!(save(&board, &serde_json::json!({"id": "../evil"})).is_err());
        assert!(load(&board, "..\\x").is_err());
        delete(&board, "a1").unwrap();
        assert_eq!(list(&board).unwrap().len(), 1);
        fs::remove_dir_all(&board).unwrap();
    }
}
