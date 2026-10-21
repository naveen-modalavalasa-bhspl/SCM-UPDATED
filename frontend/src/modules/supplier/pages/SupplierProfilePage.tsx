import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
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
