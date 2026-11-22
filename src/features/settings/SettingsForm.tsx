import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ENGINE_LABELS, ENGINES, enginesText, shownEngines, type Engine } from "../../lib/agent";
import { pauseLmStore } from "../../documents/store";
import { useProjectsEnabled } from "../../lib/connection";
import { captureStatus, getSettings, saveSettings, type CaptureStatus, type Settings } from "../../lib/lm";
import { applyPaperDefault, PAPER_DEFAULTS, usePaperDefault, type PaperDefault } from "../../lib/paper";
import { prefs } from "../../lib/prefs";
import { applyTheme, THEMES, useTheme, type Theme } from "../../lib/theme";
import { useHidden } from "../../shell/hidden";
import { useAvailableSections } from "../../shell/Sidebar";
import type { Mode } from "../../workspace/store";
import { projectsQuery } from "../projects/useProject";
import { amount, BUDGET_DEFAULTS, EXECUTIVE_CALLS, withCallLimit } from "./budgets";
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
  const paper = usePaperDefault();
  const sections = useAvailableSections().filter((s) => s.page !== "home");
  const hidden = useHidden((s) => s.hidden);
  const setShown = useHidden((s) => s.setShown);
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
  // A daily budget may be 0 (that spending is off); a limit per run or per call must be more than 0, or empty for the default.
  const money = (key: "agent_budget_usd" | "automation_daily_usd" | "learning_daily_usd" | "review_call_usd", label: string, usd: number, min = 0) => (
    <label className="field">
      <span>{label}</span>
      <input type="number" min={min} step="any" value={value[key] ?? ""} placeholder={String(usd)}
        onChange={(e) => setValue({ ...value, [key]: amount(e.target.value) })} />
    </label>
  );
  const hotkeyOn = value.capture_shortcut !== "";
  const shown = shownEngines(value.hidden_engines);
  const claudeOn = shown.includes("claude");
  const showToggle = (e: Engine) => (
    <label className="check" key={e}><input type="checkbox" checked={shown.includes(e)} disabled={shown.length === 1 && shown.includes(e)}
      title={shown.length === 1 && shown.includes(e) ? "Keep at least one engine shown" : undefined}
      onChange={(ev) => setValue({ ...value, hidden_engines: ENGINES.filter((x) => (x === e ? !ev.target.checked : !shown.includes(x))) })} /> Show {ENGINE_LABELS[e]}</label>
  );
  return (
    <form className="settings" onSubmit={(e) => {
      e.preventDefault();
      prefs.setDefaultMode(mode);
      // Living Memory pages wait while the store may change, so none saves into the store being switched to (Codex
      // review of 32fee20, D1); connecting again names the store. Settings that were not saved change nothing.
      const resume = pauseLmStore();
      let saved = false;
      saveSettings(value).then(() => { saved = true; return captureStatus().then(setStatus); }).then(onSaved)
        .catch((err) => { if (!saved) resume(); setError(String(err)); });
    }}>
      <h3>Living Memory</h3>
      {field("python", "Python", "default: the Python Living Memory was installed with, else py -3 on Windows and python3 elsewhere")}
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
      {ENGINES.map(showToggle)}
      <p className="muted small">Hide the engine you don't use. Sessions you already ran with it still show it.</p>
      {claudeOn && field("claude_path", "Claude Code", "default: the installed claude command")}
      {shown.includes("codex") && field("codex_path", "Codex", "default: the codex installed with npm")}
      {field("architecture_suite_plugin", "Architecture Suite plugin folder", "only when the plugin is not installed in Claude Code")}
      {claudeOn && (
        <>
          <label className="check"><input type="checkbox" checked={value.claude_under_managed_policy ?? false}
            onChange={(e) => setValue({ ...value, claude_under_managed_policy: e.target.checked })} /> Allow Claude under managed policy</label>
          <p className="muted small">Off by default. When your organization deploys Claude Code managed settings on this computer, Hivemind does not start Claude for the executive assistant, the session reviewer or the briefing and capture calls, because the managed policy would still apply to them. Turn this on to run them anyway. Managed hooks then run in those calls, and when a managed MCP file (<code>managed-mcp.json</code>) is deployed Hivemind leaves out <code>--strict-mcp-config</code>, which Claude Code would otherwise exit on. Codex is not affected.</p>
        </>
      )}
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
      <p className="muted small">Hivemind starts {enginesText(shown, "or")} for you; {shown.length > 1 ? "each uses its own" : "it uses its"} saved sign-in.{claudeOn && <> A background task, such as generating a system's architecture, may only read the system's repositories, run Architecture Suite and write to the system's architecture folder.</>} An interactive session works in its own git worktree.{claudeOn && <> It asks before it edits files or runs commands, except where you chose “Accept edits” or your own Claude Code settings already allow the action. The spend cap per agent run (under Budgets) applies to each run of the agent; continuing a session after the cap starts a new run. The cap does not apply in the terminal{shown.includes("codex") ? " or to Codex" : ""}.</>}</p>

      <h3>Learning</h3>
      {claudeOn ? (
        <>
          <label className="check"><input type="checkbox" checked={value.learning_reviewer ?? true}
            onChange={(e) => setValue({ ...value, learning_reviewer: e.target.checked })} /> Review finished sessions for notes and skills worth keeping</label>
          <p className="muted small">When you approve or discard a chat session's edits, or a long session ends, Hivemind sends a summary of the session to Claude (Sonnet, no tools, within the limits under Budgets). Notes it proposes wait in Review and are saved only when you accept them; skills are proposed only from sessions you approved.</p>
          <label className="check"><input type="checkbox" checked={value.skills_auto_patch ?? false}
            onChange={(e) => setValue({ ...value, skills_auto_patch: e.target.checked })} /> Apply reviewer changes to a skill without asking when sessions using it were approved at least 3 times</label>
          <p className="muted small">New skills always wait for you. Every change is in the skill's history and can be undone with Restore.</p>
        </>
      ) : <p className="muted small">Learning reviews use Claude Code, which is hidden.</p>}

      <h3>Budgets</h3>
      <p className="muted small">Amounts are in US dollars. Leave a field empty for its default (shown in grey). Daily budgets start again at midnight UTC, and 0 turns that kind of spending off.</p>
      {claudeOn && money("agent_budget_usd", "Spend cap per agent run, Claude Code chat", BUDGET_DEFAULTS.agentRun, 0.01)}
      {money("automation_daily_usd", "Automations per day", BUDGET_DEFAULTS.automationsDaily)}
      <p className="muted small">Sessions and workflows that automations start. A run starts only when its own budget (set on each automation) fits in what is left today. A workflow is checked for one session's budget and can spend up to that much per task. Only Claude Code sessions are counted: Codex uses your ChatGPT plan. Follow-up messages you send to an automation's session, and tasks you retry in its workflow, count as your own spending.</p>
      {money("learning_daily_usd", "Learning and executive per day", BUDGET_DEFAULTS.learningDaily)}
      <p className="muted small">The session reviewer, the briefings and capture on Home, and the commit reviews and briefings that automations ask for.</p>
      <details>
        <summary>Per-call limits</summary>
        <p className="muted small">The most one call may spend, in whole cents. A limit above its daily budget is lowered to that budget. Empty uses the default.</p>
        {money("review_call_usd", "Session review", BUDGET_DEFAULTS.review, 0.01)}
        {EXECUTIVE_CALLS.map((call) => (
          <label key={call.id} className="field">
            <span>Executive: {call.label}</span>
            <input type="number" min="0.01" step="any" value={value.executive_call_usd?.[call.id] ?? ""} placeholder={String(call.usd)}
              onChange={(e) => setValue({ ...value, executive_call_usd: withCallLimit(value.executive_call_usd, call.id, amount(e.target.value)) })} />
          </label>
        ))}
      </details>

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
      <label className="field">
        <span>Document background</span>
        <select value={paper} onChange={(e) => applyPaperDefault(e.target.value as PaperDefault)}>
          {PAPER_DEFAULTS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </label>
      <p className="muted small">The theme and the document background change at once and are kept on this computer; they do not need Save. White shows documents as dark text on white paper while the rest of Hivemind keeps its theme. A document's page menu can switch that one tab.</p>

      <h3>Sidebar</h3>
      {sections.map((s) => (
        <label className="check" key={s.page}><input type="checkbox" checked={!hidden.includes(s.page)}
          onChange={(e) => setShown(s.page, e.target.checked)} /> Show {s.label}</label>
      ))}
      <p className="muted small">Hide the sections you don't use. You can also right-click a section in the sidebar. A hidden section still opens from links and stays open if you are on it. This changes at once and is kept on this computer; it does not need Save.</p>
      {error && <p className="error">{error}</p>}
      <button type="submit" className="primary">Save</button>
    </form>
  );
}
