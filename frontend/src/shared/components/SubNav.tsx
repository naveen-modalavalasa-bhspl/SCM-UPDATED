import type { ComponentType } from "react";
import { NavLink } from "react-router-dom";

/**
 * The sub-navigation strip that sits under a module's page header.
 *
 * Three modules had grown three different versions of this — pills in Material
 * Requests, underlined HeroUI tabs in Warehouse, rounded bordered tabs in
 * Inventory — so moving between modules felt like moving between apps. This is the
 * one shared strip; the pill treatment is the one from Indents.
 *
 * It drives either routes or local state, because both patterns already exist:
 *
 *   <SubNav label="Inventory" items={[{ key: "balance", label: "Stock balance",
 *                                       icon: Boxes }]}
 *           value={tab} onChange={setTab} />
 *
 *   <SubNav label="Indents"
 *           items={[{ key: "/indents", label: "All requests", icon: List, end: true }]} />
 */
export interface SubNavItem {
  /** A path when the strip navigates, or any id when it switches local state. */
  key: string;
  label: string;
  icon?: ComponentType<{ className?: string }>;
  /** A small count pill beside the label — e.g. row counts on a register tab. */
  count?: number;
  /** Route mode only: match this path exactly, so "/indents" ignores "/indents/board". */
  end?: boolean;
}

interface Props {
  items: SubNavItem[];
  /** Names the strip for screen readers, e.g. "Inventory". */
  label: string;
  /** Provide both to switch local state. Omit both to navigate to item.key. */
  value?: string;
  onChange?: (key: string) => void;
  /** Drop the surrounding card when the strip already sits inside one. */
  bare?: boolean;
  className?: string;
}

// One definition, so the routed and the stateful strip cannot drift apart.
const ITEM =
  "inline-flex min-h-11 shrink-0 items-center gap-2 rounded-lg px-3 text-sm " +
  "font-semibold transition-colors focus-visible:outline-none " +
  "focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1";
const ON = "bg-brand text-white";
const OFF = "text-muted hover:bg-content2 hover:text-body";

function CountPill({ count, active }: { count?: number; active: boolean }) {
  if (count === undefined) return null;
  return (
    <span className={`ml-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular ${
      active ? "bg-white/20 text-white" : "bg-surface text-muted"
    }`}>
      {count}
    </span>
  );
}

export function SubNav({
  items, label, value, onChange, bare = false, className = "",
}: Props) {
  const stateful = onChange !== undefined;

  return (
    <nav aria-label={label}
         className={`${bare ? "" : "mb-5"} overflow-x-auto ${className}`}>
      <div className={`flex min-w-max gap-1 p-1 ${
        bare ? "" : "rounded-xl border border-line bg-content1"
      }`}>
        {items.map(({ key, label: text, icon: Icon, count, end }) => {
          const active = stateful ? value === key : undefined;
          return stateful ? (
            <button
              key={key}
              type="button"
              // aria-current, not just colour: the active tab has to be announced,
              // and colour alone fails anyone who cannot see it.
              aria-current={active ? "page" : undefined}
              onClick={() => onChange!(key)}
              className={`${ITEM} ${active ? ON : OFF}`}
            >
              {Icon && <Icon className="h-4 w-4" />}
              {text}
              <CountPill count={count} active={active ?? false} />
            </button>
          ) : (
            <NavLink
              key={key}
              to={key}
              end={end}
              className={({ isActive }) => `${ITEM} ${isActive ? ON : OFF}`}
            >
              {({ isActive }) => (
                <>
                  {Icon && <Icon className="h-4 w-4" />}
                  {text}
                  <CountPill count={count} active={isActive} />
                </>
              )}
            </NavLink>
          );
        })}
      </div>
    </nav>
  );
}
