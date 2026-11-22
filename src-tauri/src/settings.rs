//! User settings, stored as JSON in the app data folder. Missing or
//! unreadable settings fall back to defaults so the app always starts.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};

/// Must match minWidth / minHeight in tauri.conf.json.
pub const MIN_WIDTH: f64 = 960.0;
pub const MIN_HEIGHT: f64 = 600.0;
const MAX_DIM: f64 = 10_000.0;
const MAX_TOP_GAP_PERCENT: f64 = 20.0;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub window: WindowSettings,
    pub claude: ClaudeSettings,
    pub pilots: PilotSettings,
}

/// What a pilot may do without asking. Pilots run unattended, so anything
/// that would need approval is denied.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PilotPermission {
    /// Claude Code's auto mode: a classifier approves routine actions and blocks risky ones.
    Auto,
    /// File edits only; no shell commands.
    EditsOnly,
    /// Everything allowed (`bypassPermissions`).
    Full,
}

/// Defaults for new pilots; each pilot can override model, budget and turns.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PilotSettings {
    /// Empty means Claude Code's own default model.
    pub model: String,
    pub permission: PilotPermission,
    pub max_concurrent: u32,
    /// Spending cap per run in USD; 0 means no cap.
    pub max_budget_usd: f64,
    /// Agentic turn limit per run; 0 means no limit.
    pub max_turns: u32,
}

impl Default for PilotSettings {
    fn default() -> Self {
        Self { model: String::new(), permission: PilotPermission::Auto, max_concurrent: 2, max_budget_usd: 5.0, max_turns: 0 }
    }
}

/// Model names go on Claude Code's command line, so allow only safe characters.
pub fn valid_model(model: &str) -> bool {
    let m = model.trim();
    m.len() <= 100 && m.chars().all(|c| c.is_ascii_alphanumeric() || "-._:[]".contains(c))
}

/// How the app calls Claude Code for board chat.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ClaudeSettings {
    /// Full path to the `claude` executable. Empty means auto-detect.
    pub path: String,
    /// Model alias or full name passed to `--model`. Empty means Claude Code's default.
    pub model: String,
    /// Lets chat read the board's repo with Read, Glob and Grep. Never writes.
    pub repo_access: bool,
}

impl Default for ClaudeSettings {
    fn default() -> Self {
        Self { path: String::new(), model: String::new(), repo_access: true }
    }
}

/// Window size in logical pixels (scaled with Windows display scaling) and
/// the gap above the title bar as a percent of the monitor's work-area height.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WindowSettings {
    pub width: f64,
    pub height: f64,
    pub top_gap_percent: f64,
}

impl Default for WindowSettings {
    fn default() -> Self {
        Self { width: 1296.0, height: 810.0, top_gap_percent: 0.5 }
    }
}

impl Settings {
    pub fn validate(&self) -> Result<()> {
        let w = &self.window;
        if !(MIN_WIDTH..=MAX_DIM).contains(&w.width) {
            return Err(AppError::msg(format!("Width must be between {MIN_WIDTH} and {MAX_DIM}")));
        }
        if !(MIN_HEIGHT..=MAX_DIM).contains(&w.height) {
            return Err(AppError::msg(format!("Height must be between {MIN_HEIGHT} and {MAX_DIM}")));
        }
        if !(0.0..=MAX_TOP_GAP_PERCENT).contains(&w.top_gap_percent) {
            return Err(AppError::msg(format!("Top gap must be between 0 and {MAX_TOP_GAP_PERCENT}%")));
        }
        if !valid_model(&self.claude.model) || !valid_model(&self.pilots.model) {
            return Err(AppError::msg("Model must be a model alias or name, e.g. sonnet or opus"));
        }
        let p = &self.pilots;
        if !(1..=8).contains(&p.max_concurrent) {
            return Err(AppError::msg("Pilots at once must be between 1 and 8"));
        }
        if !(0.0..=1000.0).contains(&p.max_budget_usd) || !p.max_budget_usd.is_finite() {
            return Err(AppError::msg("Spending cap must be between 0 and 1000 USD"));
        }
        if p.max_turns > 1000 {
            return Err(AppError::msg("Turn limit must be at most 1000"));
        }
        if self.claude.path.len() > 1000 {
            return Err(AppError::msg("Claude path is too long"));
        }
        Ok(())
    }
}

pub fn load(path: &Path) -> Settings {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Settings>(&s).ok())
        .filter(|s| s.validate().is_ok())
        .unwrap_or_default()
}

pub fn save(path: &Path, settings: &Settings) -> Result<()> {
    settings.validate()?;
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, serde_json::to_string_pretty(settings)?)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_fallbacks() {
        let dir = std::env::temp_dir().join(format!("ideation-settings-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");

        assert_eq!(load(&path).window.width, 1296.0); // missing file -> defaults

        let mut s = Settings::default();
        s.window.width = 1500.0;
        s.window.top_gap_percent = 2.0;
        save(&path, &s).unwrap();
        assert_eq!(load(&path).window.width, 1500.0);

        s.window.width = 100.0;
        assert!(save(&path, &s).is_err());

        fs::write(&path, r#"{"window":{"width":5}}"#).unwrap();
        assert_eq!(load(&path).window.width, 1296.0); // invalid -> defaults

        fs::write(&path, r#"{"window":{"topGapPercent":3}}"#).unwrap();
        let partial = load(&path); // missing fields -> per-field defaults
        assert_eq!((partial.window.width, partial.window.top_gap_percent), (1296.0, 3.0));
        assert!(partial.claude.repo_access); // older files without the claude section

        let mut bad = Settings::default();
        bad.claude.model = "opus; rm -rf".into();
        assert!(bad.validate().is_err());
        bad.claude.model = "claude-opus-5-5".into();
        assert!(bad.validate().is_ok());
        assert_eq!(partial.pilots.permission, PilotPermission::Auto);
        bad.pilots.max_concurrent = 0;
        assert!(bad.validate().is_err());

        fs::remove_dir_all(&dir).unwrap();
    }
}
