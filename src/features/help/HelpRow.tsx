// Help for the screen that shows when Living Memory is not connected (DESK-HELP): the menu and palette are not there, but
// a problem report matters most then. Nothing here needs Living Memory.
import { copyDiagnostics, openLogsFolder, reportProblem } from "../../lib/diagnostics";
import { useAboutDialog } from "./AboutDialog";

export function HelpRow() {
  return (
    <section className="help-row" aria-label="Help">
      <h3>Help</h3>
      <div className="actions">
        <button type="button" onClick={(e) => useAboutDialog.getState().show(e.currentTarget)}>About Hivemind</button>
        <button type="button" onClick={() => void copyDiagnostics()}>Copy diagnostics</button>
        <button type="button" onClick={() => void openLogsFolder()}>Open logs folder</button>
        <button type="button" onClick={() => void reportProblem()}>Report a problem</button>
      </div>
    </section>
  );
}
