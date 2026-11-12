import { describe, expect, it } from "vitest";
import type { ArchModel, Diagram } from "../../lib/architecture";
import type { NoteRow, System } from "../../lib/lm";
import { buildBrief } from "./brief";
import { cloudResources, diagramList, externalSystems, interfaces, levelLabel, passportSections, proposalOf, proposedUpdate, techStack } from "./passport";
import { changedSystem, formOf, parseFolder, parseList, passportBody, validateSystem, type SystemForm } from "./wizard";

const system = (o: Partial<System> = {}): System => ({
  slug: "billing", name: "Billing", status: "active", description: "Takes payments.", owners: ["Payments team"],
  capabilities: ["Take payments"], repos: ["C:/code/billing"], depends_on: ["ledger"], architecture: "C:/arch/billing",
  passport: "d:pass", created: "2026-01-01", updated: "2026-01-01", tag: "system/billing", tag_registered: true, dependents: [], ...o,
});
const row = (o: Partial<NoteRow> & { ref: string }): NoteRow => ({
  id: o.ref.split(":")[1] ?? "x", domain: "d", title: o.ref, type: "knowledge", status: "active", tags: ["system/billing"],
  created: "2026-01-01", updated: "2026-01-01", revision: "r", path: "", ...o,
});
const form = (o: Partial<SystemForm> = {}): SystemForm => ({ ...formOf(system()), ...o });

describe("wizard", () => {
  it("parses lists and folders", () => {
    expect(parseList(" Payments , platform,payments ,", "comma")).toEqual(["Payments", "platform"]);
    expect(parseList("Take payments\n\n Issue invoices \r\ntake payments", "line")).toEqual(["Take payments", "Issue invoices"]);
    expect(parseFolder(" C:\\arch\\billing\\ ")).toBe("C:/arch/billing");
    expect(parseFolder("  ")).toBeNull();
  });

  it("builds the passport note body in LM's layout", () => {
    expect(passportBody({ purpose: " Takes payments. " })).toBe("Takes payments.");
    const body = passportBody({ purpose: "P", boundaries: "API and ledger\nnot the bank", guidance: "Ask before migrations" });
    expect(body).toBe("P\n\n## Details\n- **Boundaries:** API and ledger; not the bank\n- **Agent guidance:** Ask before migrations");
    expect(body).not.toContain("Operations");
  });

  it("validates what LM would refuse", () => {
    expect(validateSystem(form(), { slug: "billing-2", existingSlugs: ["billing"] })).toEqual([]);
    const problems = validateSystem(form({ name: " ", purpose: "", repos: "relative/path", owners: Array(11).fill(0).map((_, i) => `o${i}`).join(","), architecture: "arch" }),
      { slug: "billing", existingSlugs: ["billing"] });
    expect(problems.join("\n")).toMatch(/name/);
    expect(problems.join("\n")).toMatch(/already exists/);
    expect(problems.join("\n")).toMatch(/purpose of the system/);
    expect(problems.join("\n")).toMatch(/must be absolute: relative\/path/);
    expect(problems.join("\n")).toMatch(/At most 10 owners/);
    expect(problems.join("\n")).toMatch(/architecture folder must be an absolute path/);
    // A system you do not own needs no repositories; an edit needs no slug or purpose check.
    expect(validateSystem(form({ repos: "", purpose: "" }))).toEqual([]);
  });

  it("keeps the architecture folder outside the repositories", () => {
    expect(validateSystem(form({ architecture: "C:/code/billing/docs/arch" })).join()).toMatch(/outside the repositories/);
    expect(validateSystem(form({ architecture: "c:\\CODE\\billing" })).join()).toMatch(/outside the repositories/);
    expect(validateSystem(form({ architecture: "C:/code/billing-arch" }))).toEqual([]);
  });

  it("sends only what changed", () => {
    expect(changedSystem(system(), form())).toBeNull();
    expect(changedSystem(system(), form({ owners: "Payments team, Platform", status: "deprecated", architecture: "" })))
      .toEqual({ slug: "billing", owners: ["Payments team", "Platform"], status: "deprecated", architecture: null });
    expect(changedSystem(system({ depends_on: ["a", "b"] }), form({ dependsOn: ["b", "a"] }))).toBeNull();
    expect(changedSystem(system(), form({ dependsOn: [] }))).toEqual({ slug: "billing", depends_on: [] });
  });
});

