import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { procurementDemandPoolApi, procurementDemandPoolKeys } from "../api";
import type {
  DemandPoolGroup,
  DemandPoolSource,
  DemandPoolStage,
} from "../types";

const STAGE_TONE: Record<string, string> = {
  neutral: "#94a3b8",
  warning: "#f59e0b",
  info: "#3b82f6",
  success: "#10b981",
};

function toneColor(tone: string) {
  return STAGE_TONE[tone] ?? "#94a3b8";
}

function StagePill({
  stage,
  qty,
  stages,
  onClick,
}: {
  stage: string;
  qty: number;
  stages: DemandPoolStage[];
  onClick?: () => void;
}) {
  const meta = stages.find((s) => s.stage === stage);
  const color = meta ? toneColor(meta.tone) : "#94a3b8";
  return (
    <span
      onClick={onClick}
      title={meta?.hint ?? stage}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 10px",
        borderRadius: 20,
        fontSize: 12,
        fontWeight: 600,
        color: "#fff",
        background: color,
        cursor: onClick ? "pointer" : "default",
        whiteSpace: "nowrap",
      }}
    >
      {meta?.label ?? stage}
      <span style={{ opacity: 0.85, fontWeight: 400 }}>{qty}</span>
    </span>
  );
}

function SourceRow({
  source,
  stages,
}: {
  source: DemandPoolSource;
  stages: DemandPoolStage[];
}) {
  const nav = useNavigate();
  const meta = stages.find((s) => s.stage === source.stage);

  return (
    <tr
      style={{
        borderBottom: "1px solid rgba(255,255,255,0.05)",
        fontSize: 13,
      }}
    >
      <td style={{ padding: "8px 12px", color: "#60a5fa", whiteSpace: "nowrap" }}>
        <button
          onClick={() => nav(`/indents/${source.indent_id}`)}
          style={{
            background: "none",
            border: "none",
            color: "#60a5fa",
            cursor: "pointer",
            fontWeight: 600,
            textDecoration: "underline",
            fontSize: 13,
          }}
        >
          {source.indent_no}
        </button>
      </td>
      <td style={{ padding: "8px 12px", color: "#cbd5e1" }}>
        {source.owed_qty} {source.uom_code}
      </td>
      <td style={{ padding: "8px 12px" }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {Object.entries(source.stages).map(([st, qty]) => (
            <StagePill key={st} stage={st} qty={qty} stages={stages} />
          ))}
        </div>
      </td>
      <td style={{ padding: "8px 12px", color: "#94a3b8", fontSize: 12 }}>
        {source.department_name ?? "—"}
      </td>
      <td style={{ padding: "8px 12px", color: "#94a3b8", fontSize: 12 }}>
        {source.required_date ?? "—"}
      </td>
      <td style={{ padding: "8px 12px" }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {source.docs.slice(0, 3).map((doc, i) => (
            <button
              key={i}
              onClick={() => nav(meta?.deep_link ?? "#")}
              style={{
                background: "rgba(59,130,246,0.15)",
                border: "1px solid rgba(59,130,246,0.4)",
                borderRadius: 6,
                color: "#60a5fa",
                fontSize: 11,
                padding: "2px 8px",
                cursor: "pointer",
              }}
            >
              {doc.kind} #{doc.id}
            </button>
          ))}
        </div>
      </td>
    </tr>
  );
}

function GroupRow({
  group,
  stages,
}: {
  group: DemandPoolGroup;
  stages: DemandPoolStage[];
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <tr
        onClick={() => setExpanded((e) => !e)}
        style={{
          cursor: "pointer",
          background: expanded
            ? "rgba(59,130,246,0.08)"
            : "rgba(255,255,255,0.02)",
          borderBottom: "1px solid rgba(255,255,255,0.06)",
          transition: "background 0.15s",
        }}
      >
        <td style={{ padding: "12px 16px", width: 32 }}>
          <span
            style={{
              display: "inline-block",
              transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
              transition: "transform 0.2s",
              color: "#60a5fa",
              fontSize: 14,
            }}
          >
            ▶
          </span>
        </td>
        <td style={{ padding: "12px 16px" }}>
          <div style={{ fontWeight: 600, color: "#e2e8f0", fontSize: 14 }}>
            {group.item_name}
          </div>
          <div style={{ color: "#64748b", fontSize: 12, marginTop: 2 }}>
            {group.item_code}
          </div>
        </td>
        <td style={{ padding: "12px 16px", color: "#94a3b8", fontSize: 13 }}>
          {group.total_qty} {group.uom_code}
        </td>
        <td style={{ padding: "12px 16px" }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {Object.entries(group.stage_summary).map(([st, qty]) => (
              <StagePill key={st} stage={st} qty={qty} stages={stages} />
            ))}
          </div>
        </td>
        <td
          style={{ padding: "12px 16px", color: "#64748b", fontSize: 12 }}
        >
          {group.indent_count} indent{group.indent_count !== 1 ? "s" : ""}
        </td>
        <td
          style={{ padding: "12px 16px", color: "#64748b", fontSize: 12 }}
        >
          {group.earliest_required ?? "—"}
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={6} style={{ padding: 0 }}>
            <div
              style={{
                background: "rgba(0,0,0,0.25)",
                borderBottom: "2px solid rgba(59,130,246,0.2)",
              }}
            >
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: "rgba(255,255,255,0.03)" }}>
                    {[
                      "Indent",
                      "Owed Qty",
                      "Stage",
                      "Department",
                      "Required",
                      "Documents",
                    ].map((h) => (
                      <th
                        key={h}
                        style={{
                          padding: "6px 12px",
                          color: "#64748b",
                          fontSize: 11,
                          fontWeight: 600,
                          textAlign: "left",
                          letterSpacing: 0.5,
                        }}
                      >
                        {h.toUpperCase()}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {group.sources.map((src) => (
                    <SourceRow
                      key={src.indent_item_id}
                      source={src}
                      stages={stages}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export default function ProcurementDemandPoolPage() {
  const [params, setParams] = useSearchParams();
  const activeStage = params.get("stage") ?? undefined;
  const search = params.get("search") ?? "";
  const page = parseInt(params.get("page") ?? "1");
  const PAGE_SIZE = 50;

  const stagesQ = useQuery({
    queryKey: procurementDemandPoolKeys.stages(),
    queryFn: ({ signal }) => procurementDemandPoolApi.stages(signal),
    staleTime: 5 * 60_000,
  });

  const poolQ = useQuery({
    queryKey: procurementDemandPoolKeys.pool({ activeStage, search, page }),
    queryFn: ({ signal }) =>
      procurementDemandPoolApi.pool(
        { stage: activeStage, search: search || undefined, page, size: PAGE_SIZE },
        signal
      ),
    placeholderData: (prev) => prev,
  });

  const stages: DemandPoolStage[] = stagesQ.data ?? [];
  const data = poolQ.data;

  function setStage(s: string | undefined) {
    const next = new URLSearchParams(params);
    if (s) next.set("stage", s);
    else next.delete("stage");
    next.set("page", "1");
    setParams(next);
  }

  function setSearch(v: string) {
    const next = new URLSearchParams(params);
    if (v) next.set("search", v);
    else next.delete("search");
    next.set("page", "1");
    setParams(next);
  }

  function setPage(p: number) {
    const next = new URLSearchParams(params);
    next.set("page", String(p));
    setParams(next);
  }

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 1;

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "linear-gradient(135deg,#0f172a 0%,#1e293b 100%)",
        fontFamily: "'Inter','Segoe UI',sans-serif",
        color: "#e2e8f0",
        padding: "24px 32px",
      }}
    >
      {/* ── Header ── */}
      <div style={{ marginBottom: 28 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
          <span
            style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              background: "linear-gradient(135deg,#3b82f6,#6366f1)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 18,
            }}
          >
            📦
          </span>
          <div>
            <h1
              style={{
                margin: 0,
                fontSize: 22,
                fontWeight: 700,
                color: "#f1f5f9",
                letterSpacing: -0.3,
              }}
            >
              Procurement Demand Pool
            </h1>
            <p style={{ margin: 0, color: "#64748b", fontSize: 13 }}>
              Every outstanding indent quantity, where it sits in the buying chain
            </p>
          </div>
        </div>
      </div>

      {/* ── KPI Strip ── */}
      <div
        style={{
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
          marginBottom: 24,
        }}
      >
        {/* All tile */}
        <button
          onClick={() => setStage(undefined)}
          style={{
            padding: "12px 20px",
            borderRadius: 12,
            border: `2px solid ${!activeStage ? "#3b82f6" : "rgba(255,255,255,0.1)"}`,
            background: !activeStage
              ? "rgba(59,130,246,0.15)"
              : "rgba(255,255,255,0.04)",
            cursor: "pointer",
            color: !activeStage ? "#60a5fa" : "#94a3b8",
            textAlign: "left",
            minWidth: 110,
            transition: "all 0.15s",
          }}
        >
          <div style={{ fontSize: 22, fontWeight: 700 }}>
            {data?.indent_count ?? "—"}
          </div>
          <div style={{ fontSize: 11, opacity: 0.8, marginTop: 2 }}>
            All Indents
          </div>
        </button>

        {stages.map((s) => {
          const qty = data?.stage_totals?.[s.stage] ?? 0;
          const active = activeStage === s.stage;
          const color = toneColor(s.tone);
          return (
            <button
              key={s.stage}
              onClick={() => setStage(active ? undefined : s.stage)}
              title={s.hint}
              style={{
                padding: "12px 20px",
                borderRadius: 12,
                border: `2px solid ${active ? color : "rgba(255,255,255,0.1)"}`,
                background: active
                  ? `${color}22`
                  : "rgba(255,255,255,0.04)",
                cursor: "pointer",
                color: active ? color : "#94a3b8",
                textAlign: "left",
                minWidth: 110,
                transition: "all 0.15s",
              }}
            >
              <div style={{ fontSize: 22, fontWeight: 700 }}>
                {qty}
              </div>
              <div style={{ fontSize: 11, opacity: 0.8, marginTop: 2 }}>
                {s.label}
              </div>
            </button>
          );
        })}
      </div>

      {/* ── Search ── */}
      <div style={{ marginBottom: 20, display: "flex", gap: 12, alignItems: "center" }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search item or indent…"
          style={{
            flex: 1,
            maxWidth: 380,
            padding: "10px 16px",
            borderRadius: 10,
            border: "1px solid rgba(255,255,255,0.12)",
            background: "rgba(255,255,255,0.06)",
            color: "#e2e8f0",
            fontSize: 14,
            outline: "none",
          }}
        />
        {(poolQ.isFetching) && (
          <span style={{ color: "#64748b", fontSize: 13 }}>Loading…</span>
        )}
        {data && (
          <span style={{ color: "#64748b", fontSize: 13 }}>
            {data.group_count} item group{data.group_count !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {/* ── Table ── */}
      <div
        style={{
          borderRadius: 16,
          overflow: "hidden",
          border: "1px solid rgba(255,255,255,0.08)",
          background: "rgba(255,255,255,0.02)",
          boxShadow: "0 4px 32px rgba(0,0,0,0.4)",
        }}
      >
        {!data || data.groups.length === 0 ? (
          <div
            style={{
              padding: "64px 32px",
              textAlign: "center",
              color: "#475569",
            }}
          >
            {poolQ.isLoading
              ? "Loading demand pool…"
              : "No outstanding demand in this pool."}
          </div>
        ) : (
          <table
            style={{ width: "100%", borderCollapse: "collapse" }}
          >
            <thead>
              <tr
                style={{
                  background: "rgba(255,255,255,0.04)",
                  borderBottom: "1px solid rgba(255,255,255,0.08)",
                }}
              >
                {["", "Item", "Total Qty", "Stage Breakdown", "Indents", "Earliest Required"].map(
                  (h) => (
                    <th
                      key={h}
                      style={{
                        padding: "12px 16px",
                        color: "#475569",
                        fontSize: 11,
                        fontWeight: 700,
                        textAlign: "left",
                        letterSpacing: 0.8,
                      }}
                    >
                      {h.toUpperCase()}
                    </th>
                  )
                )}
              </tr>
            </thead>
            <tbody>
              {data.groups.map((g) => (
                <GroupRow key={g.item_id} group={g} stages={stages} />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Pagination ── */}
      {totalPages > 1 && (
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            gap: 8,
            marginTop: 24,
          }}
        >
          <button
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
            style={{
              padding: "8px 18px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.12)",
              background: "rgba(255,255,255,0.06)",
              color: "#94a3b8",
              cursor: page > 1 ? "pointer" : "default",
              opacity: page > 1 ? 1 : 0.4,
            }}
          >
            Previous
          </button>
          <span
            style={{
              padding: "8px 18px",
              color: "#64748b",
              fontSize: 13,
              alignSelf: "center",
            }}
          >
            Page {page} of {totalPages}
          </span>
          <button
            disabled={page >= totalPages}
            onClick={() => setPage(page + 1)}
            style={{
              padding: "8px 18px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.12)",
              background: "rgba(255,255,255,0.06)",
              color: "#94a3b8",
              cursor: page < totalPages ? "pointer" : "default",
              opacity: page < totalPages ? 1 : 0.4,
            }}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
