import type { BulkApi, MasterUsage } from "../api";
import { MasterCrud } from "../components/MasterCrud";
import type { NamedMaster } from "../types";
import type { Column } from "@/shared/components";
import { CODE_RULE } from "./constants";

export const Active = ({ on }: { on: boolean }) => (
  <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${
    on ? "bg-ok-bg text-ok" : "bg-default text-muted"
  }`}>
    <span className={`h-1.5 w-1.5 rounded-full ${on ? "bg-ok" : "bg-muted"}`} />
    {on ? "Active" : "Inactive"}
  </span>
);

export const Code = ({ children }: { children: React.ReactNode }) => (
  <span className="mono font-semibold text-ink">{children}</span>
);

/** A short item-identity code. Imported masters use segments such as GN-003. */



export function NamedLookupTab({
  title, queryKey, api, managePerm = "master.item.manage", codeRule = CODE_RULE,
}: {
  title: string;
  queryKey: string;
  managePerm?: string;
  /** The code's rule, when a master's codes are not the short item-identity kind. */
  codeRule?: { maxLength: number; pattern: RegExp; patternMessage: string };
  api: {
    list: (p?: {
      search?: string; page?: number; size?: number; include_inactive?: boolean;
      [filter: string]: string | number | boolean | undefined;
    }) => Promise<{ items: NamedMaster[] }>;
    create: (v: Partial<NamedMaster>) => Promise<NamedMaster>;
    update: (id: number, v: Partial<NamedMaster>) => Promise<NamedMaster>;
    deactivate: (id: number) => Promise<unknown>;
    usage: (id: number) => Promise<MasterUsage>;
  } & BulkApi;
}) {
  return <MasterCrud<NamedMaster>
    title={title} queryKey={queryKey} searchable managePerm={managePerm}
    columns={[
      { key: "code", header: "Code", render: (r) => <Code>{r.code}</Code> },
      { key: "name", header: "Name", render: (r) => r.name },
      { key: "active", header: "Status", render: (r) => <Active on={r.is_active} /> },
    ]}
    renderCard={(r) => <div><Code>{r.code}</Code><div>{r.name}</div></div>}
    fetchList={(search) => api.list({ search, size: 300 }).then((r) => r.items)}
    fields={[{key:"code",label:"Code",required:true,...codeRule},
      {key:"name",label:"Name",required:true,maxLength:200},
      {key:"description",label:"Description",maxLength:300},
      {key:"is_active",label:"Active",type:"switch"}]}
    emptyForm={{code:"",name:"",description:"",is_active:true}}
    toForm={(r)=>({code:r.code,name:r.name,description:r.description??"",is_active:r.is_active})}
bulk={api} usage={api.usage}
    onCreate={(v)=>api.create(v as Partial<NamedMaster>)}
    onUpdate={(id,v)=>api.update(id,v as Partial<NamedMaster>)}
    onDeactivate={api.deactivate}
  />;
}

/** Read-only HCM mirrors (rule 10 — sync owns those tables). */
export function ReadOnlyTab<T extends { id: number }>(
  { title, fetchList, columns, renderCard }: {
    title: string;
    fetchList: () => Promise<T[]>;
    columns: Column<T>[];
    renderCard: (r: T) => React.ReactNode;
  },
) {
  return (
    <MasterCrud<T>
      title={title} queryKey={title.toLowerCase().replace(/\s+/g, "-")}
      readOnly managePerm="" columns={columns} renderCard={renderCard}
      fetchList={fetchList} fields={[]} emptyForm={{}} toForm={() => ({})}
      onCreate={async () => undefined} onUpdate={async () => undefined}
    />
  );
}
