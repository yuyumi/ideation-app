//! Pilots: unattended Claude Code runs launched from a board.
//!
//! Each pilot gets a git worktree at `<board>/.pilots/<id>` on branch
//! `pilot/<id>`, so it never touches the user's working copy. Its record,
//! prompts and raw event log live in `<board>/.board/pilots/<id>/`. Both
//! folders are gitignored. When a run ends, everything in the worktree is
//! committed to the pilot branch.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Runtime};

use crate::error::{AppError, Result};
use crate::git;
use crate::process::command;
use crate::settings::PilotPermission;

const SYSTEM_PROMPT: &str = include_str!("pilot_prompt.md");
pub const REPORT_FILE: &str = "PILOT_REPORT.md";
pub const RESULTS_DIR: &str = "results";
const META_FILE: &str = "pilot.json";
/// The first run's full prompt, kept so a pilot that never started can start again.
const INITIAL_PROMPT_FILE: &str = "prompt-initial.md";
const EVENTS_FILE: &str = "events.jsonl";
/// Pilots must never publish anything; pushing is the user's call.
const BLOCKED_TOOLS: &str = "Bash(git push *),Bash(git push),PowerShell(git push *),PowerShell(git push)";
const MAX_ACTIVITY: usize = 3000;
const MAX_TEXT_FILE: u64 = 1024 * 1024;
const MAX_IMAGE_FILE: u64 = 15 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum PilotStatus {
    #[default]
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
    /// The app closed while the pilot was queued or running.
    Interrupted,
}

impl PilotStatus {
    pub fn is_active(self) -> bool {
        matches!(self, PilotStatus::Queued | PilotStatus::Running)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Tokens {
    pub input: u64,
    pub cache_write: u64,
    pub cache_read: u64,
    pub output: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FollowUp {
    pub at: String,
    pub instructions: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PilotMeta {
    pub id: String,
    pub title: String,
    pub instructions: String,
    pub scope: String,
    /// Requested model; empty means Claude Code's default.
    pub model: String,
    pub permission: PilotPermission,
    pub max_budget_usd: f64,
    pub max_turns: u32,
    pub status: PilotStatus,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub branch: String,
    pub base_commit: Option<String>,
    pub result_commit: Option<String>,
    pub session_id: Option<String>,
    /// Model and permission mode Claude Code reported at startup.
    pub model_used: Option<String>,
    pub permission_mode: Option<String>,
    /// Claude Code's cost estimate for the pilot's session, all runs included.
    pub cost_usd: Option<f64>,
    pub tokens: Tokens,
    pub runs: u32,
    pub duration_ms: u64,
    pub denials: Vec<String>,
    pub error: Option<String>,
    pub pinned: bool,
    pub has_report: bool,
    pub follow_ups: Vec<FollowUp>,
}

impl Default for PilotMeta {
    fn default() -> Self {
        Self {
            id: String::new(),
            title: String::new(),
            instructions: String::new(),
            scope: "board".into(),
            model: String::new(),
            permission: PilotPermission::Auto,
            max_budget_usd: 0.0,
            max_turns: 0,
            status: PilotStatus::Queued,
            created_at: String::new(),
            started_at: None,
            finished_at: None,
            branch: String::new(),
            base_commit: None,
            result_commit: None,
            session_id: None,
            model_used: None,
            permission_mode: None,
            cost_usd: None,
            tokens: Tokens::default(),
            runs: 0,
            duration_ms: 0,
            denials: vec![],
            error: None,
            pinned: false,
            has_report: false,
            follow_ups: vec![],
        }
    }
}

/// One line in a pilot's activity feed.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    /// text, tool, system, result or error
    pub kind: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PilotEvent {
    pub board_path: String,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<PilotMeta>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity: Option<Activity>,
}

// ---- Paths and storage ----

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn check_id(id: &str) -> Result<()> {
    if valid_id(id) {
        Ok(())
    } else {
        Err(AppError::msg(format!("invalid pilot id {id:?}")))
    }
}

pub fn pilots_dir(board: &Path) -> PathBuf {
    board.join(crate::boards::BOARD_DIR).join("pilots")
}

fn record_dir(board: &Path, id: &str) -> PathBuf {
    pilots_dir(board).join(id)
}

fn worktree_rel(id: &str) -> String {
    format!(".pilots/{id}")
}

pub fn worktree(board: &Path, id: &str) -> PathBuf {
    board.join(".pilots").join(id)
}

fn new_id() -> String {
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let rand = &uuid::Uuid::new_v4().simple().to_string()[..4];
    format!("{stamp}-{rand}")
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

pub fn save_meta(board: &Path, meta: &PilotMeta) -> Result<()> {
    let dir = record_dir(board, &meta.id);
    fs::create_dir_all(&dir)?;
    let path = dir.join(META_FILE);
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, serde_json::to_string_pretty(meta)?)?;
    fs::rename(&tmp, &path)?;
    Ok(())
}

pub fn load_meta(board: &Path, id: &str) -> Result<PilotMeta> {
    check_id(id)?;
    let text = fs::read_to_string(record_dir(board, id).join(META_FILE))
        .map_err(|_| AppError::msg(format!("pilot {id} not found")))?;
    Ok(serde_json::from_str(&text)?)
}

fn list_metas(board: &Path) -> Vec<PilotMeta> {
    let Ok(entries) = fs::read_dir(pilots_dir(board)) else {
        return vec![];
    };
    let mut out: Vec<PilotMeta> = entries
        .flatten()
        .filter_map(|e| fs::read_to_string(e.path().join(META_FILE)).ok())
        .filter_map(|t| serde_json::from_str(&t).ok())
        .collect();
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    out
}

// ---- Parsing Claude Code's stream-json output ----

fn short(s: &str, n: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= n {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(n).collect::<String>())
    }
}

fn tool_detail(input: &Value) -> Option<String> {
    ["command", "file_path", "pattern", "path", "url", "description"]
        .iter()
        .find_map(|k| input.get(*k).and_then(Value::as_str))
        .map(|s| short(s, 300))
}

/// Activity feed entries for one line of Claude Code output.
pub fn parse_activity(line: &str) -> Vec<Activity> {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return vec![];
    };
    let act = |kind: &str, text: String, detail: Option<String>| Activity { kind: kind.into(), text, detail };
    match (v["type"].as_str(), v["subtype"].as_str()) {
        (Some("system"), Some("init")) => vec![act(
            "system",
            format!(
                "Started with {} in {} mode",
                v["model"].as_str().unwrap_or("default model"),
                v["permissionMode"].as_str().unwrap_or("unknown")
            ),
            None,
        )],
        (Some("system"), Some("api_retry")) => vec![act(
            "system",
            format!("API retry {} ({})", v["attempt"].as_u64().unwrap_or(0), v["error"].as_str().unwrap_or("error")),
            None,
        )],
        (Some("system"), Some(sub)) if sub.contains("denied") => {
            vec![act("error", "Action denied".into(), Some(short(&v.to_string(), 300)))]
        }
        (Some("assistant"), _) => v["message"]["content"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|c| match c["type"].as_str() {
                        Some("text") => c["text"].as_str().filter(|t| !t.trim().is_empty()).map(|t| act("text", t.to_string(), None)),
                        Some("tool_use") => Some(act("tool", c["name"].as_str().unwrap_or("tool").to_string(), tool_detail(&c["input"]))),
                        _ => None,
                    })
                    .collect()
            })
            .unwrap_or_default(),
        (Some("result"), sub) => {
            let ok = sub == Some("success") && !v["is_error"].as_bool().unwrap_or(false);
            let cost = v["total_cost_usd"].as_f64().map(|c| format!(", ${c:.3} so far")).unwrap_or_default();
            vec![act(
                if ok { "result" } else { "error" },
                format!("{}{cost}", if ok { "Finished" } else { "Finished with an error" }),
                v["result"].as_str().map(|r| short(r, 2000)),
            )]
        }
        _ => vec![],
    }
}

