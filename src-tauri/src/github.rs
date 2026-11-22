//! GitHub integration through the official GitHub CLI (`gh`, MIT licensed).
//! Signing in runs `gh auth login` in a console window and registers `gh`
//! as git's credential helper, so plain `git push` and `git pull` work too.

use std::path::Path;
use std::process::Command;

use serde::Serialize;

use crate::error::{AppError, Result};
use crate::git;
use crate::process::command;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhStatus {
    pub installed: bool,
    pub version: Option<String>,
    /// GitHub login when signed in.
    pub user: Option<String>,
}

#[derive(Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    pub remote_url: Option<String>,
    pub web_url: Option<String>,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// Changed or untracked files not yet committed.
    pub uncommitted: usize,
}

/// Never let gh or git wait on a terminal prompt nobody can see.
fn quiet(mut cmd: Command) -> Command {
    cmd.env("GH_PROMPT_DISABLED", "1").env("GIT_TERMINAL_PROMPT", "0").env("NO_COLOR", "1");
    cmd
}

fn gh(repo: Option<&Path>, args: &[&str]) -> Result<String> {
    let mut cmd = quiet(command("gh"));
    if let Some(r) = repo {
        cmd.current_dir(r);
    }
    let out = cmd
        .args(args)
        .output()
        .map_err(|e| AppError::msg(format!("could not run gh ({e}); is the GitHub CLI installed?")))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(AppError::msg(String::from_utf8_lossy(&out.stderr).trim().to_string()))
    }
}

pub fn git_quiet(repo: &Path, args: &[&str]) -> Result<String> {
    let out = quiet(command("git"))
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map_err(|e| AppError::msg(format!("could not run git ({e})")))?;
    if out.status.success() {
        let mut s = String::from_utf8_lossy(&out.stdout).to_string();
        s.push_str(&String::from_utf8_lossy(&out.stderr));
        Ok(s.trim().to_string())
    } else {
        Err(AppError::msg(format!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        )))
    }
}

pub fn status() -> GhStatus {
    let version = gh(None, &["--version"]).ok().and_then(|v| v.lines().next().map(String::from));
    let user = version.as_ref().and_then(|_| gh(None, &["api", "user", "--jq", ".login"]).ok()).filter(|u| !u.is_empty());
    GhStatus { installed: version.is_some(), version, user }
}

/// Opens a console window running the interactive GitHub sign-in.
pub fn login_in_terminal() -> Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        Command::new("cmd")
            .raw_arg(
                r#"/C start "Sign in to GitHub" cmd /K "gh auth login --hostname github.com --git-protocol https --web && gh auth setup-git && echo. && echo Signed in. You can close this window.""#,
            )
            .spawn()?;
        Ok(())
    }
    #[cfg(not(windows))]
    Err(AppError::msg("Run `gh auth login --web` and `gh auth setup-git` in a terminal."))
}

/// Accounts you can publish under: your user first, then your organizations.
pub fn owners() -> Result<Vec<String>> {
    let mut list = vec![gh(None, &["api", "user", "--jq", ".login"])?];
    if let Ok(orgs) = gh(None, &["api", "user/orgs", "--jq", ".[].login"]) {
        list.extend(orgs.lines().map(str::trim).filter(|l| !l.is_empty()).map(String::from));
    }
    Ok(list)
}

/// https://github.com/owner/repo for https and ssh GitHub remotes.
pub fn web_url(remote: &str) -> Option<String> {
    let rest = remote
        .strip_prefix("https://github.com/")
        .or_else(|| remote.strip_prefix("git@github.com:"))
        .or_else(|| remote.strip_prefix("ssh://git@github.com/"))?;
    let rest = rest.trim_end_matches('/').trim_end_matches(".git");
    (rest.split('/').count() == 2).then(|| format!("https://github.com/{rest}"))
}

