import {
  Home, FileText, CheckCircle, ShoppingCart, Truck, Package, Send, Settings,
  LayoutDashboard, List, Columns3, BarChart3, Bell, Boxes, Database, Shield,
  Users, GitBranch, Hash, ScrollText, History, RefreshCw, ArrowLeftRight, RotateCcw,
  type LucideIcon,
} from "lucide-react";

const MAP: Record<string, LucideIcon> = {
  home: Home,
  "file-text": FileText,
  "check-circle": CheckCircle,
  "shopping-cart": ShoppingCart,
  truck: Truck,
  package: Package,
  send: Send,
  settings: Settings,
  "layout-dashboard": LayoutDashboard,
  list: List,
  columns: Columns3,
  "bar-chart": BarChart3,
  bell: Bell,
  database: Database,
  shield: Shield,
  users: Users,
  "git-branch": GitBranch,
  hash: Hash,
  "scroll-text": ScrollText,
  boxes: Boxes,
  history: History,
  "refresh-cw": RefreshCw,
  "arrow-left-right": ArrowLeftRight,
  "rotate-ccw": RotateCcw,
};

export function MenuIcon({ name, className }: { name?: string | null; className?: string }) {
  const Icon = (name && MAP[name]) || Boxes;
  return <Icon className={className} strokeWidth={2} />;
}
