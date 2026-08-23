import type { ReactNode } from "react";
import { LayoutGroup, motion, useReducedMotion } from "framer-motion";
import { NavLink } from "react-router-dom";

/**
 * THE module tab strip. Every module's sub-navigation is this component.
 *
 * There used to be two: indents drew its own (it needed grant filtering and the
 * `was` paths for screens that had been renamed) and every other module got a
 * HeroUI `<Tabs>`. Same row, same job, and they disagreed on nearly everything
 * around the label — HeroUI underlines 2px across 80% of a tab where this one
 * draws 3px across all of it, spaces items 16px not 20px, and colours them from
 * ITS palette rather than our tokens, which is a different blue in dark mode.
 * Matching the two by hand held for exactly as long as nobody touched either.
 *
 * So there is one strip now and the callers differ only in what they FEED it:
 * indents passes its own destination list, everyone else passes the children of
 * their menu root. Anything visual belongs here and nowhere else.
 */
export interface ModuleTab {
  /** Route to navigate to. Also the strip's key. */
  path: string;
  label: string;
  icon: ReactNode;
  /** Exact-match this route — for a parent path that would otherwise stay lit. */
  end?: boolean;
}

export function ModuleTabs({
  items,
  ariaLabel,
  /** Scopes the sliding underline. Two strips sharing one id animate into each
   *  other, so this must be unique per strip. */
  layoutId,
  embedded = false,
}: {
  items: ModuleTab[];
  ariaLabel: string;
  layoutId: string;
  embedded?: boolean;
}) {
  const prefersReducedMotion = useReducedMotion();
  if (!items.length) return null;

  /* A tab whose path is the PREFIX of a sibling's has to match exactly, or React
     Router lights it for the sibling too: /approvals is a prefix of
     /approvals/overview, so opening the Overview highlighted "Waiting for Me".
     Derived rather than declared, so a module that adds a deeper screen tomorrow
     does not have to remember to come back and set `end` on its parent. */
  const exact = (item: ModuleTab) => item.end
    ?? items.some((other) => other.path !== item.path && other.path.startsWith(`${item.path}/`));

  return (
    <nav
      aria-label={ariaLabel}
      className={`${embedded ? "" : "mb-5"} nav-scroll overflow-x-auto pb-1`}
    >
      <LayoutGroup id={layoutId}>
        <div className="flex min-w-max items-stretch gap-5">
          {items.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              end={exact(item)}
              className={({ isActive }) =>
                `relative inline-flex min-h-11 shrink-0 items-center gap-2 px-1 text-sm font-medium ` +
                `transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 ` +
                `focus-visible:ring-brand focus-visible:ring-offset-2 ${
                  isActive ? "text-brand" : "text-muted hover:text-body"
                }`
              }
            >
              {({ isActive }) => (
                <>
                  {item.icon}
                  <span>{item.label}</span>
                  {isActive && (
                    <motion.span
                      layoutId={`${layoutId}-active-tab`}
                      aria-hidden="true"
                      className="absolute inset-x-0 bottom-0 h-[3px] rounded-full bg-brand"
                      transition={
                        prefersReducedMotion
                          ? { duration: 0 }
                          : { type: "spring", stiffness: 500, damping: 38, mass: 0.65 }
                      }
                    />
                  )}
                </>
              )}
            </NavLink>
          ))}
        </div>
      </LayoutGroup>
    </nav>
  );
}
