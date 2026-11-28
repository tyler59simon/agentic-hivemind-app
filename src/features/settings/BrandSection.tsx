// Settings > Brand: the name and logo the exported wiki shows, for the store default and for each project. Living Memory takes a
// logo as a file path and checks it, so the logo comes from a native picker and its errors (too large, not an image) are shown as is.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useBrandEnabled, useProjectsEnabled } from "../../lib/connection";
import { classify } from "../../lib/errors";
import { defaultBrand, setDefaultBrand, writeProject, type Brand, type Receipt } from "../../lib/lm";
import { recordOperation } from "../../lib/oplog";
import { pickBrandLogo } from "../../lib/wiki";
import { toast } from "../../ui/toast";
import { projectsQuery } from "../projects/useProject";

type Edit = Parameters<typeof setDefaultBrand>[0];

/** Shared by the default row and the project rows: a name field saved on blur or Enter, and the logo buttons. */
function BrandRow({ label, brand, placeholder, owner, save, resetLabel, inheritsLogo = false }: {
  label: string; brand: Brand | undefined | null; placeholder?: string; owner: string | null; inheritsLogo?: boolean;
  save: (brand: Edit) => Promise<Receipt>; resetLabel: string;
}) {
  const client = useQueryClient();
  const stored = brand?.name ?? "";
  const [name, setName] = useState(stored);
  useEffect(() => setName(stored), [stored]);
  // The buttons stay disabled until the refetch lands: a click on the old `stored` name would undo the save.
  const done = (message: string) => async (r: Receipt | null) => {
    if (!r) return;
    if (r.operation_id) recordOperation(r.operation_id);
    toast(message);
    await Promise.all([client.invalidateQueries({ queryKey: ["projects"] }), client.invalidateQueries({ queryKey: ["brand"] })]);
  };
  const onError = (e: unknown) => toast(classify(e).message, "error");
  const write = useMutation({ mutationFn: save, onSuccess: done("Brand saved."), onError });
  const pick = useMutation({ mutationFn: () => pickBrandLogo(owner, name), onSuccess: done("Logo saved."), onError });
  const busy = write.isPending || pick.isPending;
  const commit = () => {
    const next = name.trim();
    // The default brand needs a name; a project with none shows its own.
    if (next === stored || (owner === null && !next)) { setName(stored); return; }
    write.mutate(next ? { name: next } : {});
  };
  return (
    <div className="work-head wraps">
      <b>{label}</b>
      <input
        aria-label={`${label} brand name`} value={name} placeholder={placeholder} maxLength={60} disabled={busy}
        onChange={(e) => setName(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") commit(); }} />
      <span className="muted small">Logo: {brand?.logo ? "custom" : inheritsLogo ? "the default logo" : "Living Memory emblem"}</span>
      <button onClick={() => pick.mutate()} disabled={busy || (owner === null && !stored)}>Choose logo…</button>
      {brand?.logo && <button onClick={() => write.mutate({ name: stored || undefined, logo: null })} disabled={busy}>Remove logo</button>}
      {brand && <button onClick={() => write.mutate(null)} disabled={busy}>{resetLabel}</button>}
    </div>
  );
}

/** Brand in Settings, from Living Memory's `brand` capability. Nothing shows when this Living Memory has none. */
export function BrandSection() {
  const enabled = useBrandEnabled();
  const projectsOn = useProjectsEnabled();
  const stored = useQuery({ queryKey: ["brand"], queryFn: defaultBrand, enabled });
  const projects = useQuery({ ...projectsQuery(), enabled: enabled && projectsOn, retry: false });
  if (!enabled) return null;
  const live = (projects.data?.projects ?? []).filter((p) => p.status !== "archived");
  return (
    <section className="settings brand" id="settings-brand">
      <h2>Brand</h2>
      <p className="muted small">The name and logo at the top of an exported wiki. A project uses its own brand, then the default, then its project name and the Living Memory emblem. A logo is a PNG, JPEG, GIF, WebP or SVG file of at most 256 KB.</p>
      {stored.error && <p className="error">{classify(stored.error).message}</p>}
      {stored.isSuccess && (
        <BrandRow label="Default" brand={stored.data} owner={null} resetLabel="Clear" save={setDefaultBrand} />
      )}
      {/* A project with no brand of its own shows the default name; one with a brand but no name shows its project name. Both
          fall back to the default logo. */}
      {live.map((p) => (
        <BrandRow
          key={p.slug} label={p.name} brand={p.brand} placeholder={(!p.brand && stored.data?.name) || p.name} owner={p.slug} resetLabel="Use default"
          inheritsLogo={!!stored.data?.logo}
          save={(brand) => writeProject("update", { slug: p.slug, brand })} />
      ))}
    </section>
  );
}