describe("passportSections", () => {
  const rows = [
    row({ ref: "d:pass", type: "context" }),
    row({ ref: "d:run1", type: "runbook", updated: "2026-02-01" }), row({ ref: "d:run2", type: "runbook", updated: "2026-03-01" }),
    row({ ref: "d:dec1", type: "decision", created: "2026-01-05" }), row({ ref: "d:dec2", type: "decision", created: "2026-02-05" }),
    row({ ref: "d:dec3", type: "decision", status: "superseded" }),
    row({ ref: "d:bug", type: "bug" }), row({ ref: "d:fixed", type: "bug", status: "resolved" }), row({ ref: "d:risk", type: "risk", updated: "2026-05-01" }),
    row({ ref: "d:know", type: "knowledge" }),
  ];
  it("groups a system's notes", () => {
    const s = passportSections(rows, "d:pass");
    expect(s.passport?.ref).toBe("d:pass");
    expect(s.runbooks.map((r) => r.ref)).toEqual(["d:run2", "d:run1"]);
    expect(s.decisions.map((r) => r.ref)).toEqual(["d:dec2", "d:dec1"]);
    expect(s.weaknesses.map((r) => r.ref)).toEqual(["d:risk", "d:bug", "d:fixed"]);
    expect(s.retired.map((r) => r.ref)).toEqual(["d:dec3"]);
  });
});

const model: ArchModel = {
  elements: [
    { id: "sys", name: "Billing", type: "software_system" },
    { id: "api", name: "Billing API", type: "container", technology: "Python", parent_id: "sys" },
    { id: "worker", name: "Worker", type: "container", technology: "Python", parent_id: "sys" },
    { id: "db", name: "Ledger DB", type: "container", technology: "PostgreSQL", parent_id: "sys", cloud: { provider: "gcp", service: "Cloud SQL" } },
    { id: "bare", name: "Scripts", type: "container", parent_id: "sys" },
    { id: "stripe", name: "Stripe", type: "software_system", external: true, description: "Card processor" },
    { id: "shop", name: "Shop", type: "software_system", external: true },
    { id: "clerk", name: "Finance clerk", type: "person" },
  ],
  relationships: [
    { id: "r1", source_id: "api", destination_id: "stripe", description: "Charges cards", technology: "HTTPS" },
    { id: "r2", source_id: "shop", destination_id: "api", description: "Creates invoices", technology: "REST" },
    { id: "r3", source_id: "api", destination_id: "db", description: "Reads and writes" },
    { id: "r4", source_id: "clerk", destination_id: "api" },
    { id: "r5", source_id: "api", destination_id: "missing" },
  ],
  views: [{ id: "containers", type: "container", title: "Billing — Container" }],
};

