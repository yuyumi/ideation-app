import type { AliasMap } from "./board/serialize";
import type { BoardOp } from "./board/proposals";

export interface BoardInfo {
  path: string;
  id: string;
  name: string;
  createdAt: string;
}

export interface RecentBoard {
  path: string;
  name: string;
  lastOpened: string;
  exists: boolean;
}

export interface Environment {
  git: string | null;
  claude: string | null;
  claudePath: string | null;
}

/** Window size in logical pixels; top gap as percent of usable screen height. */
export interface WindowSettings {
  width: number;
  height: number;
  topGapPercent: number;
}

export interface ClaudeSettings {
  /** Full path to the claude executable; empty means auto-detect. */
  path: string;
  /** Model alias or name; empty means Claude Code's default. */
  model: string;
  /** Lets chat read the repo with Read, Glob and Grep. */
  repoAccess: boolean;
}

export type PilotPermission = "auto" | "editsOnly" | "full";

export interface PilotSettings {
  /** Empty means Claude Code's default model. */
  model: string;
  permission: PilotPermission;
  maxConcurrent: number;
  /** USD per run; 0 means no cap. */
  maxBudgetUsd: number;
  /** 0 means no limit. */
  maxTurns: number;
}

export interface Settings {
  window: WindowSettings;
  claude: ClaudeSettings;
  pilots: PilotSettings;
}

// ---- Chat ----

export type ChatEvent =
  | { kind: "started"; sessionId: string | null; model: string | null }
  | { kind: "usage"; model: string | null; inputTokens: number; cacheWriteTokens: number; cacheReadTokens: number; outputTokens: number }
  | { kind: "textDelta"; text: string }
  | { kind: "toolUse"; name: string; detail: string }
  | { kind: "done"; text: string; sessionId: string | null; costUsd: number | null; durationMs: number | null; isError: boolean }
  | { kind: "error"; message: string };

export interface ThreadSummary {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}

export type ProposalStatus = "pending" | "accepted" | "partial" | "rejected";

export interface ProposalState {
  summary: string;
  ops: BoardOp[];
  dropped: string[];
  status: ProposalStatus;
  /** Notes from applying, e.g. edits skipped because a shape was gone. */
  notes?: string[];
  /** Display names of the shapes the ops refer to, captured when the reply arrived. */
  names?: Record<string, string>;
}

export interface TokenUsage {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

export interface ToolCall {
  name: string;
  detail: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  /** User messages: what part of the board was sent. */
  scope?: "board" | "selection";
  shapeCount?: number;
  /** Assistant messages with edits: alias map of the board they refer to. */
  aliases?: AliasMap;
  proposal?: ProposalState;
  tools?: ToolCall[];
  /** Model that answered, as reported by Claude Code. */
  model?: string;
  tokens?: TokenUsage;
  /** Estimated cost of this turn alone. */
  costUsd?: number | null;
  /** Time from sending to the first word of the reply. */
  firstTokenMs?: number | null;
  /** Time from sending to the finished reply. */
  durationMs?: number | null;
  error?: string;
}

export interface ChatThread {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Claude Code session to resume for the next message. */
  sessionId?: string;
  /** Claude Code's running cost estimate for that session, to work out each turn's cost. */
  sessionCostUsd?: number;
  messages: ChatMessage[];
}

// ---- GitHub ----

export interface GhStatus {
  installed: boolean;
  version: string | null;
  user: string | null;
}

export interface RemoteStatus {
  remoteUrl: string | null;
  webUrl: string | null;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  uncommitted: number;
}

// ---- Pilots ----

export type PilotStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";

export interface PilotTokens {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

export interface PilotMeta {
  id: string;
  title: string;
  instructions: string;
  scope: string;
  model: string;
  permission: PilotPermission;
  maxBudgetUsd: number;
  maxTurns: number;
  status: PilotStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  branch: string;
  baseCommit: string | null;
  resultCommit: string | null;
  sessionId: string | null;
  modelUsed: string | null;
  permissionMode: string | null;
  costUsd: number | null;
  tokens: PilotTokens;
  runs: number;
  durationMs: number;
  denials: string[];
  error: string | null;
  pinned: boolean;
  hasReport: boolean;
  followUps: { at: string; instructions: string }[];
}

export interface Activity {
  kind: "text" | "tool" | "system" | "result" | "error";
  text: string;
  detail?: string;
}

export interface PilotEvent {
  boardPath: string;
  id: string;
  meta?: PilotMeta;
  activity?: Activity;
}

export interface FileChange {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked";
  added: number | null;
  removed: number | null;
}

export interface PilotFile {
  path: string;
  size: number;
}

export interface FileContent {
  kind: "text" | "image" | "binary";
  text: string | null;
  dataUrl: string | null;
  size: number;
  truncated: boolean;
}

export interface DeleteInfo {
  branchExists: boolean;
  unsavedCommits: number;
  pushed: boolean;
  hasWorktree: boolean;
}
