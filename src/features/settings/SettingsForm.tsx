import { useEffect, useState } from "react";
import { captureStatus, getSettings, saveSettings, type CaptureStatus, type Settings } from "../../lib/lm";
import { prefs } from "../../lib/prefs";
import type { Mode } from "../../workspace/store";

const DEFAULT_SHORTCUT = "CommandOrControl+Alt+M";
type PathKey = "python" | "script" | "root" | "claude_path" | "architecture_suite_plugin";

/** Where Hivemind finds Python, living_memory.py and the store; quick capture; editor default. */
export function SettingsForm({ onSaved }: { onSaved: () => void }) {
  const [value, setValue] = useState<Settings>({ python: null, script: null, root: null });
  const [status, setStatus] = useState<CaptureStatus | null>(null);
  const [mode, setMode] = useState<Mode>(prefs.defaultMode());
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    getSettings().then(setValue).catch((e) => setError(String(e)));
    captureStatus().then(setStatus).catch(() => {});
  }, []);
  const field = (key: PathKey, label: string, hint: string) => (
    <label className="field">
      <span>{label}</span>
      <input value={value[key] ?? ""} placeholder={hint} onChange={(e) => setValue({ ...value, [key]: e.target.value || null })} />
    </label>
  );
  const hotkeyOn = value.capture_shortcut !== "";
  return (
    <form className="settings" onSubmit={(e) => {
      e.preventDefault();
      prefs.setDefaultMode(mode);
      saveSettings(value).then(() => captureStatus().then(setStatus)).then(onSaved).catch((err) => setError(String(err)));
    }}>
      <h3>Living Memory</h3>
      {field("python", "Python", "default: py -3 on Windows, python3 elsewhere")}
      {field("script", "living_memory.py", "default: the installed Living Memory copy")}
      {field("root", "Store root", "default: the store Living Memory is configured for")}
      <p className="muted small">Environment variables HIVEMIND_PYTHON, HIVEMIND_LM_SCRIPT and HIVEMIND_LM_ROOT override these.</p>

      <h3>Quick capture</h3>
      <label className="check"><input type="checkbox" checked={hotkeyOn}
        onChange={(e) => setValue({ ...value, capture_shortcut: e.target.checked ? null : "" })} /> Global hotkey opens the capture window</label>
      {hotkeyOn && (
        <label className="field">
          <span>Hotkey</span>
          <input value={value.capture_shortcut ?? ""} placeholder={DEFAULT_SHORTCUT}
            onChange={(e) => setValue({ ...value, capture_shortcut: e.target.value || null })} />
        </label>
      )}
      {status?.error && <p className="error small">{status.error}</p>}
      <label className="check"><input type="checkbox" checked={value.close_to_tray ?? true}
        onChange={(e) => setValue({ ...value, close_to_tray: e.target.checked })} /> Closing the window keeps Hivemind in the tray</label>
      <p className="muted small">The tray icon also opens quick capture. Use “Quit Hivemind” in its menu to exit.</p>

      <h3>Agents</h3>
      {field("claude_path", "Claude Code", "default: the installed claude command")}
      {field("architecture_suite_plugin", "Architecture Suite plugin folder", "only when the plugin is not installed in Claude Code")}
      <label className="field">
        <span>Spend cap per agent run (USD)</span>
        <input type="number" min="0.5" step="0.5" value={value.agent_budget_usd ?? ""} placeholder="5"
          onChange={(e) => setValue({ ...value, agent_budget_usd: e.target.value ? Number(e.target.value) : null })} />
      </label>
      <p className="muted small">Hivemind starts Claude Code for you. A background task, such as generating a system's architecture, may only read the system's repositories, run Architecture Suite and write to the system's architecture folder. An interactive session works in its own git worktree. It asks before it edits files or runs commands, except where you chose “Accept edits” or your own Claude Code settings already allow the action. The cap applies to each run of the agent; continuing a session after the cap starts a new run.</p>

      <h3>Editor</h3>
      <label className="field">
        <span>Open notes in</span>
        <select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
          <option value="reading">Reading view</option>
          <option value="live">Live preview editor</option>
          <option value="source">Source (plain Markdown)</option>
        </select>
      </label>
      {error && <p className="error">{error}</p>}
      <button type="submit" className="primary">Save</button>
    </form>
  );
}
