import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useProjectsEnabled } from "../../lib/connection";
import { captureStatus, getSettings, saveSettings, type CaptureStatus, type Settings } from "../../lib/lm";
import { prefs } from "../../lib/prefs";
import { applyTheme, THEMES, useTheme, type Theme } from "../../lib/theme";
import type { Mode } from "../../workspace/store";
import { projectsQuery } from "../projects/useProject";
import { withCommands } from "./commands";

const DEFAULT_SHORTCUT = "CommandOrControl+Alt+M";
type PathKey = "python" | "script" | "root" | "claude_path" | "codex_path" | "architecture_suite_plugin";

/** Where Hivemind finds Python, living_memory.py and the store; quick capture; editor default. */
export function SettingsForm({ onSaved }: { onSaved: () => void }) {
  const [value, setValue] = useState<Settings>({ python: null, script: null, root: null });
  const [status, setStatus] = useState<CaptureStatus | null>(null);
  const [mode, setMode] = useState<Mode>(prefs.defaultMode());
  const [error, setError] = useState<string | null>(null);
  const theme = useTheme();
  const projectsOn = useProjectsEnabled();
  const projects = useQuery({ ...projectsQuery(), enabled: projectsOn, retry: false });
  const live = (projects.data?.projects ?? []).filter((p) => p.status !== "archived");
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
      {field("codex_path", "Codex", "default: the codex installed with npm")}
      {field("architecture_suite_plugin", "Architecture Suite plugin folder", "only when the plugin is not installed in Claude Code")}
      <label className="field">
        <span>Spend cap per agent run (USD), Claude Code chat only</span>
        <input type="number" min="0.5" step="0.5" value={value.agent_budget_usd ?? ""} placeholder="5"
          onChange={(e) => setValue({ ...value, agent_budget_usd: e.target.value ? Number(e.target.value) : null })} />
      </label>
      {!!live.length && (
        <>
          <h3>Allowed commands</h3>
          <p className="muted small">Commands a session in the Developer or Tester role may run without asking, one per line, such as <code>npm test</code>. Arguments after a command are allowed too. A command may not chain another with <code>;</code>, <code>|</code>, <code>&amp;</code> or redirect output. Unattended sessions refuse every other command.</p>
          {live.map((p) => (
            <label key={p.slug} className="field">
              <span>{p.name}</span>
              <textarea rows={2} defaultValue={(value.allowed_commands?.[p.slug] ?? []).join("\n")} key={JSON.stringify(value.allowed_commands?.[p.slug] ?? [])}
                onBlur={(e) => setValue((v) => ({ ...v, allowed_commands: withCommands(v.allowed_commands, p.slug, e.target.value) }))} />
            </label>
          ))}
        </>
      )}
      <p className="muted small">Hivemind starts Claude Code or Codex for you; each uses its own saved sign-in. A background task, such as generating a system's architecture, may only read the system's repositories, run Architecture Suite and write to the system's architecture folder. An interactive session works in its own git worktree. It asks before it edits files or runs commands, except where you chose “Accept edits” or your own Claude Code settings already allow the action. The cap applies to each run of the agent; continuing a session after the cap starts a new run. The cap does not apply in the terminal or to Codex.</p>

      <h3>Learning</h3>
      <label className="check"><input type="checkbox" checked={value.learning_reviewer ?? true}
        onChange={(e) => setValue({ ...value, learning_reviewer: e.target.checked })} /> Review finished sessions for notes and skills worth keeping</label>
      <label className="field">
        <span>Daily learning budget (USD)</span>
        <input type="number" min="0" step="0.25" value={value.learning_daily_usd ?? ""} placeholder="1"
          onChange={(e) => setValue({ ...value, learning_daily_usd: e.target.value ? Number(e.target.value) : null })} />
      </label>
      <p className="muted small">When you approve or discard a chat session's edits, or a long session ends, Hivemind sends a summary of the session to Claude (Sonnet, no tools, at most $0.25 a review). Notes it proposes wait in Review and are saved only when you accept them; skills are proposed only from sessions you approved. The budget applies per day (UTC); 0 stops reviews.</p>
      <label className="check"><input type="checkbox" checked={value.skills_auto_patch ?? false}
        onChange={(e) => setValue({ ...value, skills_auto_patch: e.target.checked })} /> Apply reviewer changes to a skill without asking when sessions using it were approved at least 3 times</label>
      <p className="muted small">New skills always wait for you. Every change is in the skill's history and can be undone with Restore.</p>

      <h3>Editor</h3>
      <label className="field">
        <span>Open notes in</span>
        <select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
          <option value="reading">Reading view</option>
          <option value="live">Live preview editor</option>
          <option value="source">Source (plain Markdown)</option>
        </select>
      </label>

      <h3>Appearance</h3>
      <label className="field">
        <span>Theme</span>
        <select value={theme} onChange={(e) => applyTheme(e.target.value as Theme)}>
          {THEMES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
      </label>
      <p className="muted small">The theme changes at once and is kept on this computer; it does not need Save.</p>
      {error && <p className="error">{error}</p>}
      <button type="submit" className="primary">Save</button>
    </form>
  );
}
