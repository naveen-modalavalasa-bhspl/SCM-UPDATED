import { useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Send, X } from "lucide-react";
import {
  Table, TableHeader, TableColumn, TableBody, TableRow, TableCell, Skeleton, CardBody,
} from "@heroui/react";
import { PageHeader, Button, Card, Can, StatusPill } from "@/shared/components";
import { FlowStepper } from "../components/FlowStepper";
import { indentApi } from "../api";

function Detail({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium text-body">{value || "—"}</dd>
    </div>
  );
}

export function IndentDetailPage() {
  const { id } = useParams();
  const indentId = Number(id);
  const nav = useNavigate();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const { data: indent, isLoading } = useQuery({
    queryKey: ["indent", indentId],
    queryFn: () => indentApi.get(indentId),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["indent", indentId] });
    qc.invalidateQueries({ queryKey: ["indents"] });
  };
  const onErr = (e: Error) => setError(e.message);

  const submit = useMutation({ mutationFn: () => indentApi.submit(indentId), onSuccess: refresh, onError: onErr });
  const approve = useMutation({ mutationFn: () => indentApi.approve(indentId, ""), onSuccess: refresh, onError: onErr });
  const reject = useMutation({ mutationFn: () => indentApi.reject(indentId, ""), onSuccess: refresh, onError: onErr });

  if (isLoading || !indent) return <Skeleton className="h-40 rounded-2xl" />;

  const isDraft = indent.status === "DRAFT";
  const isPending = indent.status === "PENDING_APPROVAL";

  return (
    <>
      <button onClick={() => nav("/indents")} className="mb-3 inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-body">
        <ArrowLeft className="h-4 w-4" /> All indents
      </button>

      <PageHeader eyebrow="Indent" title={indent.indent_no} actions={<StatusPill status={indent.status} />} />

      <Card className="mb-5">
        <CardBody className="p-5"><FlowStepper status={indent.status} /></CardBody>
      </Card>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardBody className="p-5">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted">Line items</h2>
            <Table removeWrapper aria-label="Line items"
                   classNames={{ th: "bg-content2 text-[11px] uppercase tracking-wider text-muted", td: "py-3" }}>
              <TableHeader>
                <TableColumn>Item</TableColumn>
                <TableColumn className="text-right">Qty</TableColumn>
                <TableColumn className="text-right">UOM</TableColumn>
              </TableHeader>
              <TableBody items={indent.items}>
                {(it) => (
                  <TableRow key={it.id}>
                    <TableCell>
                      <div className="font-medium text-body">{it.item_name}</div>
                      <div className="mono text-xs text-muted">{it.item_code}</div>
                    </TableCell>
                    <TableCell className="text-right tabular font-semibold">{it.quantity}</TableCell>
                    <TableCell className="text-right text-muted">{it.uom_code}</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardBody>
        </Card>

        <Card className="h-fit">
          <CardBody className="p-5">
            <dl className="grid grid-cols-2 gap-4 lg:grid-cols-1">
              <Detail label="Requested by" value={indent.requested_by_name} />
              <Detail label="Department" value={indent.department_name} />
              <Detail label="Deliver to" value={indent.facility_name} />
              <Detail label="Priority" value={indent.priority} />
              {isPending && <Detail label="With" value={indent.current_approver_name} />}
            </dl>
          </CardBody>
        </Card>
      </div>

      {error && <div className="mt-4 rounded-xl bg-bad-bg px-4 py-3 text-sm font-medium text-bad">{error}</div>}

      {(isDraft || isPending) && (
        <div className="fixed inset-x-0 bottom-0 z-10 flex gap-3 border-t border-line bg-content1 p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] md:static md:mt-6 md:justify-end md:border-0 md:bg-transparent md:p-0">
          {isDraft && (
            <Can do="indent.submit">
              <Button className="flex-1 md:flex-none" disabled={submit.isPending} onClick={() => submit.mutate()}>
                <Send className="h-4 w-4" /> Submit for approval
              </Button>
            </Can>
          )}
          {isPending && (
            <>
              <Can do="indent.reject">
                <Button variant="danger" className="flex-1 md:flex-none" disabled={reject.isPending} onClick={() => reject.mutate()}>
                  <X className="h-4 w-4" /> Reject
                </Button>
              </Can>
              <Can do="indent.approve">
                <Button className="flex-1 md:flex-none" disabled={approve.isPending} onClick={() => approve.mutate()}>
                  <Check className="h-4 w-4" /> Approve
                </Button>
              </Can>
            </>
          )}
        </div>
      )}
    </>
  );
}
