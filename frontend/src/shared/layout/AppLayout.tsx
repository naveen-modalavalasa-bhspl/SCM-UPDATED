import { useEffect, useState } from "react";
import type React from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { LogOut, Boxes, PanelLeftClose, PanelLeftOpen, UserRound } from "lucide-react";
import {
  Avatar,
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownTrigger,
  Select,
  SelectItem,
} from "@heroui/react";
import { useAuth } from "@/shared/auth/AuthContext";
import { MenuIcon } from "@/shared/layout/icons";
import { ModuleTabs } from "@/shared/layout/ModuleTabs";
import { ForbiddenPage } from "@/pages/NotFoundPage";
import { NotificationBell } from "@/shared/layout/NotificationBell";
import type { MenuItem } from "@/shared/types";
import { IndentsNav } from "@/modules/indents/components/IndentsNav";

const matches = (path: string, loc: string) =>
  loc === path || (path !== "/" && loc.startsWith(path));

/**
 * Detail screens whose URL does not sit under the menu page they were opened from,
 * and the page that owns them. Longest-prefix matching alone puts
 * /inventory/allocate/491 under the module root, so the tab strip lit up Overview
 * while the user was looking at the screen the Fulfilment Queue had navigated to.
 * A row click must leave the tab it came from selected.
 */
const DETAIL_OWNER: [prefix: string, page: string][] = [
  ["/inventory/allocate", "/inventory/fulfilment"],
  // The allocation review and the monthly cycle screens, which the Fulfilment Desk's
  // Approvals tab navigates to. Their own menu rows were retired with the two screens
  // the desk replaced (2026-08-21), so without this the tab strip lights up nothing at
  // all while somebody is signing an allocation.
  ["/inventory/allocation-approvals", "/inventory/fulfilment"],
  ["/inventory/fulfillment", "/inventory/fulfilment"],
];

/** The menu path the tab strip should treat this URL as, detail screens included. */
const navPath = (loc: string) =>
  DETAIL_OWNER.find(([prefix]) => matches(prefix, loc))?.[1] ?? loc;

/**
 * Screens still being trialled: in the menu when the code is being run (`npm run
 * dev`), absent from a production build — which is what the deployed image is.
 * So a developer who pulls sees them, the live site does not, and nobody has to
 * set an env var or hand-edit an rbac_pages row per environment.
 *
 * The permission still gates the API; this only decides whether the nav shows it.
 * UsersPage.tsx links to job profiles under the same condition.
 *
 * Empty since v1.3: `rbac_job_profiles` shipped, so it comes out of the trial set.
 * Note this also gates the URL — `allowedPaths` below is built from the FILTERED
 * menu, so a trialled screen is not merely hidden, it bounces a typed URL back to
 * Home. Anything added here is unreachable in production, not just unadvertised.
 */
const IN_TRIAL = new Set<string>([]);

/**
 * Screens that have been retired but still have an `rbac_pages` row.
 *
 * The tree is seeded data and `scripts.seed` prunes the live one, so a row cannot be
 * deleted here — but a menu entry that redirects to a different screen is worse than
 * no entry at all. "Delegations" landed on "Waiting for Me", which reads as the app
 * opening the wrong page. Its route still exists so old links resolve; only the
 * advertisement goes. Keyed by path, because the code is what seed owns.
 */
const RETIRED_PATHS = new Set<string>([
  "/approvals/delegations",   // redirects to the approvals inbox
  "/inventory/demand",        // Demand by Item was removed; redirects to Overview
]);

const visible = (nodes: MenuItem[]): MenuItem[] =>
  nodes
    .filter((n) => !RETIRED_PATHS.has(n.path))
    .filter((n) => import.meta.env.DEV || !IN_TRIAL.has(n.code))
    .map((n) => ({ ...n, children: visible(n.children ?? []) }));

function moduleHome(root: MenuItem): string {
  return root.children?.length ? root.children[0].path : root.path;
}

/** Every path in the menu, at any depth. */
function grantedPaths(nodes: MenuItem[]): Set<string> {
  const out = new Set<string>();
  const walk = (ns: MenuItem[]) => {
    for (const n of ns) {
      out.add(n.path);
      walk(n.children ?? []);
    }
  };
  walk(nodes);
  return out;
}

/**
 * The page a URL belongs to, or null when it belongs to none.
 *
 * Longest match wins, so /indents/reports resolves to the reports page rather than
 * to /indents. A URL with no page behind it — /indents/42, /inventory/allocate/7 —
 * returns null and is always allowed: detail screens have no rbac_pages row, and
 * their data is guarded by the API, which is the real gate.
 *
 * "/" is only ever an exact match; as a prefix it would swallow every URL.
 */
