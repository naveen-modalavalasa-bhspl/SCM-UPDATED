import { mastersApi } from "../api";
import { MasterCrud } from "../components/MasterCrud";
import type { FormField, Option } from "../components/MasterCrud";
import type { MasterBrandModel, MasterBrandVariant } from "../types";
import { Select } from "@/shared/components";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Boxes, ChevronRight, Layers, Tag, X } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { Active, Code } from "./common";
import { BrandsTab } from "./itemTabs";

/** Brand → Variant → Model, one master each, under one Brands tab.
 *
 *  The sub-tab lives in the URL (`?tab=brands&sub=variants`) so a link or a reload
 *  lands on the same screen. Each child screen opens with a filter strip naming the
 *  parent it is showing, and its form asks for the parent FIRST — the code is only
 *  unique within that parent, so the parent is what gives the code its meaning. */

type Sub = "brands" | "variants" | "models";

/** A child code: up to 20 letters/digits with internal hyphens, unique in its parent. */
const CHILD_CODE: Pick<FormField, "maxLength" | "pattern" | "patternMessage"> = {
  maxLength: 20,
  pattern: /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/,
  patternMessage: "Use letters, numbers and internal hyphens only, e.g. ACT or GUIDE-ME",
};

const LIST_SIZE = 500;

/** Every brand-family query, so a save on one screen refreshes the others' lists,
 *  dropdowns and the counts on the switch. */
function useRefreshFamily() {
  const qc = useQueryClient();
  return <R,>(result: R) => {
    qc.invalidateQueries({
      predicate: (q) => q.queryKey[0] === "masters"
        && typeof q.queryKey[1] === "string"
        && (q.queryKey[1] === "brands" || q.queryKey[1].startsWith("brand-")),
    });
    return result;
  };
}

function useBrands() {
  return useQuery({
    queryKey: ["masters", "brand-family", "brands"],
    queryFn: () => mastersApi.brands.list({ size: LIST_SIZE }).then((r) => r.items),
  });
}

function useVariants() {
  return useQuery({
    queryKey: ["masters", "brand-family", "variants"],
    queryFn: () => mastersApi.brandVariants.list({ size: LIST_SIZE }).then((r) => r.items),
  });
}

function useModels() {
  return useQuery({
    queryKey: ["masters", "brand-family", "models"],
    queryFn: () => mastersApi.brandModels.list({ size: LIST_SIZE }).then((r) => r.items),
  });
}

/** The parent chain of a row, as a quiet breadcrumb. */
function Lineage({ parts }: { parts: (string | null | undefined)[] }) {
  const shown = parts.filter(Boolean) as string[];
  return (
    <span className="inline-flex flex-wrap items-center gap-1 text-sm">
      {shown.map((part, i) => (
        <span key={i} className="inline-flex items-center gap-1">
          {i > 0 && <ChevronRight className="h-3.5 w-3.5 text-muted" aria-hidden />}
          <span className={i === shown.length - 1 ? "font-medium text-ink" : "text-muted"}>
            {part}
          </span>
        </span>
      ))}
    </span>
  );
}

const SUBS: { key: Sub; label: string; hint: string; icon: typeof Tag }[] = [
  { key: "brands", label: "Brands", hint: "Who makes it", icon: Tag },
  { key: "variants", label: "Variants", hint: "Lines within a brand", icon: Layers },
  { key: "models", label: "Models", hint: "Models within a variant", icon: Boxes },
];

