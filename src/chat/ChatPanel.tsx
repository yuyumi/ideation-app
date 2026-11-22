import { useCallback, useEffect, useRef, useState } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { api, Channel, errorText } from "../api";
import { applyToScene, hideGhosts, showGhosts } from "../board/applyOps";
import { parseProposal, resolveSelection, splitReply, type BoardOp } from "../board/proposals";
import { buildPrompt, serializeBoard, type AliasMap } from "../board/serialize";
import type { ChatEvent, ChatMessage, ChatThread, ThreadSummary, TokenUsage, ToolCall } from "../types";
import Markdown from "./Markdown";
import ProposalCard from "./ProposalCard";

interface Props {
  boardPath: string;
  getApi: () => ExcalidrawImperativeAPI | null;
}

interface Streaming {
  requestId: string;
  text: string;
  tools: ToolCall[];
  model: string | null;
}

type Scope = "board" | "selection";

const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

function newThread(firstMessage: string): ChatThread {
  const title = firstMessage.replace(/\s+/g, " ").trim().slice(0, 60) || "New conversation";
  return { id: uuid(), title, createdAt: now(), updatedAt: now(), messages: [] };
}

function selectedCount(api: ExcalidrawImperativeAPI): number {
  return Object.values(api.getAppState().selectedElementIds).filter(Boolean).length;
}

