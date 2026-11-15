// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Claude Code runs this program as a hook; that mode opens no window.
    let args: Vec<String> = std::env::args().collect();
    if let Some(code) = agentic_hivemind_lib::hook_main(&args) {
        std::process::exit(code);
    }
    agentic_hivemind_lib::run()
}