/// Facts gathered from one run's output.
#[derive(Default, Debug, PartialEq)]
pub struct RunFacts {
    pub session_id: Option<String>,
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    pub finished: bool,
    pub is_error: bool,
    pub result_text: Option<String>,
    pub total_cost_usd: Option<f64>,
    pub duration_ms: u64,
    pub denials: Vec<String>,
    /// Usage per API message id; the same message can appear on several lines.
    pub usage: HashMap<String, Tokens>,
}

impl RunFacts {
    pub fn observe(&mut self, line: &str) {
        let Ok(v) = serde_json::from_str::<Value>(line) else { return };
        match v["type"].as_str() {
            Some("system") if v["subtype"] == "init" => {
                self.session_id = v["session_id"].as_str().map(String::from).or(self.session_id.take());
                self.model = v["model"].as_str().map(String::from);
                self.permission_mode = v["permissionMode"].as_str().map(String::from);
            }
            Some("assistant") => {
                let m = &v["message"];
                if let (Some(id), Some(u)) = (m["id"].as_str(), m.get("usage")) {
                    let n = |k: &str| u.get(k).and_then(Value::as_u64).unwrap_or(0);
                    self.usage.insert(
                        id.to_string(),
                        Tokens {
                            input: n("input_tokens"),
                            cache_write: n("cache_creation_input_tokens"),
                            cache_read: n("cache_read_input_tokens"),
                            output: n("output_tokens"),
                        },
                    );
                }
            }
            Some("result") => {
                self.finished = true;
                self.is_error = v["is_error"].as_bool().unwrap_or(false) || v["subtype"].as_str() != Some("success");
                self.result_text = v["result"].as_str().map(String::from);
                self.total_cost_usd = v["total_cost_usd"].as_f64();
                self.duration_ms = v["duration_ms"].as_u64().unwrap_or(0);
                if let Some(s) = v["session_id"].as_str() {
                    self.session_id = Some(s.to_string());
                }
                if let Some(d) = v["permission_denials"].as_array() {
                    self.denials = d
                        .iter()
                        .map(|x| {
                            let tool = x["tool_name"].as_str().unwrap_or("tool");
                            match tool_detail(&x["tool_input"]) {
                                Some(detail) => format!("{tool}: {detail}"),
                                None => tool.to_string(),
                            }
                        })
                        .collect();
                }
            }
            _ => {}
        }
    }

    pub fn tokens(&self) -> Tokens {
        self.usage.values().fold(Tokens::default(), |a, t| Tokens {
            input: a.input + t.input,
            cache_write: a.cache_write + t.cache_write,
            cache_read: a.cache_read + t.cache_read,
            output: a.output + t.output,
        })
    }
}

// ---- Queue and runner ----

/// Settings a run needs, captured when it is queued.
#[derive(Clone, Debug)]
pub struct RunConfig {
    pub claude_exe: PathBuf,
    pub permission_prompts_flag: bool,
    pub max_concurrent: u32,
}

struct Job {
    board: PathBuf,
    id: String,
    prompt: String,
    resume: Option<String>,
}

#[derive(Default)]
struct State {
    queue: VecDeque<Job>,
    /// Running pilots by key, with their process id once started.
    running: HashMap<String, Option<u32>>,
    cancelled: HashSet<String>,
    config: Option<RunConfig>,
    /// Set when the app is closing: stopped runs become Interrupted, not Cancelled.
    shutting_down: bool,
}

#[derive(Default)]
pub struct Manager {
    state: Mutex<State>,
}

fn key(board: &Path, id: &str) -> String {
    format!("{}|{id}", board.display())
}

fn emit<R: Runtime>(app: &AppHandle<R>, board: &Path, id: &str, meta: Option<&PilotMeta>, activity: Option<Activity>) {
    let _ = app.emit(
        "pilot-event",
        PilotEvent { board_path: board.display().to_string(), id: id.to_string(), meta: meta.cloned(), activity },
    );
}

