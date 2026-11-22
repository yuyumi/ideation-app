//! Locating the user's installed Claude Code CLI. The app never bundles
//! Claude Code; it calls whatever `claude` the user has installed and
//! signed in to. Stage 2 and 3 add chat and pilot runs on top of this.

use std::path::PathBuf;

use crate::process::command;

/// Candidate executables, in order. The native installer puts `claude.exe`
/// in `%USERPROFILE%\.local\bin`; an npm install provides `claude.cmd`.
fn candidates() -> Vec<PathBuf> {
    let mut c = vec![PathBuf::from("claude"), PathBuf::from("claude.cmd")];
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        let bin = PathBuf::from(home).join(".local").join("bin");
        c.push(bin.join("claude.exe"));
        c.push(bin.join("claude"));
    }
    c
}

/// Returns the first candidate that runs, with its reported version.
/// A non-empty `override_path` from settings is the only candidate tried.
pub fn locate(override_path: &str) -> Option<(PathBuf, String)> {
    let list = if override_path.trim().is_empty() {
        candidates()
    } else {
        vec![PathBuf::from(override_path.trim())]
    };
    list.into_iter().find_map(|exe| {
        let out = command(&exe).arg("--version").output().ok()?;
        out.status
            .success()
            .then(|| (exe, String::from_utf8_lossy(&out.stdout).trim().to_string()))
    })
}

/// Parses "2.1.310 (Claude Code)" into (2, 1, 310).
pub fn parse_version(v: &str) -> Option<(u32, u32, u32)> {
    let mut parts = v.split_whitespace().next()?.split('.').map(|p| p.parse::<u32>().ok());
    Some((parts.next()??, parts.next()??, parts.next()??))
}

/// `--permission-prompts none` exists from Claude Code v2.1.259; older
/// versions reject it as an unknown option.
pub fn supports_permission_prompts_flag(version: &str) -> bool {
    parse_version(version).is_some_and(|v| v >= (2, 1, 259))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions() {
        assert_eq!(parse_version("2.1.310 (Claude Code)"), Some((2, 1, 310)));
        assert_eq!(parse_version("garbage"), None);
        assert!(supports_permission_prompts_flag("2.1.259 (Claude Code)"));
        assert!(supports_permission_prompts_flag("2.2.0"));
        assert!(!supports_permission_prompts_flag("2.1.250"));
        assert!(!supports_permission_prompts_flag(""));
    }
}