export default function ChatPanel({ boardPath, getApi }: Props) {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [thread, setThreadState] = useState<ChatThread | null>(null);
  const threadRef = useRef<ChatThread | null>(null);
  const [showList, setShowList] = useState(false);
  const [input, setInput] = useState("");
  const [scope, setScope] = useState<Scope>("board");
  const [streaming, setStreaming] = useState<Streaming | null>(null);
  const [previewing, setPreviewing] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const refreshThreads = useCallback(() => api.listThreads(boardPath).then(setThreads).catch(() => {}), [boardPath]);

  /** Updates the thread in state and on disk. Uses a ref so async flows see the latest version. */
  const updateThread = useCallback(
    async (fn: (t: ChatThread) => ChatThread) => {
      const base = threadRef.current;
      if (!base) return;
      const next = { ...fn(base), updatedAt: now() };
      threadRef.current = next;
      setThreadState(next);
      await api.saveThread(boardPath, next).catch((e) => setError(errorText(e)));
    },
    [boardPath],
  );

  const clearAllPreviews = useCallback(() => {
    const ex = getApi();
    if (ex) previewing.forEach((id) => hideGhosts(ex, id));
    setPreviewing(new Set());
  }, [getApi, previewing]);

  const openThread = useCallback(
    async (id: string | null) => {
      clearAllPreviews();
      setShowList(false);
      setError(null);
      if (!id) {
        threadRef.current = null;
        setThreadState(null);
        return;
      }
      try {
        const t = await api.loadThread(boardPath, id);
        threadRef.current = t;
        setThreadState(t);
      } catch (e) {
        setError(errorText(e));
      }
    },
    [boardPath, clearAllPreviews],
  );

  // Open the most recent thread on first load.
  useEffect(() => {
    api.listThreads(boardPath).then((list) => {
      setThreads(list);
      if (list.length > 0) openThread(list[0].id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardPath]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [thread?.messages.length, streaming?.text, streaming?.tools.length]);

  const send = async () => {
    const text = input.trim();
    const ex = getApi();
    if (!text || streaming || !ex) return;
    setError(null);
    if (scope === "selection" && selectedCount(ex) === 0) {
      setError("Nothing is selected. Select shapes on the board, or switch to Whole board.");
      return;
    }

    const selected = scope === "selection" ? ex.getAppState().selectedElementIds : null;
    const { board, aliases } = serializeBoard(ex.getSceneElementsIncludingDeleted(), selected);
    const userMsg: ChatMessage = { id: uuid(), role: "user", text, createdAt: now(), scope, shapeCount: board.shapes.length };

    if (!threadRef.current) {
      const t = newThread(text);
      threadRef.current = t;
      setThreadState(t);
    }
    await updateThread((t) => ({ ...t, messages: [...t.messages, userMsg] }));
    setInput("");

    const requestId = uuid();
    const live: Streaming = { requestId, text: "", tools: [], model: null };
    setStreaming(live);
    let done: Extract<ChatEvent, { kind: "done" }> | null = null;
    let startedSession: string | null = null;
    let failure: string | null = null;
    const tokens: TokenUsage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
    const t0 = performance.now();
    let firstTokenMs: number | null = null;

    const channel = new Channel<ChatEvent>();
    channel.onmessage = (ev) => {
      if (ev.kind === "started") {
        startedSession = ev.sessionId;
        live.model = ev.model;
      } else if (ev.kind === "usage") {
        if (ev.model) live.model = ev.model;
        tokens.input += ev.inputTokens;
        tokens.cacheWrite += ev.cacheWriteTokens;
        tokens.cacheRead += ev.cacheReadTokens;
        tokens.output += ev.outputTokens;
      } else if (ev.kind === "textDelta") {
        firstTokenMs ??= Math.round(performance.now() - t0);
        live.text += ev.text;
      }
      else if (ev.kind === "toolUse") live.tools = [...live.tools, { name: ev.name, detail: ev.detail }];
      else if (ev.kind === "done") done = ev;
      else if (ev.kind === "error") failure = ev.message;
      setStreaming({ ...live });
    };

    try {
      await api.chatSend({
        requestId,
        boardPath,
        sessionId: threadRef.current?.sessionId ?? null,
        prompt: buildPrompt(text, board),
        onEvent: channel,
      });
    } catch (e) {
      failure ??= errorText(e);
    }

    const result = done as Extract<ChatEvent, { kind: "done" }> | null;
    const durationMs = Math.round(performance.now() - t0);
    const usage = {
      model: live.model ?? undefined,
      tokens: tokens.input + tokens.cacheWrite + tokens.cacheRead + tokens.output > 0 ? { ...tokens } : undefined,
      firstTokenMs,
      durationMs,
    };
    // Claude Code reports a running total for a resumed session; this turn's cost is the difference.
    const prior = threadRef.current;
    const resumed = !!result?.sessionId && result.sessionId === prior?.sessionId;
    const total = result?.costUsd ?? null;
    // Conversations from before per-turn costs were tracked have no stored total;
    // there, the last reply's figure was the running total at that point.
    const lastReported = [...(prior?.messages ?? [])].reverse().find((m) => m.role === "assistant" && m.costUsd != null)?.costUsd ?? 0;
    const prevTotal = resumed ? prior?.sessionCostUsd ?? lastReported : 0;
    const turnCost = total == null ? null : total >= prevTotal ? total - prevTotal : total;
    let reply: ChatMessage;
    if (result) {
      const { prose, block } = splitReply(result.text);
      const proposal = block ? parseProposal(block, aliases) : undefined;
      reply = {
        id: uuid(),
        role: "assistant",
        text: prose,
        createdAt: now(),
        tools: live.tools,
        ...usage,
        costUsd: turnCost,
        error: result.isError ? "Claude Code reported an error for this turn." : undefined,
      };
      if (proposal) {
        reply.aliases = aliases;
        reply.proposal = {
          ...proposal,
          status: proposal.ops.length > 0 ? "pending" : "rejected",
          names: captureNames(proposal.ops, aliases, ex),
        };
      }
    } else {
      reply = { id: uuid(), role: "assistant", text: live.text, createdAt: now(), tools: live.tools, ...usage, error: failure ?? "No reply." };
    }

    const session = result?.sessionId ?? startedSession;
    await updateThread((t) => ({
      ...t,
      sessionId: session ?? t.sessionId,
      sessionCostUsd: total ?? t.sessionCostUsd,
      messages: [...t.messages, reply],
    }));
    setStreaming(null);
    refreshThreads();

    if (reply.proposal?.status === "pending" && reply.aliases) {
      const notes = showGhosts(ex, reply.id, reply.proposal.ops, reply.aliases);
      setPreviewing((p) => new Set(p).add(reply.id));
      if (notes.length) await updateThread((t) => withProposal(t, reply.id, (p) => ({ ...p, notes })));
    }
  };

  const stop = () => {
    if (streaming) api.chatCancel(streaming.requestId);
  };

  const togglePreview = (msg: ChatMessage) => {
    const ex = getApi();
    if (!ex || !msg.proposal || !msg.aliases) return;
    const next = new Set(previewing);
    if (previewing.has(msg.id)) {
      hideGhosts(ex, msg.id);
      next.delete(msg.id);
    } else {
      showGhosts(ex, msg.id, msg.proposal.ops, msg.aliases);
      next.add(msg.id);
    }
    setPreviewing(next);
  };

  const accept = async (msg: ChatMessage, selected: Set<number>) => {
    const ex = getApi();
    if (!ex || !msg.proposal || !msg.aliases) return;
    const ops = msg.proposal.ops;
    const { apply, skipped } = resolveSelection(ops, selected);
    const notes = applyToScene(ex, msg.id, apply.map((i) => ops[i]), msg.aliases);
    setPreviewing((p) => {
      const n = new Set(p);
      n.delete(msg.id);
      return n;
    });
    const status = apply.length === ops.length ? "accepted" : apply.length === 0 ? "rejected" : "partial";
    await updateThread((t) => withProposal(t, msg.id, (p) => ({ ...p, status, notes: [...skipped, ...notes] })));
  };

  const reject = async (msg: ChatMessage) => {
    const ex = getApi();
    if (ex) hideGhosts(ex, msg.id);
    setPreviewing((p) => {
      const n = new Set(p);
      n.delete(msg.id);
      return n;
    });
    await updateThread((t) => withProposal(t, msg.id, (p) => ({ ...p, status: "rejected" })));
  };

  const removeThread = async (id: string) => {
    setConfirmDelete(null);
    await api.deleteThread(boardPath, id).catch((e) => setError(errorText(e)));
    if (threadRef.current?.id === id) openThread(null);
    refreshThreads();
  };

  const nameOf = (msg: ChatMessage) => (id: string) =>
    msg.proposal?.names?.[id] ?? shapeName(id, msg.aliases ?? {}, msg.proposal?.ops ?? [], getApi());

  if (showList) {
    return (
      <div className="chat">
        <div className="chat-head">
          <button className="ghost small" onClick={() => setShowList(false)}>← Back</button>
          <strong className="grow">Conversations</strong>
          <button className="small" onClick={() => openThread(null)}>New</button>
        </div>
        <ul className="thread-list">
          {threads.length === 0 && <li className="muted pad">No conversations yet.</li>}
          {threads.map((t) => (
            <li key={t.id} className={t.id === thread?.id ? "active" : ""}>
              <button className="link" onClick={() => openThread(t.id)}>
                <span>{t.title}</span>
                <span className="muted small">
                  {t.messageCount} messages · {new Date(t.updatedAt).toLocaleString()}
                </span>
              </button>
              {confirmDelete === t.id ? (
                <span className="row">
                  <button className="small danger" onClick={() => removeThread(t.id)}>Delete</button>
                  <button className="small ghost" onClick={() => setConfirmDelete(null)}>Keep</button>
                </span>
              ) : (
                <button className="small ghost" title="Delete conversation" onClick={() => setConfirmDelete(t.id)}>✕</button>
              )}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="chat">
      <div className="chat-head">
        <button className="ghost small" onClick={() => setShowList(true)} title="All conversations">☰</button>
        <strong className="grow ellipsis">{thread?.title ?? "New conversation"}</strong>
        <button className="small" onClick={() => openThread(null)} disabled={!!streaming}>New</button>
      </div>

      <div className="messages">
        {!thread || thread.messages.length === 0 ? (
          <div className="empty muted">
            <p>Ask about the board, or ask Claude to improve it.</p>
            <p className="small">Suggested edits appear on the board as a preview. Nothing changes until you accept.</p>
          </div>
        ) : (
          thread.messages.map((m) => (
            <div key={m.id} className={`msg ${m.role}`}>
              {m.role === "user" ? (
                <>
                  <div className="bubble">{m.text}</div>
                  <div className="meta muted small">
                    {m.scope === "selection" ? `Selection, ${m.shapeCount} shapes` : `Whole board, ${m.shapeCount} shapes`}
                  </div>
                </>
              ) : (
                <>
                  {m.tools && m.tools.length > 0 && <ToolList tools={m.tools} />}
                  {m.text && <Markdown text={m.text} />}
                  {m.proposal && (
                    <ProposalCard
                      proposal={m.proposal}
                      previewing={previewing.has(m.id)}
                      busy={!!streaming}
                      nameOf={nameOf(m)}
                      onTogglePreview={() => togglePreview(m)}
                      onAccept={(sel) => accept(m, sel)}
                      onReject={() => reject(m)}
                    />
                  )}
                  {m.error && <div className="error small">{m.error}</div>}
                  <UsageLine m={m} />
                </>
              )}
            </div>
          ))
        )}
        {streaming && (
          <div className="msg assistant">
            {streaming.tools.length > 0 && <ToolList tools={streaming.tools} />}
            {streaming.text ? (
              <Markdown text={splitReply(streaming.text).prose} />
            ) : (
              <div className="muted small typing">{streaming.model ? `${shortModel(streaming.model)} is thinking…` : "Starting Claude Code…"}</div>
            )}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {error && <div className="error small chat-error">{error}</div>}

      <div className="composer">
        <div className="scope">
          <button className={scope === "board" ? "on" : ""} onClick={() => setScope("board")}>Whole board</button>
          <button className={scope === "selection" ? "on" : ""} onClick={() => setScope("selection")}>Selection</button>
        </div>
        <textarea
          placeholder="Ask about the board… (Enter to send, Shift+Enter for a new line)"
          value={input}
          rows={3}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="row">
          <span className="grow" />
          {streaming ? (
            <button onClick={stop}>Stop</button>
          ) : (
            <button className="primary" onClick={send} disabled={!input.trim()}>Send</button>
          )}
        </div>
      </div>
    </div>
  );
}

const fmtTokens = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const fmtSecs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const fmtCost = (usd: number) => (usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(3)}`);
/** "claude-sonnet-4-5-20250929" -> "claude-sonnet-4-5" */
const shortModel = (m: string) => m.replace(/-\d{8}$/, "");

/** Model, tokens, cost and latency under a reply; full numbers on hover. */
function UsageLine({ m }: { m: ChatMessage }) {
  const parts: string[] = [];
  const t = m.tokens;
  if (m.model) parts.push(shortModel(m.model));
  if (t) parts.push(`${fmtTokens(t.input + t.cacheWrite + t.cacheRead)} in · ${fmtTokens(t.output)} out`);
  if (m.costUsd != null) parts.push(fmtCost(m.costUsd));
  if (m.firstTokenMs != null) parts.push(`${fmtSecs(m.firstTokenMs)} to first word`);
  if (m.durationMs != null) parts.push(`${fmtSecs(m.durationMs)} total`);
  if (parts.length === 0) return null;
  const detail = t
    ? [
        m.model && `Model: ${m.model}`,
        `Input tokens: ${t.input.toLocaleString()}`,
        `Written to cache: ${t.cacheWrite.toLocaleString()}`,
        `Read from cache: ${t.cacheRead.toLocaleString()}`,
        `Output tokens: ${t.output.toLocaleString()}`,
        m.costUsd != null && `Cost estimate for this turn: $${m.costUsd.toFixed(4)} (list price; on a subscription this counts toward plan limits)`,
      ]
        .filter(Boolean)
        .join("\n")
    : undefined;
  const cacheShare = t && t.cacheRead + t.cacheWrite > 0 ? t.cacheRead / (t.cacheRead + t.cacheWrite) : null;
  return (
    <div className="meta muted small usage" title={detail}>
      {parts.join(" · ")}
      {cacheShare != null && (
        <span className={cacheShare >= 0.5 ? "cache hit" : "cache miss"}>
          {cacheShare >= 0.5 ? `cache hit ${Math.round(cacheShare * 100)}%` : "cache written"}
        </span>
      )}
    </div>
  );
}

function ToolList({ tools }: { tools: ToolCall[] }) {
  return (
    <ul className="tools muted small">
      {tools.map((t, i) => (
        <li key={i}>
          {t.name} <code>{t.detail}</code>
        </li>
      ))}
    </ul>
  );
}

function withProposal(t: ChatThread, msgId: string, fn: (p: NonNullable<ChatMessage["proposal"]>) => NonNullable<ChatMessage["proposal"]>): ChatThread {
  return { ...t, messages: t.messages.map((m) => (m.id === msgId && m.proposal ? { ...m, proposal: fn(m.proposal) } : m)) };
}

/** Names for every shape id the ops mention, as the board looked when the reply arrived. */
function captureNames(ops: BoardOp[], aliases: AliasMap, ex: ExcalidrawImperativeAPI): Record<string, string> {
  const ids = new Set<string>();
  for (const o of ops) {
    ids.add(o.id);
    if (o.op === "create" && o.type === "arrow") {
      ids.add(o.from);
      ids.add(o.to);
    }
  }
  return Object.fromEntries([...ids].map((id) => [id, shapeName(id, aliases, ops, ex)]));
}

type Labelled = { id: string; type: string; containerId?: string | null; originalText?: string; startBinding?: { elementId: string } | null; endBinding?: { elementId: string } | null };

/** "Server" for labelled shapes, "ellipse s2" otherwise, "new \"Cache\"" for proposed ones. */
function shapeName(id: string, aliases: AliasMap, ops: BoardOp[], ex: ExcalidrawImperativeAPI | null): string {
  if (/^n\d+$/.test(id)) {
    const op = ops.find((o) => o.op === "create" && o.id === id);
    if (op && op.op === "create" && op.type !== "arrow") return op.text ? `new "${op.text}"` : `new ${op.type}`;
    return `new ${id}`;
  }
  if (!ex) return id;
  const scene = ex.getSceneElements() as unknown as Labelled[];
  const textOf = (elId: string): string | undefined => {
    const el = scene.find((e) => e.id === elId);
    if (!el) return undefined;
    const label = el.type === "text" ? el : scene.find((e) => e.type === "text" && e.containerId === elId);
    const t = label?.originalText?.replace(/\s+/g, " ").trim();
    return t ? `"${t.length > 30 ? t.slice(0, 30) + "…" : t}"` : undefined;
  };
  const elId = aliases[id];
  const el = scene.find((e) => e.id === elId);
  if (!el) return `${id} (no longer on the board)`;
  if (el.type === "arrow" && (el.startBinding || el.endBinding)) {
    const from = el.startBinding ? textOf(el.startBinding.elementId) ?? "?" : "?";
    const to = el.endBinding ? textOf(el.endBinding.elementId) ?? "?" : "?";
    return `arrow ${from} → ${to}`;
  }
  return textOf(elId) ?? `${el.type} ${id}`;
}
