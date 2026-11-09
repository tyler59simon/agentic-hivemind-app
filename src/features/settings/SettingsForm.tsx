import { useEffect, useState } from "react";
import { getSettings, saveSettings, type Settings } from "../../lib/lm";

/** Where Hivemind finds Python, living_memory.py and (optionally) the store. Blank means default. */
export function SettingsForm({ onSaved }: { onSaved: () => void }) {
  const [value, setValue] = useState<Settings>({ python: null, script: null, root: null });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { getSettings().then(setValue).catch((e) => setError(String(e))); }, []);
  const field = (key: keyof Settings, label: string, hint: string) => (
    <label className="field">
      <span>{label}</span>
      <input value={value[key] ?? ""} placeholder={hint}
        onChange={(e) => setValue({ ...value, [key]: e.target.value || null })} />
    </label>
  );
  return (
    <form className="settings" onSubmit={(e) => {
      e.preventDefault();
      saveSettings(value).then(onSaved).catch((err) => setError(String(err)));
    }}>
      {field("python", "Python", "default: py -3 on Windows, python3 elsewhere")}
      {field("script", "living_memory.py", "default: the installed Living Memory copy")}
      {field("root", "Store root", "default: the store Living Memory is configured for")}
      <p className="muted">Environment variables HIVEMIND_PYTHON, HIVEMIND_LM_SCRIPT and HIVEMIND_LM_ROOT override these.</p>
      {error && <p className="error">{error}</p>}
      <button type="submit">Save and reconnect</button>
    </form>
  );
}
