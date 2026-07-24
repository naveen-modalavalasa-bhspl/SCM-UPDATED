import {
  Home, FileText, CheckCircle, ShoppingCart, Truck, Package, Send, Settings,
  LayoutDashboard, List, Columns3, BarChart3, Bell, Boxes,
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
};

export function MenuIcon({ name, className }: { name?: string | null; className?: string }) {
  const Icon = (name && MAP[name]) || Boxes;
  return <Icon className={className} strokeWidth={2} />;
}
