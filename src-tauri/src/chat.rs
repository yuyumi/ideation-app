//! Board chat: one `claude -p` run per user message, streamed back to the UI.
//!
//! Claude Code runs in the board's repo with at most read-only tools
//! (Read, Glob, Grep). The prompt goes over stdin to avoid the Windows
//! command-line length limit; the thread continues with `--resume`.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;

use serde::Serialize;
use serde_json::Value;

use crate::error::{AppError, Result};
use crate::process::command;

const SYSTEM_PROMPT: &str = include_str!("chat_prompt.md");
const READ_ONLY_TOOLS: &str = "Read,Glob,Grep";
/// Used when no model is set: Claude Code's alias for the newest Sonnet.
pub const DEFAULT_MODEL: &str = "sonnet";

/// Extra Claude Code settings for chat runs. Keeping the start of every
/// prompt identical lets new conversations read the prompt cache (which
/// lasts up to an hour on Anthropic's side) instead of writing it again:
/// - `includeGitInstructions: false` drops git instructions and the git
///   status snapshot, which changes every time the board autosaves.
/// - `promptCacheTtl: "1h"` keeps cached prompts for the longest lifetime.
const CHAT_SETTINGS: &str = r#"{"includeGitInstructions": false, "promptCacheTtl": "1h"}"#;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ChatEvent {
    Started { session_id: Option<String>, model: Option<String> },
    /// Token counts for one API call. Claude Code reports input-side counts
    /// when a call starts (with the model) and output tokens when it ends.
    Usage {
        model: Option<String>,
        input_tokens: u64,
        cache_write_tokens: u64,
        cache_read_tokens: u64,
        output_tokens: u64,
    },
    TextDelta { text: String },
    ToolUse { name: String, detail: String },
    Done {
        text: String,
        session_id: Option<String>,
        /// Claude Code's estimate for the whole session so far, earlier turns
        /// included when resuming. The UI subtracts the previous total.
        cost_usd: Option<f64>,
        duration_ms: Option<u64>,
        is_error: bool,
    },
    Error { message: String },
}

pub struct ChatRequest {
    pub board_path: PathBuf,
    pub prompt: String,
    pub session_id: Option<String>,
    pub model: String,
    pub repo_access: bool,
    pub claude_exe: PathBuf,
}

/// Process ids of running chat requests, so the UI can cancel them.
#[derive(Default)]
pub struct Running(Mutex<HashMap<String, u32>>);

impl Running {
    pub fn cancel(&self, request_id: &str) -> bool {
        match self.0.lock().unwrap().remove(request_id) {
            Some(pid) => {
                kill_tree(pid);
                true
            }
            None => false,
        }
    }

    pub fn count(&self) -> usize {
        self.0.lock().unwrap().len()
    }

    /// Stops every running chat request.
    pub fn cancel_all(&self) {
        let pids: Vec<u32> = self.0.lock().unwrap().drain().map(|(_, pid)| pid).collect();
        pids.into_iter().for_each(kill_tree);
    }
}