describe("architecture readers", () => {
  it("lists the technology stack of the system's own containers", () => {
    expect(techStack(model)).toEqual([{ technology: "Python", elements: ["Billing API", "Worker"] }, { technology: "PostgreSQL", elements: ["Ledger DB"] }]);
    expect(techStack(null)).toEqual([]);
  });

  it("classifies external systems by direction", () => {
    expect(externalSystems(model)).toEqual([
      { name: "Finance clerk", description: "", kind: "person", uses: false, usedBy: true },
      { name: "Shop", description: "", kind: "system", uses: false, usedBy: true },
      { name: "Stripe", description: "Card processor", kind: "system", uses: true, usedBy: false },
    ]);
  });

  it("finds boundary-crossing flows and declared routes", () => {
    const io = interfaces(model, { routes: [{ path: "/invoices", reference: "api/app.py", line: 12 }, { path: "/invoices", reference: "api/app.py", line: 12 }, { path: "/health" }] });
    expect(io.flows.map((f) => [f.direction, f.from, f.to, f.technology])).toEqual([
      ["out", "Billing API", "Stripe", "HTTPS"], ["in", "Shop", "Billing API", "REST"], ["in", "Finance clerk", "Billing API", ""],
    ]);
    expect(io.routes).toEqual([{ path: "/health", reference: "", line: undefined }, { path: "/invoices", reference: "api/app.py", line: 12 }]);
    expect(interfaces(null, null)).toEqual({ flows: [], routes: [] });
  });

  it("collects cloud services and imported resources", () => {
    const found = cloudResources(model, { resources: [{ id: "web", type: "kubernetes/Deployment" }, { id: "jobs", type: "kubernetes/Deployment" }, { id: "db", type: "google_sql_database_instance" }] });
    expect(found.elements).toEqual([{ name: "Ledger DB", provider: "gcp", service: "Cloud SQL", description: "" }]);
    expect(found.resources).toEqual([{ type: "google_sql_database_instance", count: 1, ids: ["db"] }, { type: "kubernetes/Deployment", count: 2, ids: ["web", "jobs"] }]);
  });

  it("lists one entry per diagram, preferring SVG and titling from the model", () => {
    const files: Diagram[] = [
      { path: "02-containers/containers.png", level: "02-containers", format: "png" },
      { path: "02-containers/containers.svg", level: "02-containers", format: "svg" },
      { path: "01-system-context/system-context.png", level: "01-system-context", format: "png" },
      { path: "../outside.svg", level: "..", format: "svg" },
    ];
    expect(diagramList(files, model)).toEqual([
      { key: "01-system-context/system-context", path: "01-system-context/system-context.png", format: "png", title: "system context", level: "System context" },
      { key: "02-containers/containers", path: "02-containers/containers.svg", format: "svg", title: "Billing — Container", level: "Containers" },
    ]);
    expect(levelLabel("")).toBe("Other");
  });
});

describe("proposedUpdate", () => {
  const known = ["billing", "ledger", "shop"];
  it("keeps only valid fields that differ from the registry", () => {
    const proposal = proposalOf({ summary: "s", registry: { description: " Takes payments and issues invoices. ", capabilities: ["Take payments"], owners: [], depends_on: ["ledger", "shop", "ghost", "billing"] } });
    expect(proposedUpdate(system(), proposal, known)).toEqual({ slug: "billing", description: "Takes payments and issues invoices.", depends_on: ["ledger", "shop"] });
  });
  it("is null when nothing would change or nothing was proposed", () => {
    expect(proposedUpdate(system(), proposalOf({ registry: { description: "Takes payments.", depends_on: ["ledger"] } }), known)).toBeNull();
    expect(proposedUpdate(system(), proposalOf({ registry: { description: "x".repeat(501), capabilities: "many" } }), known)).toBeNull();
    expect(proposalOf({ summary: "no registry" })).toBeNull();
    expect(proposalOf(null)).toBeNull();
  });
});

describe("buildBrief", () => {
  const text = buildBrief(system(), [system(), system({ slug: "ledger", name: "Ledger" })]);
  it("names the system, its folders and the systems it may depend on", () => {
    expect(text).toContain('the system "Billing"');
    expect(text).toContain("- C:/code/billing");
    expect(text).toContain("--output C:/arch/billing --level all");
    expect(text).toContain("--output C:/arch/billing/inventory");
    expect(text).toContain("- `ledger` (Ledger)");
    expect(text).not.toContain("- `billing` (Billing)");
    expect(text).toContain("--system billing");
  });
  it("tells the agent it is unattended and what it must not do", () => {
    expect(text).toMatch(/never ask/);
    expect(text).toMatch(/Do not run `system-plan`, `apply`/);
    expect(text).toMatch(/Write files only inside the architecture folder/);
  });
});
