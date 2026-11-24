// Whether this page runs inside the Tauri app. Tests and a plain browser have no window to tell. The check reads the
// global Tauri sets itself, so modules that mock @tauri-apps/api/core in tests do not need to mock it too.
export const inTauri = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
