import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/react";
import { Plug, Plus } from "lucide-react";
import {
  Button, Card, EmptyState, ErrorBanner, Field, Input, PageHeader, ResponsiveList,
  StatusPill, useToast, type Column,
} from "@/shared/components";
import { integrationsApi } from "../api";
import type { ApiClient, ClientWrite } from "../types";

const BLANK: ClientWrite = {
  code: "", name: "", description: "", contact_person: "", contact_email: "",
  is_active: true,
};

const when = (value?: string | null) =>
  value ? new Date(value).toLocaleString() : "never";

/**
 * The applications SCM serves. One row each, with enough on the row to answer "is this
 * integration alive?" without opening it.
 */
export default function ApiClientsPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<ClientWrite | null>(null);
  const [problem, setProblem] = useState("");

  const { data, isLoading, error } = useQuery({
    queryKey: ["apis", "clients", { page, search }],
    queryFn: () => integrationsApi.listClients({ page, size: 20, search }),
  });

  const create = useMutation({
    mutationFn: (body: ClientWrite) => integrationsApi.createClient(body),
    onSuccess: (client) => {
      queryClient.invalidateQueries({ queryKey: ["apis", "clients"] });
      setDraft(null);
      toast.success(`${client.code} registered`);
      // Straight into it: registering is step one of three, and the other two — a key
      // and an endpoint — live on the detail screen.
      navigate(`/admin/integrations/${client.code}`);
    },
  });

  const submit = () => {
    if (!draft) return;
    const code = draft.code.trim();
    const name = draft.name.trim();
    if (!code || !name) {
      setProblem("A code and a name are both required.");
      return;
    }
    setProblem("");
    create.mutate({ ...draft, code, name });
  };

  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / (data?.size || 20)));

  const columns: Column<ApiClient>[] = [
    {
      key: "code",
      header: "Application",
      render: (row) => (
        <div>
          <div className="font-semibold text-ink">{row.code}</div>
          <div className="text-xs text-muted">{row.name}</div>
        </div>
      ),
    },
    {
      key: "keys",
      header: "Keys",
      render: (row) => (
        <div className="text-sm">
          <div className="text-ink">{row.active_keys} active</div>
          <div className="text-xs text-muted">
            {row.endpoints} {row.endpoints === 1 ? "endpoint" : "endpoints"}
          </div>
        </div>
      ),
    },
    {
      key: "last_called",
      header: "Last called",
      hideOnNarrow: true,
      render: (row) => <span className="text-sm text-body">{when(row.last_called_at)}</span>,
    },
    {
      key: "contact",
      header: "Owner",
      hideOnNarrow: true,
      render: (row) => (
        <div className="text-sm">
          <div className="text-ink">{row.contact_person ?? "—"}</div>
          <div className="text-xs text-muted">{row.contact_email ?? ""}</div>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (row) => <StatusPill status={row.is_active ? "ACTIVE" : "INACTIVE"} />,
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="APIS"
        title="Applications"
        actions={
          <Button onClick={() => {
            setProblem("");
            setDraft({ ...BLANK });
          }}>
            <Plus className="h-4 w-4" /> Register application
          </Button>
        }
      />

      <Card className="mb-4 p-3">
        <Input
          placeholder="Search by code or name…"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(1);
          }}
          aria-label="Search applications"
        />
      </Card>

      {error && <ErrorBanner error="Applications could not be loaded." />}

      <ResponsiveList
        data={data?.items ?? []}
        columns={columns}
        keyOf={(row) => row.code}
        loading={isLoading}
        onRowClick={(row) => navigate(`/admin/integrations/${row.code}`)}
        page={page}
        totalPages={totalPages}
        onPageChange={setPage}
        empty={
          <EmptyState
            title="No application is pulling from SCM yet"
            hint="Register the outside system, issue it a key, then build the endpoints it needs — any table in the database can be served."
          />
        }
        renderCard={(row) => (
          <Link to={`/admin/integrations/${row.code}`} className="block p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-ink">{row.code}</span>
              <StatusPill status={row.is_active ? "ACTIVE" : "INACTIVE"} />
            </div>
            <div className="mt-1 text-sm text-body">{row.name}</div>
            <div className="mt-1 text-xs text-muted">
              {row.active_keys} active {row.active_keys === 1 ? "key" : "keys"} ·{" "}
              {row.endpoints} {row.endpoints === 1 ? "endpoint" : "endpoints"} · last
              called {when(row.last_called_at)}
            </div>
          </Link>
        )}
      />

      <Modal isOpen={draft !== null} onClose={() => setDraft(null)} size="lg">
        <ModalContent>
          <ModalHeader className="font-display text-lg font-bold text-ink">
            <span className="flex items-center gap-2">
              <Plug className="h-5 w-5 text-brand" /> Register an application
            </span>
          </ModalHeader>
          <ModalBody>
            {draft && (
              <div className="space-y-3">
                {/* Inside the dialog, not on the page behind it. A banner rendered
                    under an open modal is invisible, so a rejected registration
                    looked like the button simply did nothing. */}
                {create.error && <ErrorBanner error={create.error} />}
                {problem && <ErrorBanner error={problem} />}
                <Field label="Code"
                       hint="Short, upper case. It is the identity — keys and endpoints are filed under it and it cannot be changed later.">
                  {/* Placeholders name no real system on purpose — this console
                      serves whatever gets connected, and an example that reads like
                      one of them suggests the screen is only for that one. */}
                  <Input value={draft.code} placeholder="e.g. BILLING"
                         onChange={(e) => setDraft({ ...draft, code: e.target.value })} />
                </Field>
                <Field label="Name">
                  <Input value={draft.name} placeholder="e.g. Billing system"
                         onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                </Field>
                <Field label="What it pulls, and why">
                  <Input value={draft.description ?? ""}
                         placeholder="e.g. Item master and stock on hand, to price jobs"
                         onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
                </Field>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Owner" hint="Who to call when it starts failing.">
                    <Input value={draft.contact_person ?? ""} placeholder="Name"
                           onChange={(e) => setDraft({ ...draft, contact_person: e.target.value })} />
                  </Field>
                  <Field label="Owner email">
                    <Input value={draft.contact_email ?? ""} placeholder="name@company.com"
                           onChange={(e) => setDraft({ ...draft, contact_email: e.target.value })} />
                  </Field>
                </div>
              </div>
            )}
          </ModalBody>
          <ModalFooter>
            <Button variant="subtle" onClick={() => setDraft(null)}>Cancel</Button>
            {/* Only ever disabled while the request is in flight. A button greyed out
                for a reason the screen does not state is indistinguishable from a
                broken one — so what is missing is said, on click, in a banner. */}
            <Button disabled={create.isPending} onClick={submit}>
              Register
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
}
