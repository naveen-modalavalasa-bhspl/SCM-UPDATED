import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { LogOut, Boxes } from "lucide-react";
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

function Brand() {
  return (
    <div className="flex items-center gap-2.5">
      <span className="grid h-9 w-9 place-items-center rounded-xl bg-brand text-white shadow-sm">
        <Boxes className="h-5 w-5" strokeWidth={2.2} />
      </span>
      <div className="leading-tight">
        <div className="font-display text-[15px] font-bold text-ink">
          SCM<span className="text-signal">·</span>ERP
        </div>
        <div className="text-[10px] uppercase tracking-[0.18em] text-muted">Supply Chain</div>
      </div>
    </div>
  );
}

export function AppLayout() {
  const { me, logout, switchPosition } = useAuth();
  const menu = me?.menu ?? [];
  const nav = useNavigate();
  const loc = useLocation().pathname;

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
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[236px] flex-col border-r border-line bg-content1/80 px-3 py-5 backdrop-blur md:flex">
        <div className="px-2">
          <Brand />
        </div>
        <nav className="mt-7 flex-1 space-y-1">
          {menu.map((root) => {
            const active = root === activeRoot;
            return (
              <button
                key={root.code}
                onClick={() => nav(moduleHome(root))}
                className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
                  active ? "bg-brand-050 text-brand" : "text-muted hover:bg-default hover:text-ink"
                }`}
              >
                <MenuIcon name={root.icon} className="h-[18px] w-[18px]" />
                {root.name}
              </button>
            );
          })}
        </nav>
        <div className="mt-2 flex items-center gap-3 rounded-xl border border-line bg-content1 p-2.5">
          <Avatar size="sm" name={me?.employee.name ?? "U"} className="bg-brand-050 text-brand" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-ink">{me?.employee.name}</div>
            <div className="truncate text-xs text-muted">{me?.roles.join(" · ")}</div>
          </div>
          <button onClick={logout} className="text-muted hover:text-bad" aria-label="Sign out">
            <LogOut className="h-4 w-4" />
          </button>
        </div>
        {positionSelector()}
      </aside>

      {/* Main column */}
      <div className="flex min-h-full flex-1 flex-col md:pl-[236px]">
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
              <div className="md:hidden">{positionSelector(true)}</div>
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
            <div className="overflow-x-auto px-2 md:px-6">
              <Tabs
                aria-label="Module sections"
                variant="underlined"
                color="primary"
                selectedKey={best?.child.path ?? tabs[0].path}
                onSelectionChange={(k) => nav(String(k))}
                classNames={{ tabList: "gap-4", cursor: "bg-brand", tab: "px-1 h-11" }}
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
          <div className="mx-auto max-w-6xl">
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