/// Kills a process and its children. `claude.cmd` runs node under cmd.exe,
/// so killing only the direct child would leave Claude running.
pub fn kill_tree(pid: u32) {
    #[cfg(windows)]
    let _ = command("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).status();
    #[cfg(not(windows))]
    let _ = command("kill").args(["-TERM", &pid.to_string()]).status();
}

pub fn effective_model(model: &str) -> &str {
    let m = model.trim();
    if m.is_empty() {
        DEFAULT_MODEL
    } else {
        m
    }
}

pub fn build_args(req: &ChatRequest, prompt_file: &Path, settings_file: &Path) -> Vec<String> {
    let mut args: Vec<String> = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-mode",
        "dontAsk",
        "--exclude-dynamic-system-prompt-sections",
        "--append-system-prompt-file",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    args.push(prompt_file.display().to_string());
    args.push("--settings".to_string());
    args.push(settings_file.display().to_string());
    if req.repo_access {
        args.extend(["--tools", READ_ONLY_TOOLS, "--allowedTools", READ_ONLY_TOOLS].map(String::from));
    } else {
        args.extend(["--tools", ""].map(String::from));
    }
    if let Some(session) = req.session_id.as_deref().filter(|s| !s.is_empty()) {
        args.extend(["--resume".to_string(), session.to_string()]);
    }
    args.extend(["--model".to_string(), effective_model(&req.model).to_string()]);
    args
}

/// Short human-readable description of a tool call for the activity line.
fn tool_detail(input: &Value) -> String {
    ["file_path", "pattern", "path"]
        .iter()
        .find_map(|k| input.get(*k).and_then(Value::as_str))
        .unwrap_or("")
        .to_string()
}

/// Translates one line of Claude Code's stream-json output into events.
pub fn parse_line(line: &str) -> Vec<ChatEvent> {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return vec![];
    };
    let str_field = |key: &str| v.get(key).and_then(Value::as_str).map(String::from);
    match v.get("type").and_then(Value::as_str) {
        Some("system") if v.get("subtype").and_then(Value::as_str) == Some("init") => {
            vec![ChatEvent::Started { session_id: str_field("session_id"), model: str_field("model") }]
        }
        Some("stream_event") => {
            let ev = &v["event"];
            let n = |u: &Value, k: &str| u.get(k).and_then(Value::as_u64).unwrap_or(0);
            match ev["type"].as_str() {
                Some("content_block_delta") if ev["delta"]["type"] == "text_delta" => ev["delta"]["text"]
                    .as_str()
                    .map(|t| vec![ChatEvent::TextDelta { text: t.to_string() }])
                    .unwrap_or_default(),
                Some("message_start") => {
                    let u = &ev["message"]["usage"];
                    vec![ChatEvent::Usage {
                        model: ev["message"]["model"].as_str().map(String::from),
                        input_tokens: n(u, "input_tokens"),
                        cache_write_tokens: n(u, "cache_creation_input_tokens"),
                        cache_read_tokens: n(u, "cache_read_input_tokens"),
                        output_tokens: 0,
                    }]
                }
                Some("message_delta") => {
                    let out = n(&ev["usage"], "output_tokens");
                    if out == 0 {
                        vec![]
                    } else {
                        vec![ChatEvent::Usage {
                            model: None,
                            input_tokens: 0,
                            cache_write_tokens: 0,
                            cache_read_tokens: 0,
                            output_tokens: out,
                        }]
                    }
                }
                _ => vec![],
            }
        }
        Some("assistant") => v["message"]["content"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter(|c| c["type"] == "tool_use")
                    .map(|c| ChatEvent::ToolUse {
                        name: c["name"].as_str().unwrap_or("tool").to_string(),
                        detail: tool_detail(&c["input"]),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        Some("result") => vec![ChatEvent::Done {
            text: str_field("result").unwrap_or_default(),
            session_id: str_field("session_id"),
            cost_usd: v.get("total_cost_usd").and_then(Value::as_f64),
            duration_ms: v.get("duration_ms").and_then(Value::as_u64),
            is_error: v.get("is_error").and_then(Value::as_bool).unwrap_or(false)
                || v.get("subtype").and_then(Value::as_str).is_some_and(|s| s != "success"),
        }],
        _ => vec![],
    }
}

/// Runs one chat turn to completion, reporting events as they arrive.
pub fn run(req: ChatRequest, request_id: &str, running: &Running, emit: impl Fn(ChatEvent)) -> Result<()> {
    let tmp = std::env::temp_dir();
    let prompt_file = tmp.join(format!("ideation-chat-{request_id}.md"));
    let settings_file = tmp.join(format!("ideation-chat-{request_id}.json"));
    std::fs::write(&prompt_file, SYSTEM_PROMPT)?;
    std::fs::write(&settings_file, CHAT_SETTINGS)?;
    let result = run_inner(&req, &prompt_file, &settings_file, request_id, running, &emit);
    let _ = std::fs::remove_file(&prompt_file);
    let _ = std::fs::remove_file(&settings_file);
    running.0.lock().unwrap().remove(request_id);
    if let Err(e) = &result {
        emit(ChatEvent::Error { message: e.to_string() });
    }
    result
}

fn run_inner(
    req: &ChatRequest,
    prompt_file: &Path,
    settings_file: &Path,
    request_id: &str,
    running: &Running,
    emit: &impl Fn(ChatEvent),
) -> Result<()> {
    let mut child = command(&req.claude_exe)
        .args(build_args(req, prompt_file, settings_file))
        .current_dir(&req.board_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::msg(format!("could not start Claude Code at {}: {e}", req.claude_exe.display())))?;
    running.0.lock().unwrap().insert(request_id.to_string(), child.id());

    {
        let mut stdin = child.stdin.take().expect("stdin is piped");
        stdin.write_all(req.prompt.as_bytes())?;
    } // dropping stdin closes it so Claude starts

    // Drain stderr on its own thread so a full pipe can never block Claude.
    let mut stderr = child.stderr.take().expect("stderr is piped");
    let stderr_thread = std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = stderr.read_to_string(&mut buf);
        buf
    });

    let mut finished = false;
    for line in BufReader::new(child.stdout.take().expect("stdout is piped")).lines() {
        let Ok(line) = line else { break };
        for event in parse_line(&line) {
            finished |= matches!(event, ChatEvent::Done { .. });
            emit(event);
        }
    }
    let status = child.wait()?;
    let stderr = stderr_thread.join().unwrap_or_default();

    if !finished {
        let cancelled = !running.0.lock().unwrap().contains_key(request_id);
        let message = if cancelled {
            "Stopped.".to_string()
        } else {
            let tail: String = stderr.trim().chars().rev().take(1500).collect::<Vec<_>>().into_iter().rev().collect();
            format!("Claude Code exited ({status}) without a reply. {tail}")
        };
        return Err(AppError::msg(message));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_stream_lines() {
        assert_eq!(
            parse_line(r#"{"type":"system","subtype":"init","session_id":"abc","model":"claude-sonnet-x"}"#),
            vec![ChatEvent::Started { session_id: Some("abc".into()), model: Some("claude-sonnet-x".into()) }]
        );
        assert_eq!(
            parse_line(r#"{"type":"stream_event","event":{"type":"message_start","message":{"model":"m1","usage":{"input_tokens":2,"cache_creation_input_tokens":32674,"cache_read_input_tokens":0,"output_tokens":1}}}}"#),
            vec![ChatEvent::Usage { model: Some("m1".into()), input_tokens: 2, cache_write_tokens: 32674, cache_read_tokens: 0, output_tokens: 0 }]
        );
        assert_eq!(
            parse_line(r#"{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":53}}}"#),
            vec![ChatEvent::Usage { model: None, input_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 0, output_tokens: 53 }]
        );
        assert_eq!(
            parse_line(r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}}"#),
            vec![ChatEvent::TextDelta { text: "Hi".into() }]
        );
        assert_eq!(
            parse_line(r#"{"type":"assistant","message":{"content":[{"type":"text","text":"x"},{"type":"tool_use","name":"Read","input":{"file_path":"src/a.rs"}}]}}"#),
            vec![ChatEvent::ToolUse { name: "Read".into(), detail: "src/a.rs".into() }]
        );
        let done = parse_line(r#"{"type":"result","subtype":"success","is_error":false,"result":"Final","session_id":"abc","total_cost_usd":0.01,"duration_ms":1200}"#);
        assert_eq!(
            done,
            vec![ChatEvent::Done {
                text: "Final".into(),
                session_id: Some("abc".into()),
                cost_usd: Some(0.01),
                duration_ms: Some(1200),
                is_error: false
            }]
        );
        let max_turns = parse_line(r#"{"type":"result","subtype":"error_max_turns","is_error":false}"#);
        assert!(matches!(max_turns[0], ChatEvent::Done { is_error: true, .. }));
        assert!(parse_line("not json").is_empty());
        assert!(parse_line(r#"{"type":"user"}"#).is_empty());
    }

    #[test]
    fn args() {
        let req = ChatRequest {
            board_path: PathBuf::from("."),
            prompt: String::new(),
            session_id: Some("s1".into()),
            model: "sonnet".into(),
            repo_access: false,
            claude_exe: PathBuf::from("claude"),
        };
        let a = build_args(&req, Path::new("p.md"), Path::new("s.json"));
        let joined = a.join(" ");
        assert!(joined.contains("--resume s1"));
        assert!(joined.contains("--model sonnet"));
        assert!(joined.contains("--settings s.json"));
        assert!(joined.contains("--exclude-dynamic-system-prompt-sections"));
        assert!(a.windows(2).any(|w| w[0] == "--tools" && w[1].is_empty()));
        assert!(!joined.contains("--allowedTools"));

        // An empty model falls back to the Sonnet alias.
        let req = ChatRequest { model: "  ".into(), ..req };
        assert!(build_args(&req, Path::new("p.md"), Path::new("s.json")).join(" ").contains("--model sonnet"));
        assert!(serde_json::from_str::<Value>(CHAT_SETTINGS).is_ok());
    }

    #[test]
    fn event_json_shape() {
        let json = serde_json::to_value(ChatEvent::Done {
            text: "t".into(),
            session_id: None,
            cost_usd: None,
            duration_ms: Some(5),
            is_error: false,
        })
        .unwrap();
        assert_eq!(json["kind"], "done");
        assert_eq!(json["durationMs"], 5);
        assert_eq!(json["isError"], false);
    }
}
