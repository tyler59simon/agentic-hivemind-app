// What to tell the user when meaning search cannot do its job (NS-4B): the Living Memory model is not installed, is still
// being read into the index, or cannot be read. Hivemind never installs the model; Living Memory does, from a terminal.
import type { MeaningState } from "../../lib/noteindex";
import { toast } from "../../ui/toast";

export const INSTALL_COMMAND = "alm semantic install";

const copy = () => navigator.clipboard.writeText(INSTALL_COMMAND).then(() => toast("Command copied"), () => toast(INSTALL_COMMAND));

/** One line under the search box or in the rail; nothing when meaning search is working. */
export function SemanticHint({ state }: { state: MeaningState }) {
  if (state === "building") return <p className="muted small pad">Meaning search is still reading your pages, so it finds only some of them.</p>;
  if (state !== "missing" && state !== "error") return null;
  return (
    <p className="muted small pad semantic-hint">
      {state === "missing" ? "Semantic search needs the Living Memory model. Run " : "Semantic search cannot read the Living Memory model. Run "}
      <code>{INSTALL_COMMAND}</code>{state === "missing" ? "." : " again."}{" "}
      <button type="button" className="link small" onClick={() => void copy()}>Copy command</button>
    </p>
  );
}
