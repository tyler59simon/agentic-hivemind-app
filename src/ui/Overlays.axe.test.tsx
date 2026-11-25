// @vitest-environment jsdom
// Accessibility of the dialog and the menu (DESK-A11Y A1): Modal and Confirm, and Menu open, checked with axe. The baseline
// lists what axe reports today; a later stage removes an entry when it fixes the cause.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { expectNoNewAxeViolations } from "../test/axe";
import { Menu } from "./Menu";
import { Confirm, Modal } from "./Modal";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
async function mount(node: React.ReactNode) {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(node));
}
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

/** What axe reports on these today: nothing. */
const DIALOG: string[] = [];
const MENU: string[] = [];

describe("Modal and Confirm", () => {
  it("a dialog with a field has only the violations recorded in the baseline", async () => {
    await mount(<Modal title="Rename page" onClose={() => {}}><label>Name <input defaultValue="Plan" /></label><div className="actions"><button>Cancel</button><button className="primary">Rename</button></div></Modal>);
    expect(document.querySelector('[role="dialog"][aria-modal="true"]')).not.toBeNull();
    await expectNoNewAxeViolations(document.body, DIALOG);
  });

  it("a confirmation has only the violations recorded in the baseline", async () => {
    await mount(<Confirm title="Discard unsaved changes?" danger action="Discard" message="This tab has edits that are not saved." onAnswer={() => {}} />);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await expectNoNewAxeViolations(document.body, DIALOG);
  });
});

describe("Menu", () => {
  it("open, has only the violations recorded in the baseline", async () => {
    await mount(
      <Menu label="Account and settings" buttonLabel={null} button={<><span aria-hidden>A</span><span className="grow">Ada</span><span className="visually-hidden">, account and settings</span></>}>
        {(close) => (
          <>
            <li role="none"><button role="menuitem" onClick={close}><span className="grow">Settings</span></button></li>
            <li role="none"><button role="menuitem" onClick={close}><span className="grow">Refresh</span><kbd>F5</kbd></button></li>
            <li className="menu-sep" role="none" />
            <li className="menu-note" role="none">/lm</li>
          </>
        )}
      </Menu>,
    );
    await act(async () => document.querySelector<HTMLButtonElement>(".menu-button")!.click());
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    await expectNoNewAxeViolations(document.body, MENU);
  });
});
