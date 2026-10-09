import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, ErrorBanner, Input, PageHeader, ResponsiveList, StatusPill, useToast, type Column } from "@/shared/components";
import { Button } from "../components/ActionButton";
import { fmtDate } from "@/shared/datetime";
import { api } from "@/shared/api/client";
import { supplierAccountApi } from "../api";
import type { VendorAccount } from "../types";

interface MasterVendor {
  id: number;
  code?: string | null;
  name: string;
}

const SIZE = 20;

/**
 * Who outside the company can sign in.
 *
 * Every new account starts on one shared password and `must_change_password`, so the
 * portal shows nothing but the change form until it is replaced. The password is
 * printed here rather than emailed because SCM sends no mail — a buyer reads it out.
 */
export function SupplierAccountsPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");

  const { data, isLoading, error } = useQuery({
    queryKey: ["supplier-accounts", page],
    queryFn: () => supplierAccountApi.list({ page, size: SIZE }),
  });

  const { data: vendors = [] } = useQuery({
    queryKey: ["supplier-account-vendors", search],
    queryFn: () =>
      api.get<{ items: MasterVendor[] }>("/api/vendors", {
        params: { search: search || undefined, size: 20, is_active: true },
      }).then((r) => r.data.items),
    enabled: search.length > 1,
  });

  const refresh = (message: string) => () => {
    queryClient.invalidateQueries({ queryKey: ["supplier-accounts"] });
    toast.success(message);
  };

  const create = useMutation({
    mutationFn: (vendorId: number) => supplierAccountApi.create(vendorId),
    onSuccess: refresh("Login issued — the password is Bavya@123 until they change it"),
  });
  const reset = useMutation({
    mutationFn: (vendorId: number) => supplierAccountApi.reset(vendorId),
    onSuccess: refresh("Password reset to Bavya@123"),
  });
  const toggle = useMutation({
    mutationFn: ({ vendorId, active }: { vendorId: number; active: boolean }) =>
      active ? supplierAccountApi.enable(vendorId) : supplierAccountApi.disable(vendorId),
    onSuccess: refresh("Account updated"),
  });

  const busy = create.isPending || reset.isPending || toggle.isPending;
  const existingIds = new Set((data?.items ?? []).map((a) => a.vendor_id));

  const columns: Column<VendorAccount>[] = [
    {
      key: "username",
      header: "Username",
      render: (r) => (
        <span className="font-mono text-xs font-semibold text-ink">{r.username}</span>
      ),
    },
    {
      key: "state",
      header: "State",
      render: (r) => (
        <StatusPill status={r.is_active ? "ACTIVE" : "DISABLED"} />
      ),
    },
    {
      key: "password",
      header: "Password",
      render: (r) => (
        <span className="text-sm text-muted">
          {r.must_change_password ? "Default — not yet changed" : "Set by vendor"}
        </span>
      ),
    },
    {
      key: "last",
      header: "Last sign-in",
      hideOnNarrow: true,
      render: (r) => (r.last_login_at ? fmtDate(r.last_login_at) : "Never"),
    },
    {
      key: "actions",
      header: "",
      render: (r) => (
        <div className="flex gap-2">
          <Button variant="subtle" disabled={busy} onClick={() => reset.mutate(r.vendor_id)}>
            Reset
          </Button>
          <Button
            variant="subtle"
            disabled={busy}
            onClick={() => toggle.mutate({ vendorId: r.vendor_id, active: !r.is_active })}
          >
            {r.is_active ? "Disable" : "Enable"}
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader eyebrow="Settings" title="Supplier Logins" />

      <ErrorBanner error={error ?? create.error ?? reset.error ?? toggle.error} />

      <Card className="mb-4 p-5">
        <h2 className="mb-1 text-sm font-semibold text-ink">Issue a login</h2>
        <p className="mb-3 text-xs text-muted">
          Search the vendor master. A new account signs in with <b>Bavya@123</b> and
          must change it before anything else is shown.
        </p>
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search vendors…"
        />
        {search.length > 1 && (
          <div className="mt-3 max-h-56 space-y-1 overflow-y-auto rounded-xl border border-line p-2">
            {vendors.map((vendor) => (
              <div
                key={vendor.id}
                className="flex min-h-11 items-center justify-between gap-3 rounded-lg px-3 hover:bg-surface-2"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm text-ink">{vendor.name}</span>
                  <span className="block truncate text-[11px] text-muted">{vendor.code ?? "—"}</span>
                </span>
                {existingIds.has(vendor.id) ? (
                  <span className="text-xs text-muted">Has a login</span>
                ) : (
                  <Button variant="subtle" disabled={busy} onClick={() => create.mutate(vendor.id)}>
                    Issue
                  </Button>
                )}
              </div>
            ))}
            {!vendors.length && (
              <p className="px-3 py-4 text-sm text-muted">No vendors match that search.</p>
            )}
          </div>
        )}
      </Card>

      <Card className="p-2">
        <ResponsiveList
          data={data?.items ?? []}
          columns={columns}
          keyOf={(r) => r.vendor_id}
          loading={isLoading}
          page={page}
          totalPages={Math.max(1, Math.ceil((data?.total ?? 0) / SIZE))}
          onPageChange={setPage}
          empty="No supplier logins yet."
          renderCard={(r) => (
            <div className="space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <span className="font-mono text-xs font-semibold text-ink">{r.username}</span>
                <StatusPill status={r.is_active ? "ACTIVE" : "DISABLED"} />
              </div>
              <div className="text-xs text-muted">
                {r.last_login_at ? `Last in ${fmtDate(r.last_login_at)}` : "Never signed in"}
              </div>
              <div className="flex gap-2 pt-1">
                <Button variant="subtle" disabled={busy} onClick={() => reset.mutate(r.vendor_id)}>
                  Reset
                </Button>
                <Button
                  variant="subtle"
                  disabled={busy}
                  onClick={() => toggle.mutate({ vendorId: r.vendor_id, active: !r.is_active })}
                >
                  {r.is_active ? "Disable" : "Enable"}
                </Button>
              </div>
            </div>
          )}
        />
      </Card>
    </div>
  );
}
