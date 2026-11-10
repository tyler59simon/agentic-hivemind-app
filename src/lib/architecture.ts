// A system's Architecture Suite output folder. Rust looks the folder up in Living Memory and reads it;
// the webview only passes the system slug and, for a diagram, a path the folder's manifest lists.
import { invoke } from "@tauri-apps/api/core";

export interface ArchElement {
  id: string; name: string; type: "person" | "software_system" | "container" | "component" | "code";
  description?: string; technology?: string; parent_id?: string; external?: boolean; status?: string;
  cloud?: { provider: string; service: string };
}
export interface ArchRelationship { id: string; source_id: string; destination_id: string; description?: string; technology?: string }
/** A drawn view: which elements and relationships it shows, and the element whose inside it opens up. */
export interface ArchView { id: string; type: string; title: string; element_ids?: string[]; relationship_ids?: string[]; boundary_id?: string }
export interface ArchModel {
  system?: { name?: string; description?: string };
  elements?: ArchElement[]; relationships?: ArchRelationship[]; views?: ArchView[];
  gaps?: string[]; assumptions?: string[];
}
export interface Inventory { routes?: { path: string; reference?: string; line?: number }[] }
export interface Topology { resources?: { id: string; type: string; evidence?: { reference?: string } }[] }

export interface Diagram { path: string; level: string; format: "svg" | "png" }
export interface Architecture {
  folder: string | null;
  /** When the model was last written, in milliseconds since the epoch. */
  generatedAt: number | null;
  toolVersion: string | null;
  model: ArchModel | null;
  inventory: Inventory | null;
  topology: Topology | null;
  diagrams: Diagram[];
  /** Why there is nothing to show (no folder set, folder missing, nothing generated yet). */
  error: string | null;
}

export const systemArchitecture = (slug: string) => invoke<Architecture>("system_architecture", { slug });
/** One listed diagram as a data URL. */
export const systemDiagram = (slug: string, path: string) => invoke<string>("system_diagram", { slug, path });
/** The Mermaid source the suite wrote beside a diagram (`path` ends in .mmd), as text. */
export const systemDiagramSource = (slug: string, path: string) => invoke<string>("system_diagram_source", { slug, path });
