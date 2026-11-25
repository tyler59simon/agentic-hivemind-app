//! Keyboard shortcut overrides (DESK-KEYS). The window code owns the list of shortcuts (src/lib/shortcuts.ts); Rust keeps
//! the user's changes in the settings file as an id to combo map and tells every window with `shortcuts`. It checks the
//! syntax of a combo and of an id, not which ids exist: an id the windows do not know is ignored there, and the
//! conflicts with other shortcuts are the windows' to refuse, since only they hold the list.
use crate::settings::{self, Settings};
use std::collections::BTreeMap;
use std::path::Path;
use tauri::{AppHandle, Emitter, Runtime};

/// The most overrides kept, so a bad caller cannot grow the settings file without end.
const MAX_OVERRIDES: usize = 100;
const MODIFIERS: [&str; 4] = ["Mod", "Ctrl", "Alt", "Shift"];

/// An id such as `palette.commands`: lower-case letters, digits, `.` and `-`, starting with a letter.
pub fn valid_id(id: &str) -> bool {
    let mut chars = id.chars();
    id.len() <= 40 && chars.next().is_some_and(|c| c.is_ascii_lowercase()) && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-')
}

/// Whether `key` is a function key, F1 to F12.
fn is_function_key(key: &str) -> bool {
    key.strip_prefix('F').and_then(|n| n.parse::<u8>().ok()).is_some_and(|n| (1..=12).contains(&n) && key == format!("F{n}"))
}