/// Parses `git status --porcelain=v1 --branch`.
pub fn parse_status(porcelain: &str) -> RemoteStatus {
    let mut s = RemoteStatus::default();
    let mut lines = porcelain.lines();
    if let Some(head) = lines.next().and_then(|l| l.strip_prefix("## ")) {
        let (refs, counts) = match head.split_once(" [") {
            Some((r, c)) => (r, c.trim_end_matches(']')),
            None => (head, ""),
        };
        let refs = refs.strip_prefix("No commits yet on ").unwrap_or(refs);
        match refs.split_once("...") {
            Some((b, u)) => {
                s.branch = Some(b.to_string());
                s.upstream = Some(u.to_string());
            }
            None => s.branch = Some(refs.to_string()),
        }
        for part in counts.split(", ") {
            if let Some(n) = part.strip_prefix("ahead ") {
                s.ahead = n.parse().unwrap_or(0);
            } else if let Some(n) = part.strip_prefix("behind ") {
                s.behind = n.parse().unwrap_or(0);
            }
        }
    }
    s.uncommitted = lines.filter(|l| !l.trim().is_empty()).count();
    s
}

pub fn remote_status(repo: &Path) -> Result<RemoteStatus> {
    let mut s = parse_status(&git::run(repo, &["status", "--porcelain=v1", "--branch"])?);
    s.remote_url = git::run(repo, &["remote", "get-url", "origin"]).ok().map(|u| u.trim().to_string());
    s.web_url = s.remote_url.as_deref().and_then(web_url);
    Ok(s)
}

pub fn fetch(repo: &Path) -> Result<RemoteStatus> {
    git_quiet(repo, &["fetch", "--quiet", "origin"])?;
    remote_status(repo)
}

fn valid_github_name(s: &str) -> bool {
    !s.is_empty() && s.len() <= 100 && s != "." && s != ".." && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
}

/// Creates the GitHub repo, adds it as `origin` and pushes the current branch.
pub fn publish(repo: &Path, owner: &str, name: &str, private: bool, description: &str) -> Result<RemoteStatus> {
    if !valid_github_name(owner) || !valid_github_name(name) {
        return Err(AppError::msg("Owner and repo name may only contain letters, digits, '-', '_' and '.'"));
    }
    if git::run(repo, &["remote", "get-url", "origin"]).is_ok() {
        return Err(AppError::msg("This board already has an 'origin' remote"));
    }
    let full = format!("{owner}/{name}");
    let visibility = if private { "--private" } else { "--public" };
    let mut args = vec!["repo", "create", &full, visibility, "--source", ".", "--remote", "origin", "--push"];
    let description = description.trim();
    if !description.is_empty() {
        args.extend(["--description", description]);
    }
    gh(Some(repo), &args)?;
    remote_status(repo)
}

pub fn push(repo: &Path) -> Result<RemoteStatus> {
    let s = remote_status(repo)?;
    if s.remote_url.is_none() {
        return Err(AppError::msg("No GitHub remote yet. Publish the board first."));
    }
    if s.upstream.is_some() {
        git_quiet(repo, &["push"])?;
    } else {
        git_quiet(repo, &["push", "--set-upstream", "origin", "HEAD"])?;
    }
    remote_status(repo)
}

/// Fast-forward only, so a pull can never create a merge or rewrite history.
pub fn pull(repo: &Path) -> Result<RemoteStatus> {
    git_quiet(repo, &["pull", "--ff-only"])?;
    remote_status(repo)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn web_urls() {
        assert_eq!(web_url("https://github.com/yuyumi/board.git").as_deref(), Some("https://github.com/yuyumi/board"));
        assert_eq!(web_url("git@github.com:yuyumi/board.git").as_deref(), Some("https://github.com/yuyumi/board"));
        assert_eq!(web_url("https://gitlab.com/a/b"), None);
    }

    #[test]
    fn status_lines() {
        let s = parse_status("## main...origin/main [ahead 2, behind 1]\n M a.txt\n?? b.txt\n");
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert_eq!(s.upstream.as_deref(), Some("origin/main"));
        assert_eq!((s.ahead, s.behind, s.uncommitted), (2, 1, 2));

        let s = parse_status("## main\n");
        assert_eq!((s.branch.as_deref(), s.upstream.as_deref(), s.uncommitted), (Some("main"), None, 0));

        let s = parse_status("## main...origin/main [behind 3]\n");
        assert_eq!((s.ahead, s.behind), (0, 3));

        let s = parse_status("## No commits yet on main\n");
        assert_eq!(s.branch.as_deref(), Some("main"));
    }

    #[test]
    fn names() {
        assert!(valid_github_name("my-board_1.0"));
        assert!(!valid_github_name("a b"));
        assert!(!valid_github_name(".."));
        assert!(!valid_github_name("a/b"));
    }
}
