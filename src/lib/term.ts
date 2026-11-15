// The TypeScript side of the terminal commands. Output arrives as raw bytes over a Channel (an ArrayBuffer).
import { Channel, invoke } from "@tauri-apps/api/core";
import type { Engine } from "./agent";

export type StartMode = "fresh" | "resume";
export interface TermInfo { id: string; sessionId: string | null; engine: Engine; running: boolean; exitCode: number | null; windowsBuild: number | null; label: string | null; cwd: string | null }
export interface TermExit { id: string; sessionId: string | null; code: number | null }

export const termOpen = (a: { sessionId: string; cols: number; rows: number; start: StartMode | null; replay: boolean; output: Channel<ArrayBuffer> }) =>
  invoke<TermInfo>("term_open", a);
export const termLogin = (a: { engine: Engine; cols: number; rows: number; output: Channel<ArrayBuffer> }) => invoke<TermInfo>("term_login", a);
/** Where a PowerShell tab starts: a session's folder, a project's registered repository, or a picked folder. */
export type ShellTarget = { session: string } | { checkout: { project: string; repo: string } } | { folder: string };
export const termShell = (target: ShellTarget, cols: number, rows: number, output: Channel<ArrayBuffer>) =>
  invoke<TermInfo>("term_shell", { target, cols, rows, output });
export const termWrite = (id: string, data: string) => invoke<void>("term_write", { id, data });
export const termResize = (id: string, cols: number, rows: number) => invoke<void>("term_resize", { id, cols, rows });
export const termClose = (id: string) => invoke<void>("term_close", { id });
export const termList = () => invoke<TermInfo[]>("term_list");
/** Exit the app now; `RunEvent::Exit` stops every program. */
export const appQuit = () => invoke<void>("app_quit");
export const quitAck = () => invoke<void>("quit_ack");
