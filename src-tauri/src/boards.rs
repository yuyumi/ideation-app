//! A board is a git repo. Its diagram and metadata live in `.board/`
//! and are committed; pilot worktrees and logs are gitignored.
//!
//! ```text
//! <repo>/
//!   .board/board.excalidraw   committed
//!   .board/meta.json          committed
//!   .board/chat/              ignored: chat threads with Claude
//!   .board/pilots/            ignored: pilot logs + db (stage 3)
//!   .pilots/                  ignored: pilot git worktrees (stage 3)
//! ```

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::git;

pub const BOARD_DIR: &str = ".board";
const BOARD_FILE: &str = "board.excalidraw";
const META_FILE: &str = "meta.json";
const BOARD_FILE_REL: &str = ".board/board.excalidraw";
const META_FILE_REL: &str = ".board/meta.json";
const IGNORE_LINES: &[&str] = &[".pilots/", ".board/pilots/", ".board/chat/"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardMeta {
    pub id: String,
    pub name: String,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardInfo {
    pub path: String,
    #[serde(flatten)]
    pub meta: BoardMeta,
}

pub fn board_file(repo: &Path) -> PathBuf {
    repo.join(BOARD_DIR).join(BOARD_FILE)
}

fn meta_file(repo: &Path) -> PathBuf {
    repo.join(BOARD_DIR).join(META_FILE)
}

/// Rejects names that are not valid Windows folder names.
fn validate_name(name: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::msg("Board name cannot be empty"));
    }
    if name.chars().count() > 100 {
        return Err(AppError::msg("Board name must be at most 100 characters"));
    }
    if name.chars().any(|c| c.is_control() || r#"<>:"/\|?*"#.contains(c)) {
        return Err(AppError::msg(r#"Board name cannot contain < > : " / \ | ? *"#));
    }
    if name.ends_with('.') || name.starts_with('.') {
        return Err(AppError::msg("Board name cannot start or end with a dot"));
    }
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = ["CON", "PRN", "AUX", "NUL"];
    let numbered = (stem.starts_with("COM") || stem.starts_with("LPT"))
        && stem.len() == 4
        && stem.as_bytes()[3].is_ascii_digit();
    if reserved.contains(&stem.as_str()) || numbered {
        return Err(AppError::msg(format!("\"{name}\" is a reserved name on Windows")));
    }
    Ok(name.to_string())
}

fn empty_scene() -> serde_json::Value {
    // Clean, non-sketchy defaults: zero roughness and the Nunito font (id 6).
    serde_json::json!({
        "type": "excalidraw",
        "version": 2,
        "source": "ideation-app",
        "elements": [],
        "appState": {
            "viewBackgroundColor": "#ffffff",
            "currentItemRoughness": 0,
            "currentItemFontFamily": 6,
            "gridSize": 20
        },
        "files": {}
    })
}

/// Appends any missing ignore rules for pilot data to the repo's .gitignore.
fn ensure_gitignore(repo: &Path) -> Result<()> {
    let path = repo.join(".gitignore");
    let existing = fs::read_to_string(&path).unwrap_or_default();
    let missing: Vec<&str> = IGNORE_LINES
        .iter()
        .copied()
        .filter(|l| !existing.lines().any(|e| e.trim() == *l))
        .collect();
    if missing.is_empty() {
        return Ok(());
    }
    let mut out = existing;
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    if !out.contains("# Ideation local data") {
        out.push_str("# Ideation local data\n");
    }
    for l in missing {
        out.push_str(l);
        out.push('\n');
    }
    fs::write(path, out)?;
    Ok(())
}

/// Writes via a temp file and rename so a crash never leaves a half-written board.
fn write_atomic(path: &Path, contents: &[u8]) -> Result<()> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, contents)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

pub fn create(parent: &Path, name: &str) -> Result<BoardInfo> {
    let name = validate_name(name)?;
    if !parent.is_dir() {
        return Err(AppError::msg(format!("{} is not a folder", parent.display())));
    }
    let repo = parent.join(&name);
    if repo.exists() {
        return Err(AppError::msg(format!("{} already exists", repo.display())));
    }
    fs::create_dir(&repo)?;

    let result = (|| -> Result<BoardInfo> {
        git::init(&repo)?;
        fs::create_dir_all(repo.join(BOARD_DIR))?;
        let meta = BoardMeta {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.clone(),
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        fs::write(meta_file(&repo), serde_json::to_string_pretty(&meta)?)?;
        fs::write(board_file(&repo), serde_json::to_string_pretty(&empty_scene())?)?;
        fs::write(
            repo.join("README.md"),
            format!("# {name}\n\nBoard created with Ideation. The diagram lives in `.board/board.excalidraw`.\n"),
        )?;
        ensure_gitignore(&repo)?;
        git::commit_paths(
            &repo,
            &[".gitignore", "README.md", BOARD_FILE_REL, META_FILE_REL],
            &format!("Create board \"{name}\""),
        )?;
        Ok(BoardInfo { path: repo.display().to_string(), meta })
    })();

    if result.is_err() {
        // The folder was created by us a moment ago, so removing it is safe.
        let _ = fs::remove_dir_all(&repo);
    }
    result
}

pub fn open(repo: &Path) -> Result<BoardInfo> {
    if !board_file(repo).is_file() {
        return Err(AppError::msg(format!(
            "{} is not an Ideation board (no {BOARD_FILE_REL})",
            repo.display()
        )));
    }
    if !repo.join(".git").exists() {
        return Err(AppError::msg(format!("{} is not a git repository", repo.display())));
    }
    let meta = match fs::read_to_string(meta_file(repo)) {
        Ok(s) => serde_json::from_str(&s)?,
        Err(_) => BoardMeta {
            id: uuid::Uuid::new_v4().to_string(),
            name: repo
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "Untitled".into()),
            created_at: chrono::Utc::now().to_rfc3339(),
        },
    };
    ensure_gitignore(repo)?;
    Ok(BoardInfo { path: repo.display().to_string(), meta })
}

pub fn load_scene(repo: &Path) -> Result<String> {
    Ok(fs::read_to_string(board_file(repo))?)
}

pub fn save_scene(repo: &Path, scene: &str) -> Result<()> {
    let parsed: serde_json::Value = serde_json::from_str(scene)?;
    if parsed.get("type").and_then(|t| t.as_str()) != Some("excalidraw") {
        return Err(AppError::msg("Refusing to save: not an Excalidraw scene"));
    }
    write_atomic(&board_file(repo), scene.as_bytes())
}

pub fn commit(repo: &Path, message: &str) -> Result<bool> {
    let message = if message.trim().is_empty() { "Update board" } else { message.trim() };
    git::commit_paths(repo, &[BOARD_FILE_REL, META_FILE_REL], message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert!(validate_name("My board").is_ok());
        assert!(validate_name("  ").is_err());
        assert!(validate_name("a/b").is_err());
        assert!(validate_name("CON").is_err());
        assert!(validate_name("com1.txt").is_err());
        assert!(validate_name("COMET").is_ok());
        assert!(validate_name(".hidden").is_err());
    }

    #[test]
    fn create_open_save_commit() {
        let parent = std::env::temp_dir().join(format!("ideation-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&parent).unwrap();
        let info = create(&parent, "Test board").unwrap();
        let repo = PathBuf::from(&info.path);
        assert!(board_file(&repo).is_file());
        assert!(create(&parent, "Test board").is_err());

        let opened = open(&repo).unwrap();
        assert_eq!(opened.meta.id, info.meta.id);

        let mut scene: serde_json::Value = serde_json::from_str(&load_scene(&repo).unwrap()).unwrap();
        scene["elements"] = serde_json::json!([{ "id": "x", "type": "rectangle" }]);
        save_scene(&repo, &scene.to_string()).unwrap();
        assert!(commit(&repo, "edit").unwrap());
        assert!(!commit(&repo, "edit again").unwrap());
        assert!(save_scene(&repo, "{\"type\":\"other\"}").is_err());

        let log = git::run(&repo, &["log", "--oneline"]).unwrap();
        assert_eq!(log.lines().count(), 2);
        fs::remove_dir_all(&parent).unwrap();
    }
}
