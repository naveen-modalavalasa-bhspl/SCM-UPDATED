import { Link, Navigate, NavLink, Outlet, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { FileText, LogOut, Truck, User } from "lucide-react";
import { clearVendorToken, vendorToken } from "@/shared/api/client";
import { supplierApi } from "@/modules/procurement/api";
import { VendorBell } from "./VendorBell";

/**
 * The shell for everyone outside the company.
 *
 * Deliberately NOT the employee `<AppLayout>`: there is no left rail, no module menu
 * and no `<Can>` anywhere under here, because a vendor holds no RBAC role. What they
 * may see is decided server-side by filtering on the vendor id in their token.
 */
export function SupplierLayout() {
  const nav = useNavigate();
  const token = vendorToken();

  const { data: profile } = useQuery({
    queryKey: ["supplier-me"],
    queryFn: () => supplierApi.me(),
    enabled: Boolean(token),
  });

  if (!token) return <Navigate to="/supplier/login" replace />;

  const signOut = () => {
    clearVendorToken();
    nav("/supplier/login", { replace: true });
  };

  const tab = ({ isActive }: { isActive: boolean }) =>
    `flex min-h-11 items-center gap-2 border-b-2 px-1 text-sm transition ${
      isActive
        ? "border-brand font-semibold text-ink"
        : "border-transparent text-muted hover:text-body"
    }`;

  return (
    <div className="min-h-screen bg-surface-1">
      <header className="border-b border-line bg-content1">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <Link to="/supplier/rfqs" className="min-w-0">
            <span className="block text-[11px] font-semibold uppercase tracking-[0.18em] text-brand">
              Supplier Portal
            </span>
            <span className="block truncate font-display text-lg font-bold text-ink">
              {profile?.name ?? "…"}
            </span>
          </Link>
          <div className="flex items-center gap-1">
            {/* What the company needed to tell them — an amended order, most of all.
                See VendorBell (2026-08-21). */}
            <VendorBell />
            <button
              type="button"
              onClick={signOut}
              className="flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm text-muted hover:bg-surface-2 hover:text-body"
            >
              <LogOut className="h-4 w-4" /> Sign out
            </button>
          </div>
        </div>
        <nav aria-label="Supplier" className="mx-auto max-w-5xl px-4">
          <div className="flex gap-6">
            <NavLink to="/supplier/rfqs" className={tab}>
              <FileText className="h-4 w-4" /> Requests
            </NavLink>
            <NavLink to="/supplier/pos" className={tab}>
              <Truck className="h-4 w-4" /> Orders
            </NavLink>
            <NavLink to="/supplier/profile" className={tab}>
              <User className="h-4 w-4" /> Profile
            </NavLink>
          </div>
        </nav>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
