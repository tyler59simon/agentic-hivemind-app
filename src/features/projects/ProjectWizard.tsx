import type { Project } from "../../lib/lm";

export interface ProjectWizardProps {
  /** "create" makes a project (registry entry, project/<slug> tag and charter note in one plan); "edit" updates the registry entry. */
  mode: "create" | "edit";
  /** The project being edited (mode "edit"). */
  project?: Project;
  onClose: () => void;
  /** Called after the plan was applied, with the project's slug. */
  onDone?: (slug: string) => void;
}

/** Placeholder; the create/edit slice replaces the body. */
export function ProjectWizard({ onClose }: ProjectWizardProps) {
  void onClose;
  return null;
}
