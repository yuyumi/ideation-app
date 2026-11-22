# Ideation

A Windows desktop app that pairs a whiteboard with Claude Code. Each board is its own git repo. You diagram on the board, ask Claude about it, accept or reject Claude's suggested edits, and launch pilots: freeform Claude Code runs (a small app, an experiment, a set of metrics) that are logged and can be deleted from the UI.

Open source stack: Tauri 2 (Rust), React, Excalidraw, SQLite. Claude Code is not bundled; the app calls the `claude` CLI you have installed, using whatever account it is signed in to.

## Status

| Stage | Scope | State |
|---|---|---|
| 1 | App shell, home screen, create/open boards (one repo each), canvas with autosave, commit board | done |
| 2 | Chat sidebar, Claude's board suggestions as ghost shapes with accept/reject, GitHub publish/push/pull | done |
| 3 | Pilots: queue, git worktree per pilot, live logs, report and results, follow-ups, cleanup | done |
| 4 | Release polish: safe closing, single instance, crash screen, per-user installer, tests in CI | done |

## Board layout

```
<board repo>/
  .board/board.excalidraw   the diagram (committed)
  .board/meta.json          board id, name, created date (committed)
  .board/chat/              chat threads with Claude (gitignored)
  .board/pilots/<id>/       pilot record, prompts and event log (gitignored)
  .pilots/<id>/             pilot worktree on branch pilot/<id> (gitignored)
```

Edits autosave to `.board/board.excalidraw` after a short pause. "Commit board" records a git commit of the board files only; it never stages your other files.

## Chat with Claude

The Claude panel on the right of a board holds conversations about it. Each message sends the whole board, or only your selection, as compact JSON. Claude runs through your installed `claude` CLI in the board's repo, with read-only tools (Read, Glob, Grep) unless you turn repo access off in Settings.

When Claude suggests edits, they appear on the canvas as a translucent preview and as a checklist in the chat. Accept all or some of them, or reject them. Accepting is one undo step. Previews are never saved to the board file.

## Pilots

**Run pilot** in a board's top bar launches Claude Code unattended on the board (or the selected shapes) with your instructions. Each pilot works in its own git worktree on a new branch `pilot/<id>`, so your working copy is never touched, and several can run at once (two by default).

A pilot can build anything: a small app, an experiment, metrics. It finishes with `PILOT_REPORT.md` and puts outputs in `results/`. When a run ends, everything it produced is committed to its branch. The Pilots tab shows each pilot's live activity, report, results (plots and tables inline) and changed files, and lets you continue it with follow-up instructions, stop it, open its folder, push its branch, pin it or delete it. **Clean up…** deletes pilots in bulk by status and age; pinned pilots are never deleted.

Permissions (Settings → Pilots, or per pilot):
- **Auto** (default): Claude Code's auto mode, where a classifier approves routine actions and blocks risky ones. Needs a recent Claude Code and model; if unavailable, the pilot flags it.
- **Edits only**: files only, no commands.
- **Full access**: everything allowed.

Pilots can never `git push`; pushing a pilot branch is always your click. On Windows, a worktree isolates git history, not the machine: commands a pilot runs execute as you.

## GitHub

The GitHub button in a board's top bar publishes the board as a new GitHub repo (private by default), then pushes, pulls (fast-forward only) and checks for updates. It uses the open-source [GitHub CLI](https://cli.github.com): sign in once from the panel or from Settings, and git is configured to use the same login.

## Requirements

- Windows 10 or 11 (WebView2 is installed automatically if missing)
- [Git for Windows](https://git-scm.com/download/win)
- [Claude Code](https://code.claude.com/docs) for chat and pilots (boards work without it)
- [GitHub CLI](https://cli.github.com) for publishing to GitHub: `winget install --id GitHub.cli`

To build from source you also need Node.js 20+ and Rust (via `rustup`, MSVC toolchain).

## Develop

```powershell
npm install
npm run tauri dev
```

Tests: `npm test` (frontend) and `cargo test` in `src-tauri` (backend).

## Build the installer

```powershell
npm run tauri build
```

Installers land in `src-tauri\target\release\bundle\nsis\` (`.exe`) and `...\bundle\msi\` (`.msi`). The `.exe` installs for the current user only and needs no administrator rights.

Or build on GitHub: copy `ci/build-windows.yml` to `.github/workflows/build-windows.yml`, push, and run the `build-windows` workflow from the Actions tab. It runs both test suites first. A manual run uploads the installers as an artifact; pushing a tag such as `v0.1.0` also creates a draft release.

To release a new version, bump `version` in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`, commit, then tag.

## Good to know

- **Closing the app** while pilots or chat replies are running asks first. Stopped pilots show as Interrupted and can be resumed.
- **Only one copy runs at a time.** Launching Ideation again brings the open window to the front.
- **Pilots that never started** (stopped or cut off while queued) have a **Start again** button.
- **Where things live:** app settings and the recent-boards list are in `%APPDATA%\dev.ideation.app`. Everything about a board, including chats and pilots, is inside the board's own folder.

## License

MIT
