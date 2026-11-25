import { Component, type ErrorInfo, type ReactNode } from "react";
import { cap, logErrorLine } from "../lib/log";

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

interface State { error: Error | null; stack: string; copied: boolean; key: unknown }

/** Catches a render error below it, so one broken view shows a message instead of blanking the window (DESK-1). */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: "", copied: false, key: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error, copied: false };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey === state.key) return null;
    return { key: props.resetKey, error: null, stack: "", copied: false };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ stack: info.componentStack ?? "" });
    console.error(error);
    logErrorLine([`${this.props.label} stopped: ${error.name}: ${cap(error.message, 300)}`, error.stack ?? "", `Component stack:${info.componentStack ?? ""}`].filter(Boolean).join("\n"));
    try { this.props.onError?.(error); } catch { /* the fallback still shows */ }
  }

  private details(): string {
    const e = this.state.error;
    return [`${e?.name ?? "Error"}: ${e?.message ?? ""}`, e?.stack ?? "", this.state.stack.trim()].filter(Boolean).join("\n\n");
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
        <p className="error">{error.message || String(error)}</p>
        <div className="actions">
          <button onClick={this.copy}>{copied ? "Copied" : "Copy details"}</button>
          <button className="primary" onClick={retry.run}>{retry.label}</button>
        </div>
      </div>
    );
  }
}
