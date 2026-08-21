import { Link, Navigate, NavLink, Outlet, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Handshake, LogOut, Truck, User } from "lucide-react";
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

  // Underline tabs on a light band — the same shape the supplier portal uses, so a
  // partner who holds both accounts reads one product. The active tab is carried by
  // a 2px rule and the weight of the word, not by a filled pill: on a phone at a
  // loading bay the loudest thing on screen should be the shipment, not the chrome.
  const tab = ({ isActive }: { isActive: boolean }) =>
    `flex min-h-11 items-center gap-2 whitespace-nowrap border-b-2 px-1 text-sm transition-colors ${
      isActive
        ? "border-brand font-semibold text-ink"
        : "border-transparent text-muted hover:border-line hover:text-body"
    }`;

  return (
    <div className="min-h-screen">
      {/* The identity band. A partner signing in is not looking at our ERP — they are
          looking at OUR portal, on their own account. That is said by the mark, the
          eyebrow and their own name, not by a tinted glow: this header is one flat
          surface, a hairline rule and the tabs, and it stays put while a shipment
          list scrolls under it. */}
      <header className="sticky top-0 z-20 border-b border-line bg-content1/90 backdrop-blur">
        <div className="mx-auto max-w-5xl px-4">
          <div className="flex flex-wrap items-center justify-between gap-3 py-3">
            <Link
              to="/carrier/jobs"
              className="flex min-w-0 items-center gap-3 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand text-white shadow-sm">
                <Truck className="h-5 w-5" strokeWidth={2.2} />
              </span>
              <span className="min-w-0 leading-tight">
                <span className="block text-[11px] font-semibold uppercase tracking-[0.18em] text-brand">
                  Logistics Partner Portal
                </span>
                <span className="block truncate font-display text-lg font-bold text-ink">
                  {profile?.name ?? "…"}
                </span>
              </span>
            </Link>
            <button
              type="button"
              onClick={signOut}
              className="flex min-h-11 shrink-0 items-center gap-2 rounded-lg border border-line px-3 text-sm font-medium text-muted transition-colors hover:bg-surface hover:text-ink"
            >
              <LogOut className="h-4 w-4" /> Sign out
            </button>
          </div>

          {/* The rail scrolls rather than wraps: three tabs fit any phone today, and
              a fourth must not push the sign-out button onto its own line. */}
          <nav aria-label="Carrier" className="-mx-1 overflow-x-auto px-1">
            <div className="flex w-max gap-6">
              <NavLink to="/carrier/jobs" className={tab}>
                <Truck className="h-4 w-4" /> Shipments
              </NavLink>
              {/* Where an awarded job is answered. Its own tab rather than a panel
                  buried in the shipments board: a carrier prices lanes all week and
                  confirms the two they won, and those two should not have to be found
                  among the rest. */}
              <NavLink to="/carrier/acknowledgements" className={tab}>
                <Handshake className="h-4 w-4" /> Acknowledgements
              </NavLink>
              {/* The vendor profile screen is the supplier portal's; a carrier holds
                  the same account, so it is the same screen rather than a second copy
                  — but mounted under /carrier so the tab does not hand the driver over
                  to the supplier shell. */}
              <NavLink to="/carrier/profile" className={tab}>
                <User className="h-4 w-4" /> Account
              </NavLink>
            </div>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
