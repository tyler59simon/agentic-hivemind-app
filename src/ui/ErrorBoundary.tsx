import { Component, type ErrorInfo, type ReactNode } from "react";
import { logRenderError } from "../lib/log";

interface Props {
  /** What failed, for the message: "This page", "This tab", "Hivemind". */
  label: string;
  /** A change of this value (a new page or tab) clears the error and draws the children again. */
  resetKey?: unknown;
  /** Runs once per caught error, e.g. to write unsaved drafts before anything else goes wrong. */
  onError?: (error: Error) => void;
  /** Replaces Try again, for the outermost boundary where only a reload helps. */
  retry?: { label: string; run: () => void };
  /** The line under the heading; the default says the rest of the window keeps working. */
  hint?: string;
  children: ReactNode;
}

/** What a boundary kept of the thrown value. It is an object whatever was thrown, so null, undefined and false still show
 *  the fallback. `text` is the line the fallback shows, `detail` what Copy details copies. */
interface Failure { failed: true; text: string; detail: string }
interface State { error: Failure | null; stack: string; copied: boolean; key: unknown }

const UNSHOWN = "An error that cannot be shown";

/** `String(value)` for anything, including a value with no toString or one whose toString throws. */
function safeText(value: unknown): string {
  try { return String(value); } catch { return UNSHOWN; }
}

function failureOf(value: unknown): Failure {
  try {
    if (value instanceof Error) {
      let text: string;
      try { text = safeText(value.message) || safeText(value); } catch { text = safeText(value); }
      // Copy details is read on its own, so a name or stack getter that throws cannot replace the message shown.
      let detail: string;
      try { detail = [`${safeText(value.name)}: ${text}`, safeText(value.stack ?? "")].filter(Boolean).join("\n\n"); } catch { detail = text; }
      return { failed: true, text, detail };
    }
    const text = safeText(value);
    return { failed: true, text, detail: text };
  } catch {
    return { failed: true, text: UNSHOWN, detail: UNSHOWN };
  }
}

/** Catches a render error below it, so one broken view shows a message instead of blanking the window (DESK-1). */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: "", copied: false, key: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: failureOf(error), copied: false };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey === state.key) return null;
    return { key: props.resetKey, error: null, stack: "", copied: false };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ stack: info.componentStack ?? "" });
    try { console.error(error); } catch { /* the rest still runs */ }
    try { this.props.onError?.(error); } catch { /* the fallback still shows */ }
    // After the recovery callback, so a failure to log can never hold it back. Only names and source locations are sent.
    try { logRenderError(error, info.componentStack); } catch { /* nothing is logged */ }
  }

  private details(): string {
    return [this.state.error?.detail ?? "", this.state.stack.trim()].filter(Boolean).join("\n\n");
  }

  private copy = () => {
    navigator.clipboard.writeText(this.details()).then(() => this.setState({ copied: true }), () => undefined);
  };

  render(): ReactNode {
    const { error, copied } = this.state;
    if (!error) return this.props.children;
    const retry = this.props.retry ?? { label: "Try again", run: () => this.setState({ error: null, stack: "", copied: false }) };
    return (
      <div className="error-boundary" role="alert">
        <h2>{this.props.label} stopped working</h2>
        <p className="muted">{this.props.hint ?? "Your unsaved edits are kept as drafts, and the rest of Hivemind keeps working."}</p>
        <p className="error">{error.text}</p>
        <div className="actions">
          <button onClick={this.copy}>{copied ? "Copied" : "Copy details"}</button>
          <button className="primary" onClick={retry.run}>{retry.label}</button>
        </div>
      </div>
    );
  }
}
