import { useEffect, useState } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import ChatPanel from "../chat/ChatPanel";
import type { PilotMeta } from "../types";
import PilotsPanel from "../pilots/PilotsPanel";

type Tab = "chat" | "pilots";

interface Props {
  boardPath: string;
  getApi: () => ExcalidrawImperativeAPI | null;
  /** Opens a pilot, e.g. after clicking its card on the board. */
  pilotRequest: { id: string; nonce: number; meta?: PilotMeta } | null;
  onNewPilot: () => void;
}

export default function Sidebar({ boardPath, getApi, pilotRequest, onNewPilot }: Props) {
  const [tab, setTab] = useState<Tab>("chat");

  useEffect(() => {
    if (pilotRequest) setTab("pilots");
  }, [pilotRequest]);

  return (
    <aside className="sidebar">
      <nav className="tabs">
        <button className={tab === "chat" ? "on" : ""} onClick={() => setTab("chat")}>Chat</button>
        <button className={tab === "pilots" ? "on" : ""} onClick={() => setTab("pilots")}>Pilots</button>
      </nav>
      {/* Both tabs stay mounted so a streaming reply or live pilot feed is not lost when switching. */}
      <div className="tab-body" hidden={tab !== "chat"}>
        <ChatPanel boardPath={boardPath} getApi={getApi} />
      </div>
      <div className="tab-body" hidden={tab !== "pilots"}>
        <PilotsPanel boardPath={boardPath} getApi={getApi} openRequest={pilotRequest} onNewPilot={onNewPilot} />
      </div>
    </aside>
  );
}
