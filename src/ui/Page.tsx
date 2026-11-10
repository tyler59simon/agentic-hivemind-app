// The parts every page is built from: a header, a main column with a context rail, flat sections, tabs and link rows.
import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";
import { classify } from "../lib/errors";

/** "Monday, Nov 9, 2026" */
export const longDate = (d = new Date()) =>
  d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric", year: "numeric" });
/** "Nov 9" (with the year when it is not this one). */
export function dayMonth(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }) });
}

export function PageHeader({ eyebrow, title, subtitle, meta, actions }: {
  eyebrow?: ReactNode; title: ReactNode; subtitle?: ReactNode; meta?: ReactNode; actions?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div className="page-title">
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {subtitle && <p className="page-sub">{subtitle}</p>}
        {meta && <div className="page-meta">{meta}</div>}
      </div>
      <div className="page-actions">
        <span className="page-date">{longDate()}</span>
        {actions}
      </div>
    </header>
  );
}

/** A main column with a context rail on the right, split by a divider. */
export function Split({ children, rail, wide }: { children: ReactNode; rail: ReactNode; wide?: boolean }) {
  return (
    <div className={`split ${wide ? "wide-rail" : ""}`}>
      <div className="split-main">{children}</div>
      <aside className="split-rail">{rail}</aside>
    </div>
  );
}

/** A titled block that shows its own loading, error and empty state. */
export function Section({ title, count, actions, loading, error, empty, className = "", children }: {
  title?: ReactNode; count?: number; actions?: ReactNode; className?: string;
  loading?: boolean; error?: unknown; empty?: string; children?: ReactNode;
}) {
  return (
    <section className={`section ${className}`}>
      {(title || actions) && (
        <header className="section-head">
          {title && <h2>{title}</h2>}
          {count !== undefined && <span className="muted">{count}</span>}
          <span className="fill" />
          {actions}
        </header>
      )}
      {loading ? <p className="muted">Loading…</p>
        : error ? <p className="error">{classify(error).message}</p>
        : empty ? <p className="muted">{empty}</p>
        : children}
    </section>
  );
}

export interface TabItem<T extends string> { id: T; label: string; count?: number }

/** Underlined tabs (or filled pills) with optional counts. */
export function Tabs<T extends string>({ items, value, onChange, pill, label }: {
  items: TabItem<T>[]; value: T; onChange: (id: T) => void; pill?: boolean; label?: string;
}) {
  return (
    <div className={pill ? "pill-tabs" : "line-tabs"} role="tablist" aria-label={label}>
      {items.map((t) => (
        <button key={t.id} role="tab" aria-selected={t.id === value} className={t.id === value ? "on" : ""} onClick={() => onChange(t.id)}>
          {t.label}{t.count !== undefined && <span className="tab-count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** A text link that ends in an arrow: "Open diagram →". */
export function ArrowLink({ children, onClick, title }: { children: ReactNode; onClick: () => void; title?: string }) {
  return <button className="arrow-link" onClick={onClick} title={title}>{children}<ArrowRight size="1.1em" aria-hidden /></button>;
}

/** A rail or list row: icon, label, optional note on the right, and an arrow when it leads somewhere. */
export function Row({ icon, children, meta, onClick, title }: {
  icon?: ReactNode; children: ReactNode; meta?: ReactNode; onClick?: (e: React.MouseEvent) => void; title?: string;
}) {
  const inner = (
    <>
      {icon && <span className="row-icon">{icon}</span>}
      <span className="row-label">{children}</span>
      {meta && <span className="row-meta">{meta}</span>}
      {onClick && <ArrowRight className="row-arrow" size="1.1em" aria-hidden />}
    </>
  );
  return onClick
    ? <button className="arrow-row" onClick={onClick} title={title}>{inner}</button>
    : <div className="arrow-row" title={title}>{inner}</div>;
}
