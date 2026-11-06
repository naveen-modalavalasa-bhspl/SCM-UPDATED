import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Can, ErrorBanner, useToast } from "@/shared/components";
import { Button } from "@/modules/procurement/components/ActionButton";
import { fmtDateTime } from "@/shared/datetime";
import { mastersApi } from "../api";
import type { RefRow } from "../types";
import { Active, Code, ReadOnlyTab } from "./common";

/** One feed fills both tabs, so either tab's press refreshes the two. */
function OrgSyncBar() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ["org-sync-status"], queryFn: mastersApi.orgSyncStatus });
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["org-sync-status"] });
    queryClient.invalidateQueries({ queryKey: ["masters", "organisations"] });
    queryClient.invalidateQueries({ queryKey: ["masters", "organisation-depts"] });
  };
  const sync = useMutation({
    mutationFn: mastersApi.orgSyncNow,
    onSuccess: (done) => {
      refresh();
      toast.success(`Synced ${done.organisations} organisations and ${done.departments} departments`);
    },
    // A refused sync is logged, so the line below has to catch up too.
    onError: refresh,
  });
  const data = status.data;

  return (
    <div className="mb-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-content p-3">
        <div className="text-sm text-body">
          {data && !data.configured
            ? "The organisation feed is not configured. Set ORG_SYNC_URL and ORG_SYNC_API_KEY in backend/.env."
            : data?.last_success_at
              ? `Last synced ${fmtDateTime(data.last_success_at)}`
              : "Not synced yet."}
        </div>
        <Can do="admin.users.manage">
          <Button disabled={sync.isPending || !data?.configured} onClick={() => sync.mutate()}>
            {sync.isPending ? "Syncing…" : "Sync now"}
          </Button>
        </Can>
      </div>
      <ErrorBanner error={sync.error} />
      {!sync.error && data?.last_status === "FAILED" && data.last_error && (
        <ErrorBanner error={`The last sync failed, so this list may be out of date: ${data.last_error}`} />
      )}
    </div>
  );
}

export function OrgDirectoryTab({ title, fetchList }: {
  title: string;
  fetchList: () => Promise<RefRow[]>;
}) {
  return (
    <>
      <OrgSyncBar />
      <ReadOnlyTab<RefRow>
        title={title}
        fetchList={fetchList}
        columns={[
          { key: "code", header: "Code", render: (r) => <Code>{r.code ?? "—"}</Code> },
          { key: "name", header: "Name", render: (r) => r.name },
          { key: "status", header: "Status", render: (r) => <Active on={r.is_active !== false} /> },
        ]}
        renderCard={(r) => (
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <Code>{r.code ?? "—"}</Code>
              <Active on={r.is_active !== false} />
            </div>
            <div className="text-sm text-body">{r.name}</div>
          </div>
        )}
      />
    </>
  );
}