function owningPage(pathname: string, known: string[]): string | null {
  let best: string | null = null;
  for (const page of known) {
    if (page === "/") {
      if (pathname === "/") return "/";
      continue;
    }
    if (pathname === page || pathname.startsWith(`${page}/`)) {
      if (!best || page.length > best.length) best = page;
    }
  }
  return best;
}

/* A mouse wheel only emits deltaY, so a module whose tab strip overflows had no
   mouse-reachable last tab. Translate the vertical wheel onto the strip; the page
   keeps its own scroll because a touchpad's horizontal gesture (deltaX) is left
   alone and a strip that fits is not touched at all. */
function wheelToScroll(e: React.WheelEvent<HTMLDivElement>) {
  const strip = e.currentTarget.querySelector<HTMLElement>(".nav-scroll") ?? e.currentTarget;
  if (e.deltaX !== 0 || strip.scrollWidth <= strip.clientWidth) return;
  strip.scrollLeft += e.deltaY;
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand text-white shadow-sm">
        <Boxes className="h-5 w-5" strokeWidth={2.2} />
      </span>
      {!compact && (
        <div className="leading-tight">
          <div className="font-display text-[15px] font-bold text-ink">
            SCM<span className="text-signal">·</span>ERP
          </div>
          <div className="text-[10px] uppercase tracking-[0.18em] text-muted">Supply Chain</div>
        </div>
      )}
    </div>
  );
}

const RAIL_STORAGE_KEY = "scm.sidebar.collapsed";

