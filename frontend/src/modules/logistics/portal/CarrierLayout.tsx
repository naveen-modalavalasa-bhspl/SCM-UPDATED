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

  // Pills on the dark band, not underlines on a white one. The tab a carrier is on
  // has to be readable across a loading bay in daylight, and an underline two pixels
  // high is the first thing a phone screen loses.
  const tab = ({ isActive }: { isActive: boolean }) =>
    `flex min-h-11 items-center gap-2 rounded-full px-4 text-sm transition ${
      isActive
        ? "bg-white font-semibold text-ink shadow-sm"
        : "text-white/70 hover:bg-white/10 hover:text-white"
    }`;

  return (
    <div className="min-h-screen">
      {/* The identity band. A partner signing in is not looking at our ERP — they
          are looking at OUR portal, on their own account, and the dark band says
          which of the two this is before they read a word of it. It is one element
          deep: a tinted glow, a badge, a name and the tabs. */}
      <header className="relative overflow-hidden bg-ink text-white">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-24 -top-32 h-64 w-64 rounded-full bg-brand/30 blur-3xl"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -left-16 top-10 h-48 w-48 rounded-full bg-signal/15 blur-3xl"
        />
        <div className="relative mx-auto max-w-5xl px-4 pb-3 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Link to="/carrier/jobs" className="flex min-w-0 items-center gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-white/10 ring-1 ring-white/15">
                <Truck className="h-5 w-5 text-white" />
              </span>
              <span className="min-w-0">
                <span className="block text-[10px] font-semibold uppercase tracking-[0.2em] text-white/55">
                  Logistics Partner Portal
                </span>
                <span className="block truncate font-display text-xl font-bold leading-tight text-white">
                  {profile?.name ?? "…"}
                </span>
              </span>
            </Link>
            <button
              type="button"
              onClick={signOut}
              className="flex min-h-11 items-center gap-2 rounded-full border border-white/15 bg-white/5 px-4 text-sm text-white/80 transition hover:bg-white/15 hover:text-white"
            >
              <LogOut className="h-4 w-4" /> Sign out
            </button>
          </div>

          {/* The rail scrolls rather than wraps: three tabs fit any phone today, and
              a fourth must not push the sign-out button onto its own line. */}
          <nav aria-label="Carrier" className="-mx-1 mt-3 overflow-x-auto px-1 pb-0.5">
            <div className="flex w-max gap-1">
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
