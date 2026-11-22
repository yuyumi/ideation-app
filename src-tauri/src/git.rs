use std::path::Path;

use crate::error::{AppError, Result};
use crate::process::command;

/// Identity used for commits when the user has no git identity configured.
const FALLBACK_NAME: &str = "Ideation";
const FALLBACK_EMAIL: &str = "ideation@localhost";

pub fn version() -> Option<String> {
    let out = command("git").arg("--version").output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Runs git in `repo` and returns stdout, or an error carrying stderr.
pub fn run(repo: &Path, args: &[&str]) -> Result<String> {
    let out = command("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map_err(|e| AppError::msg(format!("could not run git ({e}); is Git for Windows installed?")))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(AppError::msg(format!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        )))
    }
}

pub fn init(repo: &Path) -> Result<()> {
    run(repo, &["init", "-b", "main"]).map(|_| ())
}

fn has_identity(repo: &Path) -> bool {
    let get = |key: &str| {
        run(repo, &["config", "--get", key])
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
    };
    get("user.name") && get("user.email")
}

/// Stages `paths` and commits them. Returns false when there was nothing to commit.
pub fn commit_paths(repo: &Path, paths: &[&str], message: &str) -> Result<bool> {
    let mut add = vec!["add", "--"];
    add.extend_from_slice(paths);
    run(repo, &add)?;

    // `git diff --cached --quiet` exits 1 when staged changes exist.
    let mut diff_args = vec!["-C".to_string(), repo.display().to_string()];
    diff_args.extend(["diff", "--cached", "--quiet", "--"].map(String::from));
    diff_args.extend(paths.iter().map(|p| p.to_string()));
    let status = command("git").args(&diff_args).status()?;
    if status.success() {
        return Ok(false);
    }

    let name_cfg = format!("user.name={FALLBACK_NAME}");
    let email_cfg = format!("user.email={FALLBACK_EMAIL}");
    let mut commit: Vec<&str> = Vec::new();
    if !has_identity(repo) {
        commit.extend(["-c", &name_cfg, "-c", &email_cfg]);
    }
    commit.extend(["commit", "-m", message, "--"]);
    commit.extend_from_slice(paths);
    run(repo, &commit)?;
    Ok(true)
}