/** Masters › Brands: a three-way switch over Brands, Variants and Models. */
export function BrandFamilyTab() {
  const [params, setParams] = useSearchParams();
  const raw = params.get("sub");
  const sub: Sub = raw === "variants" || raw === "models" ? raw : "brands";
  const brands = useBrands();
  const variants = useVariants();
  const models = useModels();
  const counts: Record<Sub, number | undefined> = {
    brands: brands.data?.length,
    variants: variants.data?.length,
    models: models.data?.length,
  };

  const go = (next: Sub, extra: Record<string, string> = {}) => {
    const p = new URLSearchParams(params);
    p.delete("brand"); p.delete("variant");
    if (next === "brands") p.delete("sub"); else p.set("sub", next);
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    setParams(p, { replace: true });
  };

  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="Brand masters"
           className="grid grid-cols-3 gap-1 rounded-2xl border border-line bg-surface p-1 shadow-sm">
        {SUBS.map(({ key, label, hint, icon: Icon }) => {
          const on = key === sub;
          return (
            <button key={key} type="button" role="tab" aria-selected={on}
              onClick={() => go(key)}
              className={`group flex min-h-[44px] items-center gap-3 rounded-xl px-3 py-2 text-left transition-all duration-200 ${
                on ? "bg-brand text-white shadow-md"
                   : "text-body hover:bg-default"}`}>
              <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg transition-colors ${
                on ? "bg-white/20" : "bg-default text-brand group-hover:bg-surface"}`}>
                <Icon className="h-4 w-4" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-sm font-semibold">
                  {label}
                  {counts[key] !== undefined && (
                    <span className={`rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums ${
                      on ? "bg-white/25 text-white" : "bg-default text-muted"}`}>
                      {counts[key]}
                    </span>
                  )}
                </span>
                <span className={`hidden truncate text-xs sm:block ${on ? "text-white/80" : "text-muted"}`}>
                  {hint}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {sub === "brands" && <BrandsTab />}
      {sub === "variants" && <VariantsTab onOpenModels={(v) =>
        go("models", { brand: String(v.brand_id), variant: String(v.id) })} />}
      {sub === "models" && <ModelsTab />}
    </div>
  );
}

/** The strip above a child list: which parent(s) the list is narrowed to. */
function FilterStrip({ children, active, onClear, summary }: {
  children: React.ReactNode; active: boolean; onClear: () => void; summary: string;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-3 shadow-sm sm:flex-row sm:items-center">
      <div className="flex flex-1 flex-col gap-3 sm:flex-row">{children}</div>
      <div className="flex items-center justify-between gap-3 sm:justify-end">
        <span className="text-xs text-muted">{summary}</span>
        {active && (
          <button type="button" onClick={onClear}
            className="inline-flex min-h-[44px] items-center gap-1 rounded-lg px-3 text-sm font-medium text-brand hover:bg-default">
            <X className="h-4 w-4" aria-hidden /> Clear
          </button>
        )}
      </div>
    </div>
  );
}

function useFilterParam(key: string): [number | "", (v: string) => void] {
  const [params, setParams] = useSearchParams();
  const value = Number(params.get(key)) || "";
  const set = (v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set(key, v); else p.delete(key);
    if (key === "brand") p.delete("variant");      // a variant belongs to one brand
    setParams(p, { replace: true });
  };
  return [value, set];
}

const brandOptions = (rows: { id: number; code: string; name: string; is_active: boolean }[] = []): Option[] =>
  rows.filter((b) => b.is_active).map((b) => ({ value: b.id, label: `${b.name} (${b.code})` }));

function VariantsTab({ onOpenModels }: { onOpenModels: (v: MasterBrandVariant) => void }) {
  const api = mastersApi.brandVariants;
  const refresh = useRefreshFamily();
  const brands = useBrands();
  const models = useModels();
  const [brandId, setBrandId] = useFilterParam("brand");
  const brandOpts = brandOptions(brands.data);
  const modelCount = new Map<number, number>();
  for (const m of models.data ?? []) modelCount.set(m.variant_id, (modelCount.get(m.variant_id) ?? 0) + 1);
  const brandName = brands.data?.find((b) => b.id === brandId)?.name;

  return (
    <div className="space-y-4">
      <FilterStrip active={!!brandId} onClear={() => setBrandId("")}
        summary={brandName ? `Showing variants of ${brandName}` : "Showing every brand's variants"}>
        <div className="sm:w-80">
          <Select ariaLabel="Filter by brand" placeholder="All brands" value={brandId}
            options={[{ value: "", label: "All brands" }, ...brandOpts]} onChange={setBrandId} />
        </div>
      </FilterStrip>

      <MasterCrud<MasterBrandVariant>
        key={`variants-${brandId}`}
        title="Variant" queryKey={`brand-variants${brandId ? `:${brandId}` : ""}`}
        searchable managePerm="master.brand.manage"
        formTitle={(v, editing) => {
          const b = brands.data?.find((x) => x.id === Number(v.brand_id))?.name;
          return `${editing ? "Edit" : "New"} variant${b ? ` · ${b}` : ""}`;
        }}
        columns={[
          { key: "brand", header: "Brand", render: (r) => <Lineage parts={[r.brand_name]} /> },
          { key: "code", header: "Code", render: (r) => <Code>{r.code}</Code> },
          { key: "name", header: "Variant", render: (r) => <span className="font-medium text-ink">{r.name}</span> },
          { key: "models", header: "Models", hideOnNarrow: true, render: (r) => {
            const n = modelCount.get(r.id) ?? 0;
            return (
              <button type="button"
                onClick={(e) => { e.stopPropagation(); onOpenModels(r); }}
                className="inline-flex min-h-[32px] items-center gap-1 rounded-full bg-default px-2.5 text-xs font-semibold text-body hover:text-brand">
                {n} {n === 1 ? "model" : "models"} <ChevronRight className="h-3 w-3" aria-hidden />
              </button>
            );
          } },
          { key: "active", header: "Status", render: (r) => <Active on={r.is_active} /> },
        ]}
        renderCard={(r) => (
          <div className="space-y-1">
            <div className="flex items-center justify-between"><Code>{r.code}</Code><Active on={r.is_active} /></div>
            <Lineage parts={[r.brand_name, r.name]} />
            <div className="text-xs text-muted">{modelCount.get(r.id) ?? 0} models</div>
          </div>
        )}
        fetchList={(search) => api.list({ search, size: LIST_SIZE, ...(brandId ? { brand_id: brandId } : {}) })
          .then((p) => p.items)}
        fields={[
          { key: "brand_id", label: "Brand", type: "select", required: true, options: brandOpts,
            placeholder: "Choose the brand first", hint: "The variant code only has to be unique within this brand." },
          { key: "name", label: "Variant name", required: true, maxLength: 200, placeholder: "e.g. Active" },
          { key: "code", label: "Variant code", required: true, ...CHILD_CODE, placeholder: "e.g. ACT" },
          { key: "description", label: "Description", maxLength: 300 },
          { key: "is_active", label: "Active", type: "switch" },
        ]}
        emptyForm={{ brand_id: brandId, name: "", code: "", description: "", is_active: true }}
        toForm={(r) => ({ brand_id: r.brand_id, name: r.name, code: r.code,
          description: r.description ?? "", is_active: r.is_active })}
        bulk={api} usage={api.usage}
        onCreate={(v) => api.create(v as Partial<MasterBrandVariant>).then(refresh)}
        onUpdate={(id, v) => api.update(id, v as Partial<MasterBrandVariant>).then(refresh)}
        onDeactivate={(id) => api.deactivate(id).then(refresh)}
      />
    </div>
  );
}

function ModelsTab() {
  const api = mastersApi.brandModels;
  const refresh = useRefreshFamily();
  const brands = useBrands();
  const variants = useVariants();
  const [brandId, setBrandId] = useFilterParam("brand");
  const [variantId, setVariantId] = useFilterParam("variant");
  const brandOpts = brandOptions(brands.data);
  const variantsOf = (bid: unknown): Option[] => (variants.data ?? [])
    .filter((v) => v.is_active && v.brand_id === Number(bid))
    .map((v) => ({ value: v.id, label: `${v.name} (${v.code})` }));
  const filterVariantOpts = variantsOf(brandId);
  const brandName = brands.data?.find((b) => b.id === brandId)?.name;
  const variantName = variants.data?.find((v) => v.id === variantId)?.name;
  const filter = { ...(brandId ? { brand_id: brandId } : {}), ...(variantId ? { variant_id: variantId } : {}) };

  return (
    <div className="space-y-4">
      <FilterStrip active={!!brandId} onClear={() => setBrandId("")}
        summary={variantName ? `Showing models of ${brandName} › ${variantName}`
          : brandName ? `Showing models of ${brandName}` : "Showing every model"}>
        <div className="sm:w-72">
          <Select ariaLabel="Filter by brand" placeholder="All brands" value={brandId}
            options={[{ value: "", label: "All brands" }, ...brandOpts]} onChange={setBrandId} />
        </div>
        <div className="sm:w-72">
          <Select ariaLabel="Filter by variant" value={variantId} isDisabled={!brandId}
            placeholder={brandId ? "All variants" : "Pick a brand first"}
            options={[{ value: "", label: "All variants" }, ...filterVariantOpts]} onChange={setVariantId} />
        </div>
      </FilterStrip>

      <MasterCrud<MasterBrandModel>
        key={`models-${brandId}-${variantId}`}
        title="Model" queryKey={`brand-models:${brandId || "all"}:${variantId || "all"}`}
        searchable managePerm="master.brand.manage"
        formTitle={(v, editing) => {
          const b = brands.data?.find((x) => x.id === Number(v.brand_id))?.name;
          const vn = variants.data?.find((x) => x.id === Number(v.variant_id))?.name;
          return `${editing ? "Edit" : "New"} model${b ? ` · ${b}` : ""}${vn ? ` › ${vn}` : ""}`;
        }}
        columns={[
          { key: "lineage", header: "Brand › Variant",
            render: (r) => <Lineage parts={[r.brand_name, r.variant_name]} /> },
          { key: "code", header: "Code", render: (r) => <Code>{r.code}</Code> },
          { key: "name", header: "Model", render: (r) => <span className="font-medium text-ink">{r.name}</span> },
          { key: "active", header: "Status", render: (r) => <Active on={r.is_active} /> },
        ]}
        renderCard={(r) => (
          <div className="space-y-1">
            <div className="flex items-center justify-between"><Code>{r.code}</Code><Active on={r.is_active} /></div>
            <Lineage parts={[r.brand_name, r.variant_name, r.name]} />
          </div>
        )}
        fetchList={(search) => api.list({ search, size: LIST_SIZE, ...filter }).then((p) => p.items)}
        fields={(values) => {
          const opts = variantsOf(values.brand_id);
          return [
            { key: "brand_id", label: "Brand", type: "select", required: true, options: brandOpts,
              placeholder: "Choose the brand first", clearOnChange: ["variant_id"] },
            { key: "variant_id", label: "Variant", type: "select", required: true, options: opts,
              placeholder: values.brand_id ? "Choose the variant" : "Pick a brand first",
              hint: !values.brand_id ? "Variants are listed once a brand is chosen."
                : opts.length ? "The model code only has to be unique within this variant."
                : "This brand has no active variants yet. Add one under Variants first." },
            { key: "name", label: "Model name", required: true, maxLength: 200, placeholder: "e.g. Guide Me" },
            { key: "code", label: "Model code", required: true, ...CHILD_CODE, placeholder: "e.g. GUIDE-ME" },
            { key: "description", label: "Description", maxLength: 300 },
            { key: "is_active", label: "Active", type: "switch" },
          ];
        }}
        emptyForm={{ brand_id: brandId, variant_id: variantId, name: "", code: "",
                     description: "", is_active: true }}
        toForm={(r) => ({ brand_id: r.brand_id, variant_id: r.variant_id, name: r.name,
          code: r.code, description: r.description ?? "", is_active: r.is_active })}
        bulk={api} usage={api.usage}
        onCreate={(v) => api.create(v as Partial<MasterBrandModel>).then(refresh)}
        onUpdate={(id, v) => api.update(id, v as Partial<MasterBrandModel>).then(refresh)}
        onDeactivate={(id) => api.deactivate(id).then(refresh)}
      />
    </div>
  );
}
