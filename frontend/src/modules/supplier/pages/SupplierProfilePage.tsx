import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Card, ErrorBanner, PageHeader } from "@/shared/components";
import { supplierApi } from "@/modules/procurement/api";

/** Read-only. The vendor master belongs to procurement — a supplier correcting their
 *  own GSTIN would silently change what every past PO was raised against. */
export function SupplierProfilePage() {
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
      <PageHeader eyebrow="Supplier" title={profile?.name ?? "Your details"} />

      <ErrorBanner error={error} />

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
          <Link to="/supplier/password" className="text-brand hover:underline">
            Change your password
          </Link>
          .
        </p>
      </Card>
    </div>
  );
}