/// A key as combos spell it: a letter in capitals, one other printable character, a function key or a named key.
fn key_name(key: &str) -> Option<String> {
    const NAMED: [&str; 16] = ["Tab", "Enter", "Escape", "Space", "Plus", "Backspace", "Delete", "Insert", "Home", "End", "PageUp", "PageDown", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
    let mut chars = key.chars();
    match (chars.next(), chars.next()) {
        (Some(c), None) => {
            // One UTF-16 unit, as the webview reports it; no space, no `+` (that is `Plus`), no control character.
            let plain = c.len_utf16() == 1 && !c.is_whitespace() && !c.is_control() && c != '+';
            let upper: Vec<char> = c.to_uppercase().collect();
            (plain && upper.len() == 1).then(|| upper[0].to_string())
        }
        _ => (NAMED.contains(&key) || is_function_key(key)).then(|| key.to_string()),
    }
}

/// A key that is not a letter or a named key (punctuation and digits). What Shift does to it depends on the layout, so Shift
/// does not count for it, and it is folded to its unshifted name: `Plus` is `=` and `_` is `-` (the same rule as
/// src/lib/shortcuts.ts, `isLoose` and `canonKey`).
fn is_loose(key: &str) -> bool {
    let mut chars = key.chars();
    matches!((chars.next(), chars.next()), (Some(c), None) if c.to_uppercase().eq(c.to_lowercase()))
}

/// The combo in its one spelling (modifiers in the order Mod, Ctrl, Alt, Shift), or None when it is not a combo this app can
/// bind: an unknown part, a repeated modifier, or no modifier other than Shift on a key that is not a function key.
pub fn normalize(combo: &str) -> Option<String> {
    let mut parts: Vec<&str> = combo.split('+').collect();
    let key = key_name(parts.pop()?)?;
    let key = match key.as_str() {
        "Plus" => "=".to_string(),
        "_" => "-".to_string(),
        _ => key,
    };
    let mut flags = [false; 4];
    for part in parts {
        let at = MODIFIERS.iter().position(|m| *m == part)?;
        if std::mem::replace(&mut flags[at], true) {
            return None;
        }
    }
    if !(flags[0] || flags[1] || flags[2] || is_function_key(&key)) {
        return None;
    }
    if is_loose(&key) {
        flags[3] = false;
    }
    let mut out: Vec<&str> = MODIFIERS.iter().zip(flags).filter(|(_, on)| *on).map(|(m, _)| *m).collect();
    out.push(&key);
    Some(out.join("+"))
}

/// A combo as compared between two overrides: off macOS there is no separate Cmd, so Ctrl and Mod are the same key.
fn same_key(combo: &str) -> String {
    if cfg!(target_os = "macos") {
        combo.to_string()
    } else {
        combo.split('+').map(|part| if part == "Ctrl" { "Mod" } else { part }).collect::<Vec<_>>().join("+")
    }
}

/// The overrides in `saved` that are well formed: an entry with an id or combo this module would refuse reads as unset.
pub fn get(saved: &Settings) -> BTreeMap<String, String> {
    saved
        .shortcuts
        .iter()
        .flatten()
        .filter(|(id, combo)| valid_id(id) && normalize(combo).as_deref() == Some(combo.as_str()))
        .map(|(id, combo)| (id.clone(), combo.clone()))
        .take(MAX_OVERRIDES)
        .collect()
}

/// Keep `combo` for `id`, or with None go back to the default. A combo another stored override already uses is refused with
/// `taken:<id>`, naming the shortcut that holds it. Only the windows know the defaults, so they check those.
pub fn change(saved: &mut Settings, id: &str, combo: Option<&str>) -> Result<(), String> {
    if !valid_id(id) {
        return Err("Unknown shortcut.".into());
    }
    let mut all = get(saved);
    match combo {
        Some(text) => {
            let combo = normalize(text).ok_or("That is not a key combination Hivemind can use.")?;
            if let Some((holder, _)) = all.iter().find(|(other, held)| other.as_str() != id && same_key(held) == same_key(&combo)) {
                return Err(format!("taken:{holder}"));
            }
            if !all.contains_key(id) && all.len() >= MAX_OVERRIDES {
                return Err("Too many changed shortcuts.".into());
            }
            all.insert(id.to_string(), combo);
        }
        None => {
            all.remove(id);
        }
    }
    saved.shortcuts = (!all.is_empty()).then_some(all);
    Ok(())
}

/// Keep one override and tell every window with `shortcuts` (the new map). Returns the map.
pub fn set<R: Runtime>(app: &AppHandle<R>, settings_path: &Path, id: &str, combo: Option<&str>) -> Result<BTreeMap<String, String>, String> {
    let now = settings::update(settings_path, |saved| {
        change(saved, id, combo)?;
        Ok(get(saved))
    })?;
    let _ = app.emit("shortcuts", &now);
    Ok(now)
}

/// Drop every override and tell every window.
pub fn reset<R: Runtime>(app: &AppHandle<R>, settings_path: &Path) -> Result<BTreeMap<String, String>, String> {
    let now = settings::update(settings_path, |saved| {
        saved.shortcuts = None;
        Ok(get(saved))
    })?;
    let _ = app.emit("shortcuts", &now);
    Ok(now)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn combos_are_checked_and_put_in_one_spelling() {   // DESK-KEYS
        for (given, kept) in [
            ("Mod+P", "Mod+P"), ("Shift+Mod+f", "Mod+Shift+F"), ("Alt+Mod+Shift+ArrowLeft", "Mod+Alt+Shift+ArrowLeft"), ("Mod+=", "Mod+="), ("Mod+Plus", "Mod+="),
            ("Mod+Shift+Plus", "Mod+="), ("Mod+Shift+_", "Mod+-"), ("Mod+Shift+/", "Mod+/"), ("Mod+Alt+Shift+1", "Mod+Alt+1"), ("Mod+Shift+Enter", "Mod+Shift+Enter"),
            ("Mod+/", "Mod+/"), ("F5", "F5"), ("Shift+F12", "Shift+F12"), ("Ctrl+Tab", "Ctrl+Tab"), ("Alt+Space", "Alt+Space"),
        ] {
            assert_eq!(normalize(given).as_deref(), Some(kept), "{given}");
        }
        for bad in [
            "", "P", "Shift+P", "Tab", "Mod+", "Mod++", "Mod+Mod+P", "Mod+Shift+Shift+P", "Meta+P", "Mod+PP", "Mod+F13", "Mod+F0", "Mod+f1", "Mod+ ", "Mod+Esc", "Mod+arrowleft", "Mod+P+Q", "+",
            "Mod+\u{1F600}",
        ] {
            assert_eq!(normalize(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn ids_are_short_lower_case_names() {   // DESK-KEYS
        assert!(valid_id("palette.commands") && valid_id("tab.next") && valid_id("a"));
        for bad in ["", "Palette", "1a", ".a", "a b", "a_b", &"a".repeat(41)] {
            assert!(!valid_id(bad), "{bad:?}");
        }
    }

    #[test]
    fn a_change_is_kept_dropped_or_refused_and_the_map_round_trips() {   // DESK-KEYS
        let mut saved = Settings::default();
        change(&mut saved, "palette.commands", Some("Mod+Shift+P")).unwrap();
        change(&mut saved, "zoom.in", Some("Shift+Mod+Plus")).unwrap();
        assert_eq!(
            get(&saved),
            BTreeMap::from([("palette.commands".to_string(), "Mod+Shift+P".to_string()), ("zoom.in".to_string(), "Mod+=".to_string())])
        );
        let before = saved.clone();
        assert!(change(&mut saved, "palette.commands", Some("P")).is_err());
        assert!(change(&mut saved, "Bad Id", Some("Mod+P")).is_err());
        assert!(change(&mut saved, "Bad Id", None).is_err());
        assert_eq!(saved, before);
        // The file text keeps the map, and a file from before the field still loads.
        let text = serde_json::to_string(&saved).unwrap();
        let back: Settings = serde_json::from_str(&text).unwrap();
        assert_eq!(get(&back), get(&saved));
        let old: Settings = serde_json::from_str(r#"{"python": "py"}"#).unwrap();
        assert_eq!((old.python.as_deref(), get(&old).len()), (Some("py"), 0));
        change(&mut saved, "palette.commands", None).unwrap();
        change(&mut saved, "zoom.in", None).unwrap();
        assert_eq!(saved.shortcuts, None);
    }

    #[test]
    fn bad_entries_in_the_file_read_as_unset() {   // DESK-KEYS
        // An entry of the wrong type is dropped on its own; the good ones and the rest of the file still load.
        let typed: Settings = serde_json::from_str(r#"{"python": "py", "shortcuts": {"note.new": "Mod+J", "a": 3, "b": null, "c": ["Mod+K"]}}"#).unwrap();
        assert_eq!((typed.python.as_deref(), get(&typed)), (Some("py"), BTreeMap::from([("note.new".to_string(), "Mod+J".to_string())])));
        let file: Settings = serde_json::from_str(r#"{"shortcuts": {"note.new": "Mod+J", "zoom.in": "J", "Bad": "Mod+K", "tab.close": "mod+w"}}"#).unwrap();
        assert_eq!(get(&file), BTreeMap::from([("note.new".to_string(), "Mod+J".to_string())]));
        let wrong: Settings = serde_json::from_str(r#"{"python": "py", "shortcuts": ["Mod+J"]}"#).unwrap();
        assert_eq!((wrong.python.as_deref(), get(&wrong).len()), (Some("py"), 0));
    }

    #[test]
    fn a_combo_another_override_holds_is_refused_naming_it() {   // DESK-KEYS O2
        let mut saved = Settings::default();
        change(&mut saved, "note.new", Some("Mod+J")).unwrap();
        // The same key by another spelling is the same combo.
        assert_eq!(change(&mut saved, "graph.open", Some("Mod+J")), Err("taken:note.new".to_string()));
        assert_eq!(change(&mut saved, "zoom.in", Some("Shift+Mod+Plus")), Ok(()));
        assert_eq!(change(&mut saved, "zoom.out", Some("Mod+Shift+Plus")), Err("taken:zoom.in".to_string()));
        assert_eq!(get(&saved).len(), 2);
        // Its own combo again is not a clash.
        change(&mut saved, "note.new", Some("Mod+J")).unwrap();
        // A freed combo can be taken.
        change(&mut saved, "note.new", None).unwrap();
        change(&mut saved, "graph.open", Some("Mod+J")).unwrap();
    }

    #[test]
    fn no_more_than_the_limit_is_kept() {   // DESK-KEYS
        let mut saved = Settings::default();
        let combo = |n: usize| format!("{}+{}", ["Mod", "Mod+Alt", "Mod+Shift", "Mod+Alt+Shift"][n / 26], (b'A' + (n % 26) as u8) as char);
        for n in 0..MAX_OVERRIDES {
            change(&mut saved, &format!("a{n}"), Some(&combo(n))).unwrap();
        }
        assert!(change(&mut saved, "extra", Some("Mod+Alt+Shift+Z")).is_err());
        change(&mut saved, "a0", Some("Mod+Alt+Shift+Z")).unwrap();
        assert_eq!(get(&saved).len(), MAX_OVERRIDES);
    }
}
