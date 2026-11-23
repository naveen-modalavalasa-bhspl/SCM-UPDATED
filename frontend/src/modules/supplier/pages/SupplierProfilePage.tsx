import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Landmark, Lock } from "lucide-react";
import { Card, ErrorBanner, PageHeader, SubNav } from "@/shared/components";
import { supplierApi } from "@/modules/procurement/api";
import { vendorPasswordPath } from "@/shared/api/client";
import { SupplierItemPacking } from "../components/SupplierItemPacking";

const TABS = [
  { key: "details", label: "Details" },
  // How each mapped item is to be packed (2026-10-11).
  { key: "packing", label: "Packing" },
];

/** Read-only. The vendor master belongs to procurement — a supplier correcting their
 *  own GSTIN would silently change what every past PO was raised against. */
export function SupplierProfilePage() {
  const [tab, setTab] = useState("details");
  const { data: profile, error } = useQuery({
    queryKey: ["supplier-me"],
    queryFn: () => supplierApi.me(),
  });

  const rows: [string, string | null | undefined][] = [
    ["Vendor code", profile?.code],
    ["Contact person", profile?.contact_person],
    ["Phone", profile?.phone],
    ["Email", profile?.email],
    ["City", profile?.city],
    ["State", profile?.state],
    ["GSTIN", profile?.gstin],
  ];

  return (
    <div>
      {/* "Account", not "Supplier": this screen is mounted in the carrier shell too. */}
      <PageHeader eyebrow="Account" title={profile?.name ?? "Your details"} />

      <ErrorBanner error={error} />

      <SubNav label="Profile" items={TABS} value={tab} onChange={setTab} />

      {tab === "packing" ? <SupplierItemPacking /> : (
      <Card className="p-5">
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs text-muted">{label}</dt>
              <dd className="mt-1 text-sm text-body">{value || "—"}</dd>
            </div>
          ))}
        </dl>

        {/* Where we pay you (2026-11-23) — shown, never editable here. */}
        <section aria-label="Bank details" className="mt-5 rounded-2xl border border-line/80 bg-content2/40 p-4">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-bold text-ink">
            <Landmark className="h-4 w-4 text-brand" aria-hidden /> Bank details
            <span className="inline-flex items-center gap-1 rounded-full bg-content3 px-2 py-0.5 text-[10px] font-semibold text-muted">
              <Lock className="h-3 w-3" aria-hidden /> View only
            </span>
          </h2>
          {profile?.bank_account_no ? (
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              {([["Bank", profile.bank_name], ["Account number", profile.bank_account_no], ["IFSC", profile.ifsc_code]] as const)
                .map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-xs text-muted">{label}</dt>
                    <dd className="mt-1 font-mono text-sm font-semibold text-ink">{value || "—"}</dd>
                  </div>
                ))}
            </dl>
          ) : (
            <p className="text-sm text-muted">No bank details are on file yet — your buyer adds them.</p>
          )}
          <p className="mt-3 text-xs text-muted">
            We pay into this account. To change it, write to your buyer from your registered email —
            bank changes are never made from the portal, to keep your payments safe.
          </p>
          {profile?.is_same_state != null && (
            <p className="mt-2 text-xs font-medium text-ink">
              GST on your invoices to us: {profile.is_same_state ? "CGST + SGST (same state)" : "IGST (different state)"}.
            </p>
          )}
        </section>

        <p className="mt-5 border-t border-line pt-4 text-sm text-muted">
          Something wrong here? Ask your buyer to correct it — these details are held
          on the company's vendor master, not on your account.{" "}
          {/* FIXED 2026-08-21 — hardcoded to /supplier/password. This page is mounted
              in BOTH portals (/supplier/profile and /carrier/profile are the same
              component), so a carrier pressing this from inside the carrier shell was
              thrown into the supplier portal. The path follows the door they came in
              through; see `vendorPasswordPath`. */}
          <Link to={vendorPasswordPath()} className="text-brand hover:underline">
            Change your password
          </Link>
          .
        </p>
      </Card>
      )}
    </div>
  );
}
