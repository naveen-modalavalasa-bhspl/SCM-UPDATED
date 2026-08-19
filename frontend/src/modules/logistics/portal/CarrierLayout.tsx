import { Link, Navigate, NavLink, Outlet, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LogOut, Truck, User } from "lucide-react";
import { api, clearVendorToken, vendorToken } from "@/shared/api/client";

/**
 * The shell for the transport provider.
 *
 * A carrier IS a vendor — same `mst_vendors` row, same portal account, same password
 * — so this signs in through the vendor door and stores the same token. What is
 * different is the work: a supplier quotes for goods, a carrier quotes for a lane,
 * accepts the job, runs it and reports it delivered. That is a different set of
 * screens, so it gets its own shell rather than a fifth tab on the supplier one.
 *
 * No `<Can>` and no left rail anywhere under here: a carrier holds no RBAC role.
 * What they may see is decided server-side by filtering on the vendor id in their
 * token — every call under /api/supplier carries it, and the shared client attaches
 * it by URL prefix.
 */
export function CarrierLayout() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const token = vendorToken();

  const { data: profile } = useQuery({
    queryKey: ["carrier-me"],
    queryFn: () => api.get<{ name: string }>("/api/supplier/me").then((r) => r.data),
    enabled: Boolean(token),
  });

  if (!token) return <Navigate to="/carrier/login" replace />;

  const signOut = () => {
    clearVendorToken();
    // The cache goes with the token. None of the portal's query keys carry a carrier
    // id — there is one signed-in carrier at a time — so anything left behind is
    // served to whoever signs in next: the previous partner's shipments, their badge
    // counts, and their price on a lane this one has not answered yet.
    qc.clear();
    nav("/carrier/login", { replace: true });
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
          <Link to="/carrier/jobs" className="min-w-0">
            <span className="block text-[11px] font-semibold uppercase tracking-[0.18em] text-brand">
              Logistics Partner Portal
            </span>
            <span className="block truncate font-display text-lg font-bold text-ink">
              {profile?.name ?? "…"}
            </span>
          </Link>
          <button
            type="button"
            onClick={signOut}
            className="flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm text-muted hover:bg-surface-2 hover:text-body"
          >
            <LogOut className="h-4 w-4" /> Sign out
          </button>
        </div>
        <nav aria-label="Carrier" className="mx-auto max-w-5xl px-4">
          <div className="flex gap-6">
            <NavLink to="/carrier/jobs" className={tab}>
              <Truck className="h-4 w-4" /> Shipments
            </NavLink>
            {/* The vendor profile screen is the supplier portal's; a carrier holds the
                same account, so it is the same screen rather than a second copy — but
                mounted under /carrier so the tab does not hand the driver over to the
                supplier shell. */}
            <NavLink to="/carrier/profile" className={tab}>
              <User className="h-4 w-4" /> Account
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
