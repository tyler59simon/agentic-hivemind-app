import { ArrowRight, Box } from "lucide-react";
import { Fragment } from "react";
import type { ArchModel } from "../../lib/architecture";
import { chain } from "./diagram";

/** A system's containers as a row of boxes, in the order data flows; `selected` highlights one by name. */
export function MiniDiagram({ model, selected }: { model: ArchModel | null; selected?: string }) {
  const { nodes, linked } = chain(model);
  if (!nodes.length) return null;
  return (
    <div className="mini-diagram" role="img" aria-label={`Containers: ${nodes.map((n) => n.name).join(", ")}`}>
      {nodes.map((n, i) => (
        <Fragment key={n.id}>
          {i > 0 && <ArrowRight className={linked[i - 1] ? "" : "faint"} size="1.3em" aria-hidden />}
          <div className={`mini-node ${n.name === selected ? "on" : ""}`} title={n.description || n.name}>
            <Box size="1.5em" aria-hidden /><span>{n.name}</span>
          </div>
        </Fragment>
      ))}
    </div>
  );
}
