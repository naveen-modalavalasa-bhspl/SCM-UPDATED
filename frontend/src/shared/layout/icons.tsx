import {
  ArrowLeftRight, BarChart3, Bell, Boxes, Braces, Briefcase, Bug, Building2,
  CheckCircle, ClipboardCheck, ClipboardList,
  Columns3, CornerUpLeft, Database, FileStack, FileText, Gavel, GitBranch,
  Handshake, Hash, History, Home, Inbox, IndianRupee, Key, LayoutDashboard, Layers,
  List, ListChecks, ListOrdered, MapPin, Move, Package, PackageCheck, PackageX,
  PenLine, Plug, Printer, Receipt, RefreshCw, RotateCcw, Route, Scale, ScrollText,
  SearchCheck, Send, Store,
  Settings, Shield, ShoppingCart, SlidersHorizontal, Sparkles, Split, TrendingUp,
  Truck, Undo2, UserCog, Users, Warehouse, type LucideIcon,
} from "lucide-react";

/**
 * The menu glyph table: `rbac_pages.icon` -> a lucide component.
 *
 * The NAMES are the backend's — they live in `scripts/seed.py` PAGE_TREE and
 * `platform/rbac/page_registry.py`, because a screen's icon belongs to the row that
 * puts the screen on the menu, not to whichever component happens to draw it.
 *
 * EVERY name either side uses must appear here. It is not decoration: a name with no
 * entry falls through to the default, and fourteen of them did — `package-check`,
 * `list-checks`, `map-pin`, `split`, `move`, `plug`, `key`, `printer`, `route`,
 * `sliders`, `sparkles`, `list-ordered`, `indian-rupee`, `corner-up-left` — so
 * Acknowledgements, Picklists, Stocking Points, Segregation, Movements, Integrations
 * and half a dozen more all drew the same generic boxes and the tab strips read as
 * one repeated glyph. `assertKnownIcon` below makes the next gap noisy in dev instead
 * of silently identical.
 */
const MAP: Record<string, LucideIcon> = {
  home: Home,
  "file-text": FileText,
  "file-stack": FileStack,
  "check-circle": CheckCircle,
  "shopping-cart": ShoppingCart,
  truck: Truck,
  warehouse: Warehouse,
  package: Package,
  "package-check": PackageCheck,
  "package-x": PackageX,
  send: Send,
  settings: Settings,
  sliders: SlidersHorizontal,
  "layout-dashboard": LayoutDashboard,
  layers: Layers,
  list: List,
  "list-checks": ListChecks,
  "list-ordered": ListOrdered,
  "clipboard-list": ClipboardList,
  columns: Columns3,
  "bar-chart": BarChart3,
  bell: Bell,
  database: Database,
  shield: Shield,
  users: Users,
  "user-cog": UserCog,
  "git-branch": GitBranch,
  hash: Hash,
  "scroll-text": ScrollText,
  boxes: Boxes,
  history: History,
  "refresh-cw": RefreshCw,
  "arrow-left-right": ArrowLeftRight,
  "rotate-ccw": RotateCcw,
  "corner-up-left": CornerUpLeft,
  bug: Bug,
  gavel: Gavel,
  handshake: Handshake,
  "indian-rupee": IndianRupee,
  key: Key,
  "map-pin": MapPin,
  move: Move,
  "pen-line": PenLine,
  plug: Plug,
  printer: Printer,
  route: Route,
  scale: Scale,
  sparkles: Sparkles,
  split: Split,
  // ADDED 2026-08-23, for the de-duplication pass. A glyph is only worth drawing if
  // it tells one row from the one under it: seven pages shared `check-circle` and
  // four shared `truck`, so a rail of ten warehouse screens read as three repeated
  // shapes. These carry the distinctions the existing table had no way to make.
  "search-check": SearchCheck,
  "clipboard-check": ClipboardCheck,
  "trending-up": TrendingUp,
  briefcase: Briefcase,
  building: Building2,
  braces: Braces,
  inbox: Inbox,
  receipt: Receipt,
  // `wh_material_returns` has named this since it was added and the table never
  // carried it, so Material Returns drew the default box — the fifteenth case of
  // the same gap `assertKnownIcon` exists to catch, found by auditing the tree
  // against this table rather than by anybody reporting it.
  "undo-2": Undo2,
  // `pro_suppliers` names this (2026-08-24). The sixteenth case of the same gap:
  // without an entry the Suppliers tab drew the generic box, which in the procurement
  // rail sat next to seven glyphs that all meant something.
  store: Store,
};

/** Names already reported, so one missing glyph does not log on every render. */
const warned = new Set<string>();

/**
 * Say so, once, when the backend names an icon this table does not carry.
 *
 * Dev only — a missing glyph is a cosmetic fault and must never be an error in front
 * of a user. But it has to be VISIBLE to whoever added the page, because the failure
 * mode is "everything looks fine, just identical", which nobody reports as a bug.
 */
function assertKnownIcon(name: string) {
  if (!import.meta.env.DEV || warned.has(name)) return;
  warned.add(name);
  // eslint-disable-next-line no-console
  console.warn(
    `[menu] No glyph for rbac_pages.icon "${name}" — it will draw the default box. `
    + "Add it to src/shared/layout/icons.tsx.",
  );
}

export function MenuIcon({ name, className }: { name?: string | null; className?: string }) {
  if (name && !MAP[name]) assertKnownIcon(name);
  const Icon = (name && MAP[name]) || Boxes;
  return <Icon className={className} strokeWidth={2} />;
}
