// One close handler for the whole app. Tauri closes the window as soon as
// any close handler finishes without preventing it, so components must not
// register their own; they add work to run before closing with beforeClose().

import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { api } from "./api";

const hooks = new Set<() => Promise<void>>();

/** Runs `fn` before the window closes (e.g. saving the board). Returns an unregister function. */
export function beforeClose(fn: () => Promise<void>): () => void {
  hooks.add(fn);
  return () => {
    hooks.delete(fn);
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

let installed = false;

export function installCloseGuard() {
  if (installed) return;
  installed = true;
  getCurrentWindow().onCloseRequested(async (event) => {
    try {
      const work = await api.activeWork();
      if (work.pilots + work.chats > 0) {
        const what = [work.pilots && plural(work.pilots, "pilot"), work.chats && plural(work.chats, "chat reply")].filter(Boolean).join(" and ");
        const ok = await ask(
          `${what} still running. Closing stops ${work.pilots + work.chats === 1 ? "it" : "them"}. ` +
            (work.pilots ? "Stopped pilots show as Interrupted and can be resumed next time." : ""),
          { title: "Close Ideation?", kind: "warning", okLabel: "Stop and close", cancelLabel: "Keep running" },
        );
        if (!ok) {
          event.preventDefault();
          return;
        }
        await api.stopAllWork();
      }
    } catch {
      // Never let a failed check keep the window open.
    }
    for (const fn of hooks) {
      try {
        await fn();
      } catch {
        /* keep closing */
      }
    }
  });
}
