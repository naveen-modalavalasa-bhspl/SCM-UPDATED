import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { LogOut, Boxes, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Avatar, Select, SelectItem, Tab, Tabs } from "@heroui/react";
import { useAuth } from "@/shared/auth/AuthContext";
import { MenuIcon } from "@/shared/layout/icons";
import type { MenuItem } from "@/shared/types";
import { IndentsNav } from "@/modules/indents/components/IndentsNav";

const matches = (path: string, loc: string) =>
  loc === path || (path !== "/" && loc.startsWith(path));

function moduleHome(root: MenuItem): string {
  return root.children?.length ? root.children[0].path : root.path;
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
  const menu = me?.menu ?? [];
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
  const best = pairs
    .filter(({ child }) => matches(child.path, loc))
    .sort((a, b) => b.child.path.length - a.child.path.length)[0];
  const activeRoot = best?.root ?? menu[0];
  const tabs = activeRoot?.children ?? [];
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
      className={compact ? "w-52" : "mt-2 w-full"}
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
              <div className="truncate text-xs text-muted">{me?.roles.join(" · ")}</div>
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
          <div className="flex items-center justify-between px-4 py-3 md:px-8">
            <div className="md:hidden">
              <Brand />
            </div>
            <div className="hidden items-center gap-2 md:flex">
              <MenuIcon name={activeRoot?.icon} className="h-4 w-4 text-brand" />
              <span className="font-display text-lg font-bold text-ink">{activeRoot?.name}</span>
            </div>
            <div className="flex items-center gap-2">
              {/* The rail owns this when expanded; collapsed it has nowhere to
                  live, so surface it here rather than lose position switching. */}
              <div className={collapsed ? undefined : "md:hidden"}>{positionSelector(true)}</div>
              <Avatar size="sm" name={me?.employee.name ?? "U"} className="bg-brand-050 text-brand" />
            </div>
          </div>

          {/* Module options surface here as tabs */}
          {activeRoot?.code === "grp_indents" && (
            <div className="px-2 md:px-6">
              <IndentsNav embedded />
            </div>
          )}
          {tabs.length > 0 && activeRoot?.code !== "grp_indents" && (
            <div className="min-w-0 px-2 md:px-6">
              <Tabs
                aria-label="Module sections"
                variant="underlined"
                color="primary"
                selectedKey={best?.child.path ?? tabs[0].path}
                onSelectionChange={(k) => nav(String(k))}
                classNames={{
                  // HeroUI tabs are `w-full` by default. In a horizontal navigation
                  // strip that makes every item viewport-wide and pushes all but the
                  // first one off-screen. Keep the base constrained to the header,
                  // let the list own overflow, and size each tab to its label.
                  base: "block w-full min-w-0",
                  tabList: "w-full justify-start gap-4 overflow-x-auto",
                  cursor: "bg-brand",
                  tab: "h-11 w-auto min-w-max shrink-0 px-1",
                }}
              >
                {tabs.map((c) => (
                  <Tab
                    key={c.path}
                    title={
                      <span className="flex items-center gap-1.5 text-sm font-medium">
                        <MenuIcon name={c.icon} className="h-4 w-4" />
                        {c.name}
                      </span>
                    }
                  />
                ))}
              </Tabs>
            </div>
          )}
        </header>

        <main className="flex-1 px-4 pb-24 pt-6 md:px-8 md:pb-10">
          {/* Collapsing the rail is a request for room — let the content claim it. */}
          <div className={`mx-auto ${collapsed ? "max-w-7xl" : "max-w-6xl"}`}>
            <Outlet />
          </div>
        </main>
      </div>

      {/* Mobile bottom bar — modules */}
      <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-line bg-content1/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
        {menu.slice(0, 5).map((root) => (
          <NavLink
            key={root.code}
            to={moduleHome(root)}
            className={() =>
              `flex flex-1 flex-col items-center gap-1 py-2.5 text-[10px] font-medium ${
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