export function AppLayout() {
  const { me, logout, switchPosition } = useAuth();
  const menu = visible(me?.menu ?? []);
  const nav = useNavigate();
  const loc = useLocation().pathname;
  // ponytail: localStorage, not a settings table — a rail width is per-device UI
  // state, not something the server needs to know about.
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(RAIL_STORAGE_KEY) === "1",
  );
  useEffect(() => {
    localStorage.setItem(RAIL_STORAGE_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  // Resolve the active module (sidebar) + active sub-page (tabs) by longest path match.
  const pairs = menu.flatMap((r) =>
    r.children?.length ? r.children.map((c) => ({ root: r, child: c })) : [{ root: r, child: r }],
  );
  const activeLoc = navPath(loc);
  const best = pairs
    .filter(({ child }) => matches(child.path, activeLoc))
    .sort((a, b) => b.child.path.length - a.child.path.length)[0];
  const activeRoot = best?.root ?? menu[0];
  const tabs = activeRoot?.children ?? [];
  /* Which slot the tab strip goes in. Read from matchMedia rather than duplicated
     and hidden with CSS — see the note on `moduleTabs`. Matches Tailwind's `lg`. */
  const [wide, setWide] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const sync = () => setWide(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  /* Indents carries its own tab strip (IndentsNav) rather than the data-driven one. */
  const isIndents = activeRoot?.code === "grp_indents";

  /* The module's tab strip, built ONCE and then placed by width — inline beside the
     module name when there is room, on its own row when there is not. Rendering it
     in both slots and hiding one with CSS would put two tablists carrying the same
     labels in the accessibility tree, and both would still be in the tab order. */
  const moduleTabs = isIndents ? (
    <IndentsNav embedded />
  ) : tabs.length > 0 ? (
    <ModuleTabs
      ariaLabel="Module sections"
      layoutId={`module-nav-${activeRoot?.code ?? "none"}`}
      embedded
      items={tabs.map((c) => ({
        path: c.path,
        label: c.name,
        icon: <MenuIcon name={c.icon} className="h-4 w-4" />,
      }))}
    />
  ) : null;

  // A URL the login was not granted. The API already refuses its data, so this is
  // about not rendering a screen that can only ever show errors. It used to bounce
  // silently to Home, which is indistinguishable from the click not registering —
  // it now says so, in place, and leaves the address in the bar to be shared.
  // Retired paths keep their route (old links and notification deep-links still land
  // somewhere real), so they stay allowed even though they left the rail.
  const allowedPaths = grantedPaths(menu);
  RETIRED_PATHS.forEach((path) => allowedPaths.add(path));
  const owner = owningPage(loc, me?.page_paths ?? []);
  const blocked = owner !== null && !allowedPaths.has(owner);
  // `compact` = the header copy. 208px of dropdown does not fit there beside a brand,
  // a bell and an avatar on a 360px screen — it pushed the avatar half off the edge.
  const positionSelector = (compact = false) => me?.positions.length ? (
    <Select
      aria-label="Working position"
      label={compact ? undefined : "Working as"}
      size="sm"
      variant="bordered"
      selectedKeys={me.active_position ? [String(me.active_position.id)] : []}
      onSelectionChange={async (keys) => {
        const id = Number(Array.from(keys)[0]);
        if (id && id !== me.active_position?.id) {
          await switchPosition(id);
          nav("/");
        }
      }}
      className={compact ? "w-32 shrink sm:w-44 md:w-52" : "mt-2 w-full"}
      classNames={{ trigger: "border-line bg-content1" }}
    >
      {me.positions.map((position) => (
        <SelectItem key={String(position.id)}>{position.name}</SelectItem>
      ))}
    </Select>
  ) : null;

  return (
    <div className="flex min-h-full">
      {/* Sidebar — module names only */}
      <aside
        className={`fixed inset-y-0 left-0 z-30 hidden flex-col border-r border-line bg-content1/80 px-3 py-5 backdrop-blur transition-[width] duration-200 md:flex ${
          collapsed ? "w-[72px]" : "w-[236px]"
        }`}
      >
        <div className={`flex items-center ${collapsed ? "justify-center" : "justify-between px-2"}`}>
          <Brand compact={collapsed} />
          {!collapsed && (
            <button
              onClick={() => setCollapsed(true)}
              className="grid h-8 w-8 place-items-center rounded-lg text-muted transition-colors hover:bg-default hover:text-ink"
              aria-label="Collapse sidebar"
              title="Collapse sidebar"
            >
              <PanelLeftClose className="h-[18px] w-[18px]" />
            </button>
          )}
        </div>
        {collapsed && (
          <button
            onClick={() => setCollapsed(false)}
            className="mt-4 grid h-9 w-full place-items-center rounded-lg text-muted transition-colors hover:bg-default hover:text-ink"
            aria-label="Expand sidebar"
            title="Expand sidebar"
          >
            <PanelLeftOpen className="h-[18px] w-[18px]" />
          </button>
        )}
        <nav className={`flex-1 space-y-1 ${collapsed ? "mt-4" : "mt-7"}`}>
          {menu.map((root) => {
            const active = root === activeRoot;
            return (
              <button
                key={root.code}
                onClick={() => nav(moduleHome(root))}
                // The label is the accessible name when expanded; collapsed it is
                // gone, so carry it on aria-label/title or the rail is unusable
                // with a screen reader.
                aria-label={root.name}
                title={collapsed ? root.name : undefined}
                className={`flex w-full items-center rounded-xl py-2.5 text-sm font-medium transition-colors ${
                  collapsed ? "justify-center px-0" : "gap-3 px-3"
                } ${
                  active ? "bg-brand-050 text-brand" : "text-muted hover:bg-default hover:text-ink"
                }`}
              >
                <MenuIcon name={root.icon} className="h-[18px] w-[18px] shrink-0" />
                {!collapsed && root.name}
              </button>
            );
          })}
        </nav>
        <div
          className={`mt-2 flex items-center rounded-xl border border-line bg-content1 ${
            collapsed ? "flex-col gap-2 p-2" : "gap-3 p-2.5"
          }`}
        >
          <Avatar size="sm" name={me?.employee.name ?? "U"} className="bg-brand-050 text-brand" />
          {!collapsed && (
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-ink">{me?.employee.name}</div>
              <div className="truncate text-xs font-medium text-muted">
                {me?.employee.code ?? `Employee #${me?.employee.id}`}
              </div>
              <div className="truncate text-[11px] text-muted">{me?.roles.join(" · ")}</div>
            </div>
          )}
          <button
            onClick={logout}
            className="text-muted hover:text-bad"
            aria-label="Sign out"
            title={collapsed ? "Sign out" : undefined}
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
        {!collapsed && positionSelector()}
      </aside>

      {/* Main column.
          `min-w-0` is load-bearing: a flex item defaults to `min-width: auto`, which
          means it refuses to shrink below its widest child. A module with enough tabs
          (Warehouse has twelve) then stretched this column past the viewport and took
          the page content with it, and the `overflow-x-auto` on the tab strip below
          never engaged because the strip was never the thing overflowing. */}
      <div
        className={`flex min-h-full min-w-0 flex-1 flex-col transition-[padding] duration-200 ${
          collapsed ? "md:pl-[72px]" : "md:pl-[236px]"
        }`}
      >
        <header className="sticky top-0 z-20 border-b border-line bg-content1/80 backdrop-blur">
          {/* One header row, every module (2026-08-22). The module name and its tab
              strip used to be two stacked rows — ~108px of chrome before a screen's
              own header even started. Wide enough, they share one line: name, a rule,
              tabs, then the bell and the avatar. Below lg the tabs take their own row,
              because five labels and an avatar do not fit on one. */}
          <div className={`flex items-center justify-between gap-2 px-4 md:px-8 ${moduleTabs ? "py-2" : "py-3"}`}>
            {/* Phone: the mark only. The wordmark plus a position dropdown plus the
                bell and avatar do not fit on 360px, and the avatar — the only way to
                sign out down here — is what fell off the edge. */}
            <div className="shrink-0 md:hidden">
              <Brand compact />
            </div>
            <div className="hidden shrink-0 items-center gap-2 md:flex">
              <MenuIcon name={activeRoot?.icon} className="h-4 w-4 text-brand" />
              <span className="font-display text-lg font-bold text-ink">{activeRoot?.name}</span>
            </div>
            {moduleTabs && wide && (
              /* pb-0: the strip's own bottom padding lifts the active underline off
                 the baseline, which reads as misalignment once it shares a row. */
              <div
                className="ml-5 hidden min-w-0 flex-1 self-stretch border-l-[3px] border-ink/20 pl-5 lg:block [&_nav]:pb-0 [&_[role=tablist]]:pb-0"
                onWheel={wheelToScroll}
              >
                {moduleTabs}
              </div>
            )}
            <div className="flex min-w-0 items-center justify-end gap-2">
              {/* The rail owns this when expanded; collapsed it has nowhere to
                  live, so surface it here rather than lose position switching. */}
              {/* The position dropdown is the only thing here that may shrink; the
                  bell and the avatar are fixed-size targets. */}
              <div className={`min-w-0 ${collapsed ? "" : "md:hidden"}`}>
                {positionSelector(true)}
              </div>
              <div className="shrink-0">
                <NotificationBell />
              </div>
              {/* The rail carries profile + sign-out on desktop, but the rail is not
                  there on a phone — so signing out was impossible below md. This menu
                  is the one place both sizes can reach. */}
              <Dropdown placement="bottom-end">
                <DropdownTrigger>
                  <button
                    type="button"
                    aria-label="Account menu"
                    className="shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-brand"
                  >
                    <Avatar
                      size="sm"
                      name={me?.employee.name ?? "U"}
                      className="cursor-pointer bg-brand-050 text-brand"
                    />
                  </button>
                </DropdownTrigger>
                <DropdownMenu
                  aria-label="Account"
                  onAction={(key) => (key === "logout" ? logout() : nav("/profile"))}
                >
                  <DropdownItem key="who" isReadOnly className="opacity-100">
                    <div className="text-sm font-semibold text-ink">{me?.employee.name}</div>
                    <div className="text-xs text-muted">
                      {me?.employee.code ?? `Employee #${me?.employee.id}`}
                    </div>
                  </DropdownItem>
                  <DropdownItem key="profile" startContent={<UserRound className="h-4 w-4" />}>
                    My profile
                  </DropdownItem>
                  <DropdownItem
                    key="logout"
                    color="danger"
                    className="text-bad"
                    startContent={<LogOut className="h-4 w-4" />}
                  >
                    Sign out
                  </DropdownItem>
                </DropdownMenu>
              </Dropdown>
            </div>
          </div>

          {/* Not wide enough to share the row — the strip takes its own. */}
          {moduleTabs && !wide && (
            <div className="min-w-0 px-2 md:px-6" onWheel={wheelToScroll}>
              {moduleTabs}
            </div>
          )}
        </header>

        <main className="flex-1 px-4 pb-24 pt-6 md:px-8 md:pb-10">
          {/* Collapsing the rail is a request for room — let the content claim it. */}
          <div className={`mx-auto ${collapsed ? "max-w-7xl" : "max-w-6xl"}`}>
            {blocked ? <ForbiddenPage /> : <Outlet />}
          </div>
        </main>
      </div>

      {/* Mobile bottom bar — modules */}
      {/* Every module is here, not the first five: an admin has a dozen and the rest
          were simply unreachable on a phone. `shrink-0` + a 1/5 basis keeps five
          across the viewport and lets the sixth onward scroll — without it the flex
          items compress to fit and nothing ever overflows, which is why swiping did
          nothing. `snap` so a flick lands on a whole item. */}
      <nav className="fixed inset-x-0 bottom-0 z-30 flex snap-x snap-mandatory overflow-x-auto border-t border-line bg-content1/95 pb-[env(safe-area-inset-bottom)] backdrop-blur [-ms-overflow-style:none] [scrollbar-width:none] md:hidden [&::-webkit-scrollbar]:hidden">
        {menu.map((root) => (
          <NavLink
            key={root.code}
            to={moduleHome(root)}
            className={() =>
              `flex shrink-0 grow basis-1/5 snap-start flex-col items-center gap-1 py-2.5 text-[10px] font-medium ${
                root === activeRoot ? "text-brand" : "text-muted"
              }`
            }
          >
            <MenuIcon name={root.icon} className="h-5 w-5" />
            <span className="max-w-full truncate px-1">{root.name}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