pub fn build_args(meta: &PilotMeta, cfg: &RunConfig, system_prompt: &Path, resume: Option<&str>) -> Vec<String> {
    let mut a: Vec<String> = ["-p", "--output-format", "stream-json", "--verbose", "--append-system-prompt-file"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    a.push(system_prompt.display().to_string());
    let mut blocked = BLOCKED_TOOLS.to_string();
    match meta.permission {
        PilotPermission::Auto => a.extend(["--permission-mode", "auto"].map(String::from)),
        PilotPermission::EditsOnly => {
            a.extend(["--permission-mode", "acceptEdits"].map(String::from));
            blocked = "Bash,PowerShell".to_string();
        }
        PilotPermission::Full => a.extend(["--permission-mode", "bypassPermissions"].map(String::from)),
    }
    a.extend(["--disallowedTools".to_string(), blocked]);
    if cfg.permission_prompts_flag {
        a.extend(["--permission-prompts", "none"].map(String::from));
    }
    if !meta.model.trim().is_empty() {
        a.extend(["--model".to_string(), meta.model.trim().to_string()]);
    }
    if meta.max_budget_usd > 0.0 {
        a.extend(["--max-budget-usd".to_string(), format!("{:.2}", meta.max_budget_usd)]);
    }
    if meta.max_turns > 0 {
        a.extend(["--max-turns".to_string(), meta.max_turns.to_string()]);
    }
    if let Some(s) = resume {
        a.extend(["--resume".to_string(), s.to_string()]);
    }
    a
}

impl Manager {
    fn enqueue<R: Runtime>(self: &Arc<Self>, app: &AppHandle<R>, cfg: RunConfig, job: Job) {
        {
            let mut st = self.state.lock().unwrap();
            st.config = Some(cfg);
            st.cancelled.remove(&key(&job.board, &job.id));
            st.queue.push_back(job);
        }
        self.pump(app);
    }

    /// Starts queued jobs while there is room.
    fn pump<R: Runtime>(self: &Arc<Self>, app: &AppHandle<R>) {
        loop {
            let (job, cfg) = {
                let mut st = self.state.lock().unwrap();
                let Some(cfg) = st.config.clone() else { return };
                if st.running.len() >= cfg.max_concurrent.max(1) as usize {
                    return;
                }
                let Some(job) = st.queue.pop_front() else { return };
                st.running.insert(key(&job.board, &job.id), None);
                (job, cfg)
            };
            let mgr = Arc::clone(self);
            let app = app.clone();
            std::thread::spawn(move || {
                let k = key(&job.board, &job.id);
                let (board, id) = (job.board.clone(), job.id.clone());
                if let Err(e) = mgr.run(&app, &cfg, job) {
                    if let Ok(mut meta) = load_meta(&board, &id) {
                        meta.status = PilotStatus::Failed;
                        meta.error = Some(e.to_string());
                        meta.finished_at = Some(now());
                        let _ = save_meta(&board, &meta);
                        emit(&app, &board, &id, Some(&meta), Some(Activity { kind: "error".into(), text: e.to_string(), detail: None }));
                    }
                }
                {
                    let mut st = mgr.state.lock().unwrap();
                    st.running.remove(&k);
                    st.cancelled.remove(&k);
                }
                mgr.pump(&app);
            });
        }
    }

    fn is_cancelled(&self, k: &str) -> bool {
        self.state.lock().unwrap().cancelled.contains(k)
    }

    fn run<R: Runtime>(&self, app: &AppHandle<R>, cfg: &RunConfig, job: Job) -> Result<()> {
        let board = &job.board;
        let k = key(board, &job.id);
        let mut meta = load_meta(board, &job.id)?;
        if self.is_cancelled(&k) {
            return Ok(());
        }

        // Worktree on the pilot branch, created on the first run.
        let wt = worktree(board, &meta.id);
        if !wt.exists() {
            let base = git::run(board, &["rev-parse", "HEAD"])?.trim().to_string();
            let branch_exists = git::run(board, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{}", meta.branch)]).is_ok();
            let rel = worktree_rel(&meta.id);
            if branch_exists {
                git::run(board, &["worktree", "add", &rel, &meta.branch])?;
            } else {
                git::run(board, &["worktree", "add", "-b", &meta.branch, &rel, "HEAD"])?;
            }
            meta.base_commit.get_or_insert(base);
        }

        meta.status = PilotStatus::Running;
        meta.runs += 1;
        meta.error = None;
        meta.started_at.get_or_insert_with(now);
        meta.finished_at = None;
        save_meta(board, &meta)?;
        emit(app, board, &meta.id, Some(&meta), None);

        let dir = record_dir(board, &meta.id);
        let system_prompt = dir.join("system-prompt.md");
        fs::write(&system_prompt, SYSTEM_PROMPT)?;
        fs::write(dir.join(format!("prompt-{}.md", meta.runs)), &job.prompt)?;
        let mut log = OpenOptions::new().create(true).append(true).open(dir.join(EVENTS_FILE))?;

        let mut child = command(&cfg.claude_exe)
            .args(build_args(&meta, cfg, &system_prompt, job.resume.as_deref()))
            .current_dir(&wt)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| AppError::msg(format!("could not start Claude Code at {}: {e}", cfg.claude_exe.display())))?;
        self.state.lock().unwrap().running.insert(k.clone(), Some(child.id()));
        {
            let mut stdin = child.stdin.take().expect("stdin is piped");
            stdin.write_all(job.prompt.as_bytes())?;
        }
        let mut stderr = child.stderr.take().expect("stderr is piped");
        let stderr_thread = std::thread::spawn(move || {
            let mut buf = String::new();
            let _ = stderr.read_to_string(&mut buf);
            buf
        });

        let mut facts = RunFacts::default();
        for line in BufReader::new(child.stdout.take().expect("stdout is piped")).lines() {
            let Ok(line) = line else { break };
            let _ = writeln!(log, "{line}");
            facts.observe(&line);
            for a in parse_activity(&line) {
                emit(app, board, &meta.id, None, Some(a));
            }
        }
        let status = child.wait()?;
        let stderr = stderr_thread.join().unwrap_or_default();

        // Record what happened.
        let mut meta = load_meta(board, &meta.id)?; // pin state may have changed meanwhile
        let previous_session = meta.session_id.clone();
        if let Some(total) = facts.total_cost_usd {
            let same_session = previous_session.is_some() && previous_session == facts.session_id;
            meta.cost_usd = Some(if same_session || meta.cost_usd.is_none() { total } else { meta.cost_usd.unwrap_or(0.0) + total });
        }
        meta.session_id = facts.session_id.clone().or(previous_session);
        meta.model_used = facts.model.clone().or(meta.model_used);
        meta.permission_mode = facts.permission_mode.clone().or(meta.permission_mode);
        let t = facts.tokens();
        meta.tokens = Tokens {
            input: meta.tokens.input + t.input,
            cache_write: meta.tokens.cache_write + t.cache_write,
            cache_read: meta.tokens.cache_read + t.cache_read,
            output: meta.tokens.output + t.output,
        };
        meta.duration_ms += facts.duration_ms;
        meta.denials.extend(facts.denials.iter().cloned());
        let shutting_down = self.state.lock().unwrap().shutting_down;
        meta.status = if shutting_down {
            PilotStatus::Interrupted
        } else if self.is_cancelled(&k) {
            PilotStatus::Cancelled
        } else if facts.finished && !facts.is_error {
            PilotStatus::Succeeded
        } else {
            PilotStatus::Failed
        };
        if meta.status == PilotStatus::Failed {
            let tail: String = stderr.trim().chars().rev().take(1500).collect::<Vec<_>>().into_iter().rev().collect();
            meta.error = Some(match (&facts.result_text, tail.is_empty()) {
                (Some(r), _) if facts.finished => short(r, 1500),
                (_, false) => tail,
                _ => format!("Claude Code exited ({status}) without a result."),
            });
        }
        if facts.permission_mode.as_deref() == Some("default") && meta.permission == PilotPermission::Auto {
            meta.denials.push("Auto mode was not available, so Claude Code ran in Manual mode and denied actions needing approval. Check your Claude Code version and model.".into());
        }

        // Commit whatever the pilot produced, even after a failure or a stop.
        let label = match meta.status {
            PilotStatus::Succeeded => "",
            PilotStatus::Cancelled => " (stopped)",
            _ => " (failed)",
        };
        match git::commit_paths(&wt, &["."], &format!("Pilot {}: {} (run {}){label}", meta.id, meta.title, meta.runs)) {
            Ok(true) => meta.result_commit = git::run(&wt, &["rev-parse", "HEAD"]).ok().map(|s| s.trim().to_string()),
            Ok(false) => {}
            Err(e) => {
                let note = format!("Could not commit the pilot's files: {e}");
                meta.error = Some(match meta.error.take() {
                    Some(prev) => format!("{prev}\n{note}"),
                    None => note,
                });
            }
        }
        meta.has_report = wt.join(REPORT_FILE).is_file();
        meta.finished_at = Some(now());
        save_meta(board, &meta)?;
        emit(app, board, &meta.id, Some(&meta), None);
        Ok(())
    }

    fn known(&self, board: &Path, id: &str) -> bool {
        let st = self.state.lock().unwrap();
        st.running.contains_key(&key(board, id)) || st.queue.iter().any(|j| j.board == board && j.id == id)
    }

    /// Lists a board's pilots. Pilots recorded as active but unknown to the
    /// queue were cut off by the app closing; they become Interrupted.
    pub fn list(&self, board: &Path) -> Vec<PilotMeta> {
        list_metas(board)
            .into_iter()
            .map(|mut m| {
                if m.status.is_active() && !self.known(board, &m.id) {
                    m.status = PilotStatus::Interrupted;
                    m.finished_at.get_or_insert_with(now);
                    let _ = save_meta(board, &m);
                }
                m
            })
            .collect()
    }

    #[allow(clippy::too_many_arguments)]
    pub fn start<R: Runtime>(
        self: &Arc<Self>,
        app: &AppHandle<R>,
        cfg: RunConfig,
        board: &Path,
        title: &str,
        instructions: &str,
        prompt: String,
        scope: &str,
        model: &str,
        permission: PilotPermission,
        max_budget_usd: f64,
        max_turns: u32,
    ) -> Result<PilotMeta> {
        if prompt.trim().is_empty() {
            return Err(AppError::msg("A pilot needs instructions"));
        }
        if !crate::settings::valid_model(model) {
            return Err(AppError::msg("Invalid model name"));
        }
        if !(0.0..=1000.0).contains(&max_budget_usd) {
            return Err(AppError::msg("Spending cap must be between 0 and 1000 USD"));
        }
        let id = new_id();
        let title = title.trim();
        let meta = PilotMeta {
            title: if title.is_empty() { short(instructions.lines().next().unwrap_or("Pilot"), 60) } else { short(title, 100) },
            instructions: instructions.to_string(),
            scope: scope.to_string(),
            model: model.trim().to_string(),
            permission,
            max_budget_usd,
            max_turns,
            created_at: now(),
            branch: format!("pilot/{id}"),
            id: id.clone(),
            ..PilotMeta::default()
        };
        save_meta(board, &meta)?;
        fs::write(record_dir(board, &id).join(INITIAL_PROMPT_FILE), &prompt)?;
        emit(app, board, &id, Some(&meta), None);
        self.enqueue(app, cfg, Job { board: board.to_path_buf(), id, prompt, resume: None });
        Ok(meta)
    }

    /// Starts a pilot that never got a Claude Code session (stopped or cut
    /// off while queued, or failed to launch) from its original prompt.
    pub fn start_again<R: Runtime>(self: &Arc<Self>, app: &AppHandle<R>, cfg: RunConfig, board: &Path, id: &str) -> Result<PilotMeta> {
        let mut meta = load_meta(board, id)?;
        if meta.status.is_active() || self.known(board, id) {
            return Err(AppError::msg("This pilot is still queued or running"));
        }
        if meta.session_id.is_some() {
            return Err(AppError::msg("This pilot already has a session; use a follow-up to continue it"));
        }
        let prompt = fs::read_to_string(record_dir(board, id).join(INITIAL_PROMPT_FILE))
            .map_err(|_| AppError::msg("The original prompt for this pilot was not saved; start a new pilot instead"))?;
        meta.status = PilotStatus::Queued;
        meta.error = None;
        meta.finished_at = None;
        save_meta(board, &meta)?;
        emit(app, board, id, Some(&meta), None);
        self.enqueue(app, cfg, Job { board: board.to_path_buf(), id: id.to_string(), prompt, resume: None });
        Ok(meta)
    }

    /// Pilots queued or running in this app session.
    pub fn active_count(&self) -> usize {
        let st = self.state.lock().unwrap();
        st.running.len() + st.queue.len()
    }

    /// Stops everything because the app is closing. Queued pilots stay
    /// recorded as queued and show up as Interrupted next time.
    pub fn stop_all(&self) {
        let pids: Vec<u32> = {
            let mut st = self.state.lock().unwrap();
            st.shutting_down = true;
            st.queue.clear();
            st.running.values().filter_map(|p| *p).collect()
        };
        pids.into_iter().for_each(crate::chat::kill_tree);
    }

    /// Continues a finished pilot's Claude Code session with new instructions.
    pub fn follow_up<R: Runtime>(self: &Arc<Self>, app: &AppHandle<R>, cfg: RunConfig, board: &Path, id: &str, instructions: &str, prompt: String) -> Result<PilotMeta> {
        let mut meta = load_meta(board, id)?;
        if meta.status.is_active() || self.known(board, id) {
            return Err(AppError::msg("This pilot is still queued or running"));
        }
        let session = meta.session_id.clone().ok_or_else(|| AppError::msg("This pilot has no session to continue"))?;
        meta.follow_ups.push(FollowUp { at: now(), instructions: instructions.to_string() });
        meta.status = PilotStatus::Queued;
        meta.error = None;
        save_meta(board, &meta)?;
        emit(app, board, id, Some(&meta), None);
        self.enqueue(app, cfg, Job { board: board.to_path_buf(), id: id.to_string(), prompt, resume: Some(session) });
        Ok(meta)
    }

    pub fn cancel<R: Runtime>(&self, app: &AppHandle<R>, board: &Path, id: &str) -> Result<()> {
        let k = key(board, id);
        let pid = {
            let mut st = self.state.lock().unwrap();
            let before = st.queue.len();
            st.queue.retain(|j| !(j.board == board && j.id == id));
            if st.queue.len() < before {
                drop(st);
                let mut meta = load_meta(board, id)?;
                meta.status = PilotStatus::Cancelled;
                meta.finished_at = Some(now());
                save_meta(board, &meta)?;
                emit(app, board, id, Some(&meta), None);
                return Ok(());
            }
            st.cancelled.insert(k.clone());
            st.running.get(&k).copied().flatten()
        };
        if let Some(pid) = pid {
            crate::chat::kill_tree(pid);
        }
        Ok(())
    }

    /// Deletes a pilot: stops it, removes its worktree, branch and records.
    pub fn delete<R: Runtime>(&self, app: &AppHandle<R>, board: &Path, id: &str) -> Result<()> {
        let meta = load_meta(board, id)?;
        if meta.pinned {
            return Err(AppError::msg("This pilot is pinned. Unpin it before deleting."));
        }
        if self.known(board, id) {
            self.cancel(app, board, id)?;
            for _ in 0..50 {
                if !self.known(board, id) {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            if self.known(board, id) {
                return Err(AppError::msg("The pilot did not stop in time; try again in a moment."));
            }
        }
        let wt = worktree(board, id);
        if wt.exists() && git::run(board, &["worktree", "remove", "--force", &worktree_rel(id)]).is_err() {
            fs::remove_dir_all(&wt)?;
        }
        let _ = git::run(board, &["worktree", "prune"]);
        if git::run(board, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{}", meta.branch)]).is_ok() {
            git::run(board, &["branch", "-D", &meta.branch])?;
        }
        let dir = record_dir(board, id);
        if dir.exists() {
            fs::remove_dir_all(dir)?;
        }
        Ok(())
    }

    /// True when no pilot is queued or running.
    #[cfg(test)]
    pub fn idle(&self) -> bool {
        let st = self.state.lock().unwrap();
        st.running.is_empty() && st.queue.is_empty()
    }
}

// ---- Inspecting a pilot ----

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteInfo {
    pub branch_exists: bool,
    /// Commits on the pilot branch that are on neither the current branch nor any remote.
    pub unsaved_commits: u32,
    pub pushed: bool,
    pub has_worktree: bool,
}

pub fn delete_info(board: &Path, id: &str) -> Result<DeleteInfo> {
    let meta = load_meta(board, id)?;
    let branch_ref = format!("refs/heads/{}", meta.branch);
    let branch_exists = git::run(board, &["rev-parse", "--verify", "--quiet", &branch_ref]).is_ok();
    let unsaved_commits = if branch_exists {
        git::run(board, &["rev-list", "--count", &meta.branch, "--not", "HEAD", "--remotes"])?.trim().parse().unwrap_or(0)
    } else {
        0
    };
    let pushed = git::run(board, &["rev-parse", "--verify", "--quiet", &format!("refs/remotes/origin/{}", meta.branch)]).is_ok();
    Ok(DeleteInfo { branch_exists, unsaved_commits, pushed, has_worktree: worktree(board, id).exists() })
}

pub fn set_pinned(board: &Path, id: &str, pinned: bool) -> Result<PilotMeta> {
    let mut meta = load_meta(board, id)?;
    meta.pinned = pinned;
    save_meta(board, &meta)?;
    Ok(meta)
}

pub fn activity(board: &Path, id: &str) -> Result<Vec<Activity>> {
    check_id(id)?;
    let Ok(text) = fs::read_to_string(record_dir(board, id).join(EVENTS_FILE)) else {
        return Ok(vec![]);
    };
    let all: Vec<Activity> = text.lines().flat_map(parse_activity).collect();
    let skip = all.len().saturating_sub(MAX_ACTIVITY);
    Ok(all.into_iter().skip(skip).collect())
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    /// added, modified, deleted, renamed or untracked
    pub status: String,
    pub added: Option<u32>,
    pub removed: Option<u32>,
}

/// Parses `git diff --numstat` and `--name-status` output into changes.
pub fn parse_changes(numstat: &str, name_status: &str) -> Vec<FileChange> {
    let mut stats: HashMap<String, (Option<u32>, Option<u32>)> = HashMap::new();
    for l in numstat.lines() {
        let mut p = l.splitn(3, '\t');
        if let (Some(a), Some(r), Some(path)) = (p.next(), p.next(), p.next()) {
            stats.insert(path.to_string(), (a.parse().ok(), r.parse().ok()));
        }
    }
    name_status
        .lines()
        .filter_map(|l| {
            let parts: Vec<&str> = l.split('\t').collect();
            let code = parts.first()?.chars().next()?;
            let path = parts.last()?.to_string();
            let status = match code {
                'A' => "added",
                'D' => "deleted",
                'R' => "renamed",
                _ => "modified",
            };
            let (added, removed) = stats.iter().find(|(k, _)| k.ends_with(&path)).map(|(_, v)| *v).unwrap_or((None, None));
            Some(FileChange { path, status: status.into(), added, removed })
        })
        .collect()
}

fn base_commit(board: &Path, id: &str) -> Result<(PilotMeta, String)> {
    let meta = load_meta(board, id)?;
    let base = meta.base_commit.clone().ok_or_else(|| AppError::msg("This pilot has not started yet"))?;
    Ok((meta, base))
}

/// Files the pilot changed relative to where it started.
pub fn changes(board: &Path, id: &str) -> Result<Vec<FileChange>> {
    let (meta, base) = base_commit(board, id)?;
    let wt = worktree(board, id);
    let (numstat, names, untracked) = if wt.exists() {
        (
            git::run(&wt, &["diff", "--numstat", &base])?,
            git::run(&wt, &["diff", "--name-status", &base])?,
            git::run(&wt, &["ls-files", "--others", "--exclude-standard"])?,
        )
    } else {
        (
            git::run(board, &["diff", "--numstat", &base, &meta.branch])?,
            git::run(board, &["diff", "--name-status", &base, &meta.branch])?,
            String::new(),
        )
    };
    let mut out = parse_changes(&numstat, &names);
    out.extend(
        untracked
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|p| FileChange { path: p.to_string(), status: "untracked".into(), added: None, removed: None }),
    );
    Ok(out)
}

/// Rejects absolute paths and `..` so callers stay inside the worktree.
fn safe_rel(rel: &str) -> Result<PathBuf> {
    let p = PathBuf::from(rel.replace('\\', "/"));
    // ':' rules out drive letters and alternate data streams on Windows.
    if !rel.is_empty() && !rel.contains(':') && p.components().all(|c| matches!(c, Component::Normal(_))) {
        Ok(p)
    } else {
        Err(AppError::msg(format!("invalid path {rel:?}")))
    }
}

pub fn file_diff(board: &Path, id: &str, rel: &str) -> Result<String> {
    let (meta, base) = base_commit(board, id)?;
    let rel_path = safe_rel(rel)?;
    let rel_s = rel_path.to_string_lossy().replace('\\', "/");
    let wt = worktree(board, id);
    let diff = if wt.exists() {
        git::run(&wt, &["diff", &base, "--", &rel_s])?
    } else {
        git::run(board, &["diff", &base, &meta.branch, "--", &rel_s])?
    };
    if !diff.trim().is_empty() {
        return Ok(diff);
    }
    // Untracked file: show it as entirely added.
    let file = wt.join(&rel_path);
    match fs::metadata(&file) {
        Ok(m) if m.len() <= MAX_TEXT_FILE => {
            let text = fs::read_to_string(&file).unwrap_or_else(|_| "(binary file)".into());
            Ok(format!("+++ {rel_s} (new, not tracked)\n{}", text.lines().map(|l| format!("+{l}")).collect::<Vec<_>>().join("\n")))
        }
        Ok(_) => Ok(format!("{rel_s}: file is too large to show")),
        Err(_) => Ok(String::new()),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PilotFile {
    pub path: String,
    pub size: u64,
}

/// Everything under the worktree's results/ folder.
pub fn result_files(board: &Path, id: &str) -> Result<Vec<PilotFile>> {
    check_id(id)?;
    let wt = worktree(board, id);
    let root = wt.join(RESULTS_DIR);
    let mut out = vec![];
    let mut stack = vec![root];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let p = e.path();
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                stack.push(p);
            } else if ft.is_file() {
                let rel = p.strip_prefix(&wt).unwrap_or(&p).to_string_lossy().replace('\\', "/");
                out.push(PilotFile { path: rel, size: e.metadata().map(|m| m.len()).unwrap_or(0) });
            }
            if out.len() >= 500 {
                break;
            }
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    /// text, image or binary
    pub kind: String,
    pub text: Option<String>,
    pub data_url: Option<String>,
    pub size: u64,
    pub truncated: bool,
}

pub fn read_file(board: &Path, id: &str, rel: &str) -> Result<FileContent> {
    check_id(id)?;
    let path = worktree(board, id).join(safe_rel(rel)?);
    let size = fs::metadata(&path).map_err(|_| AppError::msg(format!("{rel} not found")))?.len();
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let mime = match ext.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "svg" => Some("image/svg+xml"),
        _ => None,
    };
    if let Some(mime) = mime {
        if size > MAX_IMAGE_FILE {
            return Ok(FileContent { kind: "binary".into(), text: None, data_url: None, size, truncated: true });
        }
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD.encode(fs::read(&path)?);
        return Ok(FileContent { kind: "image".into(), text: None, data_url: Some(format!("data:{mime};base64,{b64}")), size, truncated: false });
    }
    let mut buf = Vec::new();
    fs::File::open(&path)?.take(MAX_TEXT_FILE).read_to_end(&mut buf)?;
    match String::from_utf8(buf) {
        Ok(text) => Ok(FileContent { kind: "text".into(), text: Some(text), data_url: None, size, truncated: size > MAX_TEXT_FILE }),
        Err(_) => Ok(FileContent { kind: "binary".into(), text: None, data_url: None, size, truncated: false }),
    }
}

pub fn push(board: &Path, id: &str) -> Result<()> {
    let meta = load_meta(board, id)?;
    if git::run(board, &["remote", "get-url", "origin"]).is_err() {
        return Err(AppError::msg("This board has no GitHub remote yet. Publish the board first."));
    }
    crate::github::git_quiet(board, &["push", "--set-upstream", "origin", &meta.branch])?;
    Ok(())
}

#[cfg(all(test, unix))]
mod lifecycle {
    //! Drives a real pilot through worktree creation, a run, auto-commit,
    //! a follow-up and deletion, with a fake `claude` script standing in.
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::time::{Duration, Instant};

    const FAKE_CLAUDE: &str = r#"#!/bin/sh
prompt=$(cat)
args="$*"
echo "$args" > "$PWD/.args"
mkdir -p results
echo '{"accuracy": 0.91}' > results/metrics.json
printf '# Report\n\nSummary: it works.\n' > PILOT_REPORT.md
echo "$prompt" >> notes.txt
echo '{"type":"system","subtype":"init","session_id":"sess-1","model":"claude-test","permissionMode":"auto"}'
echo '{"type":"assistant","message":{"id":"m1","usage":{"input_tokens":3,"cache_creation_input_tokens":50,"cache_read_input_tokens":0,"output_tokens":7},"content":[{"type":"tool_use","name":"Write","input":{"file_path":"results/metrics.json"}}]}}'
case "$args" in *--resume*) total=0.30 ;; *) total=0.10 ;; esac
printf '{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"sess-1","total_cost_usd":%s,"duration_ms":1200,"permission_denials":[]}\n' "$total"
"#;

    fn wait_idle(m: &Manager) {
        let t = Instant::now();
        while !m.idle() {
            assert!(t.elapsed() < Duration::from_secs(20), "pilot did not finish");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[test]
    fn full_lifecycle() {
        let tmp = std::env::temp_dir().join(format!("ideation-pilot-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        let fake = tmp.join("claude");
        fs::write(&fake, FAKE_CLAUDE).unwrap();
        fs::set_permissions(&fake, fs::Permissions::from_mode(0o755)).unwrap();
        let info = crate::boards::create(&tmp, "Board").unwrap();
        let board = PathBuf::from(&info.path);

        let app = tauri::test::mock_app();
        let handle = app.handle().clone();
        let mgr = Arc::new(Manager::default());
        let cfg = RunConfig { claude_exe: fake.clone(), permission_prompts_flag: true, max_concurrent: 2 };

        let meta = mgr
            .start(&handle, cfg.clone(), &board, "", "Try a classifier\nmore", "PROMPT-1".into(), "board", "", PilotPermission::Auto, 2.0, 0)
            .unwrap();
        assert_eq!(meta.title, "Try a classifier");
        wait_idle(&mgr);

        let m = load_meta(&board, &meta.id).unwrap();
        assert_eq!(m.status, PilotStatus::Succeeded, "error: {:?}", m.error);
        assert_eq!(m.session_id.as_deref(), Some("sess-1"));
        assert_eq!(m.model_used.as_deref(), Some("claude-test"));
        assert_eq!(m.cost_usd, Some(0.10));
        assert_eq!(m.tokens.cache_write, 50);
        assert!(m.has_report);
        assert!(m.result_commit.is_some());

        // The worktree is on its own branch; the user's checkout is untouched.
        let wt = worktree(&board, &meta.id);
        assert!(wt.join("results/metrics.json").is_file());
        assert!(!board.join("results").exists());
        assert_eq!(git::run(&board, &["status", "--porcelain"]).unwrap().trim(), "");
        let args = fs::read_to_string(wt.join(".args")).unwrap();
        assert!(args.contains("--permission-mode auto") && args.contains("--max-budget-usd 2.00"));

        let changes = changes(&board, &meta.id).unwrap();
        let paths: Vec<_> = changes.iter().map(|c| c.path.as_str()).collect();
        assert!(paths.contains(&"PILOT_REPORT.md") && paths.contains(&"results/metrics.json"), "{paths:?}");
        assert!(file_diff(&board, &meta.id, "results/metrics.json").unwrap().contains("+{\"accuracy\": 0.91}"));
        assert_eq!(result_files(&board, &meta.id).unwrap()[0].path, "results/metrics.json");
        assert!(read_file(&board, &meta.id, "PILOT_REPORT.md").unwrap().text.unwrap().contains("it works"));
        assert!(read_file(&board, &meta.id, "../../secret").is_err());
        assert!(activity(&board, &meta.id).unwrap().iter().any(|a| a.kind == "tool" && a.text == "Write"));

        // Follow-up resumes the session; cost is the session's running total.
        mgr.follow_up(&handle, cfg.clone(), &board, &meta.id, "again", "PROMPT-2".into()).unwrap();
        wait_idle(&mgr);
        let m = load_meta(&board, &meta.id).unwrap();
        assert_eq!((m.status, m.runs, m.cost_usd), (PilotStatus::Succeeded, 2, Some(0.30)));
        assert!(fs::read_to_string(wt.join(".args")).unwrap().contains("--resume sess-1"));
        assert_eq!(git::run(&board, &["rev-list", "--count", &m.branch, "--not", "HEAD"]).unwrap().trim(), "2");

        // Pinned pilots cannot be deleted; unpinned ones are removed completely.
        assert_eq!(delete_info(&board, &meta.id).unwrap().unsaved_commits, 2);
        set_pinned(&board, &meta.id, true).unwrap();
        assert!(mgr.delete(&handle, &board, &meta.id).is_err());
        set_pinned(&board, &meta.id, false).unwrap();
        mgr.delete(&handle, &board, &meta.id).unwrap();
        assert!(!wt.exists());
        assert!(git::run(&board, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{}", m.branch)]).is_err());
        assert!(mgr.list(&board).is_empty());

        // A pilot stopped while queued has no session; it can start again from its saved prompt.
        let gate = Arc::new(Manager::default());
        let one = RunConfig { max_concurrent: 1, ..cfg.clone() };
        let first = gate.start(&handle, one.clone(), &board, "first", "first", "P".into(), "board", "", PilotPermission::Auto, 0.0, 0).unwrap();
        let second = gate.start(&handle, one.clone(), &board, "second", "second", "P2".into(), "board", "", PilotPermission::Auto, 0.0, 0).unwrap();
        gate.cancel(&handle, &board, &second.id).unwrap();
        wait_idle(&gate);
        assert_eq!(load_meta(&board, &second.id).unwrap().status, PilotStatus::Cancelled);
        gate.start_again(&handle, one.clone(), &board, &second.id).unwrap();
        wait_idle(&gate);
        let again = load_meta(&board, &second.id).unwrap();
        assert_eq!((again.status, again.runs), (PilotStatus::Succeeded, 1));
        assert!(gate.start_again(&handle, one, &board, &second.id).is_err()); // has a session now
        assert_eq!(gate.active_count(), 0);
        gate.stop_all();
        for p in [&first, &second] {
            gate.delete(&handle, &board, &p.id).unwrap();
        }

        // A pilot recorded as running that the manager does not know about was interrupted.
        let ghost = PilotMeta { id: "20260101-000000-abcd".into(), status: PilotStatus::Running, ..PilotMeta::default() };
        save_meta(&board, &ghost).unwrap();
        assert_eq!(mgr.list(&board)[0].status, PilotStatus::Interrupted);

        fs::remove_dir_all(&tmp).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn activity_parsing() {
        let init = parse_activity(r#"{"type":"system","subtype":"init","model":"claude-x","permissionMode":"auto","session_id":"s"}"#);
        assert_eq!(init[0].text, "Started with claude-x in auto mode");
        let asst = parse_activity(
            r#"{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"Plan"},{"type":"tool_use","name":"Bash","input":{"command":"python run.py","description":"run"}}]}}"#,
        );
        assert_eq!(asst.len(), 2);
        assert_eq!(asst[1].detail.as_deref(), Some("python run.py"));
        let res = parse_activity(r#"{"type":"result","subtype":"success","is_error":false,"result":"done","total_cost_usd":0.5}"#);
        assert_eq!(res[0].kind, "result");
        assert!(res[0].text.contains("$0.500"));
        let err = parse_activity(r#"{"type":"result","subtype":"error_max_budget_usd","is_error":true}"#);
        assert_eq!(err[0].kind, "error");
    }

    #[test]
    fn facts() {
        let mut f = RunFacts::default();
        f.observe(r#"{"type":"system","subtype":"init","session_id":"s1","model":"m","permissionMode":"auto"}"#);
        // The same API message appears twice; usage is counted once.
        f.observe(r#"{"type":"assistant","message":{"id":"a","usage":{"input_tokens":5,"cache_creation_input_tokens":100,"cache_read_input_tokens":0,"output_tokens":3},"content":[]}}"#);
        f.observe(r#"{"type":"assistant","message":{"id":"a","usage":{"input_tokens":5,"cache_creation_input_tokens":100,"cache_read_input_tokens":0,"output_tokens":9},"content":[]}}"#);
        f.observe(r#"{"type":"assistant","message":{"id":"b","usage":{"input_tokens":1,"cache_read_input_tokens":100,"output_tokens":2},"content":[]}}"#);
        f.observe(r#"{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"s1","total_cost_usd":0.2,"duration_ms":1000,"permission_denials":[{"tool_name":"Bash","tool_input":{"command":"git push"}}]}"#);
        assert_eq!(f.tokens(), Tokens { input: 6, cache_write: 100, cache_read: 100, output: 11 });
        assert!(f.finished && !f.is_error);
        assert_eq!(f.permission_mode.as_deref(), Some("auto"));
        assert_eq!(f.denials, vec!["Bash: git push".to_string()]);
    }

    #[test]
    fn args_by_permission() {
        let cfg = RunConfig { claude_exe: "claude".into(), permission_prompts_flag: true, max_concurrent: 2 };
        let mut m = PilotMeta { model: "opus".into(), max_budget_usd: 5.0, max_turns: 40, ..PilotMeta::default() };
        let a = build_args(&m, &cfg, Path::new("sys.md"), Some("sess")).join(" ");
        assert!(a.contains("--permission-mode auto"));
        assert!(a.contains("--disallowedTools Bash(git push *)"));
        assert!(a.contains("--permission-prompts none"));
        assert!(a.contains("--model opus --max-budget-usd 5.00 --max-turns 40 --resume sess"));
        m.permission = PilotPermission::EditsOnly;
        let a = build_args(&m, &cfg, Path::new("sys.md"), None).join(" ");
        assert!(a.contains("--permission-mode acceptEdits") && a.contains("--disallowedTools Bash,PowerShell"));
        m.permission = PilotPermission::Full;
        m.model.clear();
        m.max_budget_usd = 0.0;
        let old = RunConfig { permission_prompts_flag: false, ..cfg };
        let a = build_args(&m, &old, Path::new("sys.md"), None).join(" ");
        assert!(a.contains("bypassPermissions") && !a.contains("--model") && !a.contains("--max-budget") && !a.contains("--permission-prompts"));
    }

    #[test]
    fn change_parsing_and_paths() {
        let c = parse_changes("10\t2\tsrc/a.py\n-\t-\tresults/plot.png\n", "M\tsrc/a.py\nA\tresults/plot.png\n");
        assert_eq!(c[0], FileChange { path: "src/a.py".into(), status: "modified".into(), added: Some(10), removed: Some(2) });
        assert_eq!(c[1].status, "added");
        assert_eq!(c[1].added, None);
        assert!(safe_rel("results/x.json").is_ok());
        assert!(safe_rel("../secret").is_err());
        assert!(safe_rel("C:\\Windows\\x").is_err());
        assert!(safe_rel("/etc/passwd").is_err());
        assert!(safe_rel("").is_err());
        assert!(valid_id(&new_id()));
        assert!(!valid_id("../x"));
    }
}
