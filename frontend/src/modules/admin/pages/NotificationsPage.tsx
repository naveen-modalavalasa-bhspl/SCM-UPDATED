import { PageHeader, type Column } from "@/shared/components";
import { MasterCrud, type Option } from "@/modules/masters/components/MasterCrud";
import { adminApi } from "../api";
import type { NotificationRule } from "../types";

const RECIPIENT_TYPES: Option[] = ["ROLE", "POSITION", "GROUP", "EMPLOYEE"]
  .map((value) => ({ value, label: value }));
const CHANNELS: Option[] = ["IN_APP", "EMAIL"]
  .map((value) => ({ value, label: value.replace("_", " ") }));

const Active = ({ on }: { on: boolean }) => (
  <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${
    on ? "bg-ok-bg text-ok" : "bg-default text-muted"
  }`}>
    {on ? "Active" : "Inactive"}
  </span>
);

export function NotificationsPage() {
  const columns: Column<NotificationRule>[] = [
    {
      key: "event", header: "Event",
      render: (row) => <span className="mono font-semibold text-ink">{row.event_code}</span>,
    },
    { key: "stage", header: "Stage", render: (row) => row.stage ?? "All stages" },
    {
      key: "recipient", header: "Recipient",
      render: (row) => `${row.recipient_type}: ${row.recipient_name ?? row.recipient_id ?? "—"}`,
    },
    { key: "channel", header: "Channel", hideOnNarrow: true, render: (row) => row.channel },
    { key: "status", header: "Status", render: (row) => <Active on={row.is_active} /> },
  ];

  return (
    <>
      <PageHeader eyebrow="Settings" title="Notifications" />
      <MasterCrud<NotificationRule>
        title="Notification rule"
        queryKey="notification-rules"
        managePerm="admin.notifications.manage"
        columns={columns}
        renderCard={(row) => (
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="mono font-semibold text-ink">{row.event_code}</span>
              <Active on={row.is_active} />
            </div>
            <div className="text-sm text-body">
              {row.recipient_name ?? `${row.recipient_type} #${row.recipient_id}`}
            </div>
            <div className="text-xs text-muted">{row.channel} · {row.stage ?? "All stages"}</div>
          </div>
        )}
        fetchList={adminApi.notifications.list}
        fields={[
          { key: "event_code", label: "Event code", required: true },
          { key: "stage", label: "Workflow stage (optional)" },
          {
            key: "recipient_type", label: "Recipient type", type: "select",
            options: RECIPIENT_TYPES, required: true,
          },
          { key: "recipient_id", label: "Recipient ID", type: "number", required: true },
          { key: "channel", label: "Channel", type: "select", options: CHANNELS, required: true },
          { key: "template", label: "Message template" },
          { key: "is_active", label: "Active", type: "switch" },
        ]}
        emptyForm={{
          event_code: "", stage: "", recipient_type: "ROLE", recipient_id: null,
          channel: "IN_APP", template: "", is_active: true,
        }}
        toForm={(row) => ({
          event_code: row.event_code,
          stage: row.stage ?? "",
          recipient_type: row.recipient_type,
          recipient_id: row.recipient_id ?? null,
          channel: row.channel,
          template: row.template ?? "",
          is_active: row.is_active,
        })}
        onCreate={(value) => adminApi.notifications.create(value as Partial<NotificationRule>)}
        onUpdate={(id, value) =>
          adminApi.notifications.update(id, value as Partial<NotificationRule>)}
        onDeactivate={adminApi.notifications.remove}
      />
    </>
  );
}
