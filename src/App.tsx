import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import BoardPicker from "./home/BoardPicker";
import BoardView from "./board/BoardView";
import SettingsDialog from "./settings/SettingsDialog";
import type { BoardInfo } from "./types";

export default function App() {
  const [board, setBoard] = useState<BoardInfo | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const openSettings = () => setSettingsOpen(true);

  useEffect(() => {
    getCurrentWindow()
      .setTitle(board ? `${board.name} · Ideation` : "Ideation")
      .catch(() => {});
  }, [board]);

  return (
    <>
      {board ? (
        <BoardView key={board.path} board={board} onClose={() => setBoard(null)} onOpenSettings={openSettings} />
      ) : (
        <BoardPicker onOpen={setBoard} onOpenSettings={openSettings} />
      )}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </>
  );
}
