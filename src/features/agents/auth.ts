// The sign-in status the connection dialog shows, and which buttons go with it.
import type { AuthStatus, Engine } from "../../lib/agent";

export interface AuthView { label: string; signIn: boolean; another: boolean }

/** `status` is undefined while it loads; `failed` means the check itself failed. */
export function authView(status: AuthStatus | undefined, loading: boolean, failed: boolean): AuthView {
  if (loading) return { label: "Checking…", signIn: false, another: false };
  if (failed || !status || status.signedIn === null) return { label: "Could not check", signIn: true, another: false };
  if (status.signedIn) return { label: status.detail ? `Signed in (${status.detail})` : "Signed in", signIn: false, another: true };
  return { label: "Not signed in", signIn: true, another: false };
}

/** The confirmation before a second sign-in. Codex leaves the user signed out if its sign-in window is closed early. */
export const anotherAccountWarning = (engine: Engine): string =>
  engine === "codex"
    ? "Codex starts a new sign-in even though you are signed in. If you close Codex's sign-in window before you finish, you are signed out of your current account."
    : "Start a sign-in with another account?";
