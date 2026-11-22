// Typed wrappers around the Rust commands in src-tauri/src/main.rs.
import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  Activity,
  BoardInfo,
  ChatEvent,
  ChatThread,
  DeleteInfo,
  Environment,
  FileChange,
  FileContent,
  GhStatus,
  PilotFile,
  PilotMeta,
  PilotPermission,
  RecentBoard,
  RemoteStatus,
  Settings,
  ThreadSummary,
} from "./types";

export const api = {
  checkEnvironment: () => invoke<Environment>("check_environment"),
  listRecentBoards: () => invoke<RecentBoard[]>("list_recent_boards"),
  forgetBoard: (path: string) => invoke<void>("forget_board", { path }),
  createBoard: (parent: string, name: string) => invoke<BoardInfo>("create_board", { parent, name }),
  openBoard: (path: string) => invoke<BoardInfo>("open_board", { path }),
  loadScene: (path: string) => invoke<string>("load_scene", { path }),
  saveScene: (path: string, scene: string) => invoke<void>("save_scene", { path, scene }),
  /** Resolves to false when there was nothing new to commit. */
  commitBoard: (path: string, message: string) => invoke<boolean>("commit_board", { path, message }),

  getSettings: () => invoke<Settings>("get_settings"),
  /** Saves and immediately applies the settings. */
  saveSettings: (settings: Settings) => invoke<Settings>("save_settings", { settings }),
  currentWindowSize: () => invoke<[number, number]>("current_window_size"),

  /** Runs one chat turn; events arrive on `onEvent`. Resolves when Claude is done. */
  chatSend: (args: { requestId: string; boardPath: string; sessionId: string | null; prompt: string; onEvent: Channel<ChatEvent> }) =>
    invoke<void>("chat_send", args),
  chatCancel: (requestId: string) => invoke<boolean>("chat_cancel", { requestId }),
  listThreads: (boardPath: string) => invoke<ThreadSummary[]>("list_threads", { boardPath }),
  loadThread: (boardPath: string, id: string) => invoke<ChatThread>("load_thread", { boardPath, id }),
  saveThread: (boardPath: string, thread: ChatThread) => invoke<void>("save_thread", { boardPath, thread }),
  deleteThread: (boardPath: string, id: string) => invoke<void>("delete_thread", { boardPath, id }),

  githubStatus: () => invoke<GhStatus>("github_status"),
  githubLogin: () => invoke<void>("github_login"),
  githubOwners: () => invoke<string[]>("github_owners"),
  repoRemoteStatus: (path: string) => invoke<RemoteStatus>("repo_remote_status", { path }),
  repoFetch: (path: string) => invoke<RemoteStatus>("repo_fetch", { path }),
  repoPublish: (path: string, owner: string, name: string, isPrivate: boolean, description: string) =>
    invoke<RemoteStatus>("repo_publish", { path, owner, name, private: isPrivate, description }),
  repoPush: (path: string) => invoke<RemoteStatus>("repo_push", { path }),
  repoPull: (path: string) => invoke<RemoteStatus>("repo_pull", { path }),

  pilotsList: (boardPath: string) => invoke<PilotMeta[]>("pilots_list", { boardPath }),
  pilotGet: (boardPath: string, id: string) => invoke<PilotMeta>("pilot_get", { boardPath, id }),
  pilotStart: (args: {
    boardPath: string;
    title: string;
    instructions: string;
    prompt: string;
    scope: string;
    model: string;
    permission: PilotPermission;
    maxBudgetUsd: number;
    maxTurns: number;
  }) => invoke<PilotMeta>("pilot_start", args),
  pilotFollowUp: (boardPath: string, id: string, instructions: string, prompt: string) =>
    invoke<PilotMeta>("pilot_follow_up", { boardPath, id, instructions, prompt }),
  pilotCancel: (boardPath: string, id: string) => invoke<void>("pilot_cancel", { boardPath, id }),
  pilotDeleteInfo: (boardPath: string, id: string) => invoke<DeleteInfo>("pilot_delete_info", { boardPath, id }),
  pilotDelete: (boardPath: string, id: string) => invoke<void>("pilot_delete", { boardPath, id }),
  pilotSetPinned: (boardPath: string, id: string, pinned: boolean) => invoke<PilotMeta>("pilot_set_pinned", { boardPath, id, pinned }),
  pilotActivity: (boardPath: string, id: string) => invoke<Activity[]>("pilot_activity", { boardPath, id }),
  pilotChanges: (boardPath: string, id: string) => invoke<FileChange[]>("pilot_changes", { boardPath, id }),
  pilotFileDiff: (boardPath: string, id: string, path: string) => invoke<string>("pilot_file_diff", { boardPath, id, path }),
  pilotResults: (boardPath: string, id: string) => invoke<PilotFile[]>("pilot_results", { boardPath, id }),
  pilotReadFile: (boardPath: string, id: string, path: string) => invoke<FileContent>("pilot_read_file", { boardPath, id, path }),
  pilotPush: (boardPath: string, id: string) => invoke<void>("pilot_push", { boardPath, id }),
  pilotWorktreePath: (boardPath: string, id: string) => invoke<string>("pilot_worktree_path", { boardPath, id }),
  pilotStartAgain: (boardPath: string, id: string) => invoke<PilotMeta>("pilot_start_again", { boardPath, id }),

  activeWork: () => invoke<{ pilots: number; chats: number }>("active_work"),
  stopAllWork: () => invoke<void>("stop_all_work"),
};

export { Channel };

export function errorText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
}
