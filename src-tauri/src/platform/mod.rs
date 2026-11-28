//! Native services behind one trait each, with an implementation per platform (Hivemind Document OS decision,
//! 2026-11-25): Windows 11 and macOS are first-class, other systems get a plain "not supported" error.
pub mod print;
