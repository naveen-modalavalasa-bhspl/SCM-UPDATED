import { mastersApi } from "../api";
import { MasterCrud } from "../components/MasterCrud";
import type { Option } from "../components/MasterCrud";
import type { CategoryTagType, MasterAttribute, MasterCategoryTag, MasterFeature, MasterPackaging, MasterSpec } from "../types";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Active, Code } from "./common";
import { DATA_TYPES } from "./constants";


export function FeaturesTab() {
  return (
    <MasterCrud<MasterFeature>
      title="Feature" queryKey="features" searchable managePerm="master.feature.manage"
      columns={[
        { key: "code", header: "Code", render: (r) => <Code>{r.code}</Code> },
        { key: "name", header: "Name", render: (r) => r.name },
        { key: "handling", header: "Handling", hideOnNarrow: true,
          render: (r) => r.affects_handling
            ? <span className="rounded-full bg-warn-bg px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-warn">Affects handling</span>
            : "—" },
        { key: "active", header: "Status", render: (r) => <Active on={r.is_active} /> },
      ]}
      renderCard={(r) => (
        <div className="flex items-center justify-between">
          <div><Code>{r.code}</Code><div className="text-sm text-body">{r.name}</div></div>
          <Active on={r.is_active} />
        </div>
      )}
      fetchList={(search) => mastersApi.features.list({ search, size: 200 }).then((p) => p.items)}
      fields={[
        { key: "code", label: "Code", required: true },
        { key: "name", label: "Name", required: true },
        { key: "description", label: "Description" },
        { key: "affects_handling", label: "Affects handling", type: "switch" },
        { key: "is_active", label: "Active", type: "switch" },
      ]}
      emptyForm={{ code: "", name: "", description: "", affects_handling: false, is_active: true }}
      toForm={(r) => ({ code: r.code, name: r.name, description: r.description ?? "",
        affects_handling: r.affects_handling, is_active: r.is_active })}
      bulk={mastersApi.features}
      onCreate={(v) => mastersApi.features.create(v as Partial<MasterFeature>)}
      onUpdate={(id, v) => mastersApi.features.update(id, v as Partial<MasterFeature>)}
      onDeactivate={mastersApi.features.deactivate}
    />
  );
}

export function PackagingTab() {
  return (
    <>
      <div className="mb-3 rounded-xl bg-content2 px-4 py-3 text-sm text-muted">
        Maintain reusable <strong className="text-body">container types</strong> such
        as Packet, Box and Tanker. Capacity is configured per item on its Packaging
        tab because the same container type can hold different products and units.
      </div>
      <MasterCrud<MasterPackaging>
        title="Package" queryKey="packaging" searchable
        managePerm="master.packaging.manage"
        columns={[
          { key: "code", header: "Code", render: (r) => <Code>{r.code}</Code> },
          { key: "name", header: "Name", render: (r) => r.name },
          { key: "active", header: "Status", render: (r) => <Active on={r.is_active} /> },
        ]}
        renderCard={(r) => (
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Code>{r.code}</Code><Active on={r.is_active} />
            </div>
            <div className="text-sm text-body">{r.name}</div>
          </div>
        )}
        fetchList={(search) => mastersApi.packaging.list({ search, size: 200 }).then((p) => p.items)}
        fields={[
          { key: "code", label: "Code", required: true, maxLength: 50,
            pattern: /^[A-Za-z0-9-]+$/,
            patternMessage: "Use letters, numbers or a hyphen" },
          { key: "name", label: "Container type", required: true, maxLength: 200 },
          { key: "is_active", label: "Active", type: "switch" },
        ]}
        emptyForm={{ code: "", name: "", is_active: true }}
        toForm={(r) => ({ code: r.code, name: r.name, is_active: r.is_active })}
        bulk={mastersApi.packaging}
        onCreate={(v) => mastersApi.packaging.create(v as Partial<MasterPackaging>)}
        onUpdate={(id, v) => mastersApi.packaging.update(id, v as Partial<MasterPackaging>)}
        onDeactivate={mastersApi.packaging.deactivate}
      />
    </>
  );
}

export function AttributesTab({ uoms }: { uoms: Option[] }) {
  return (
    <>
      <div className="mb-3 rounded-xl bg-content2 px-4 py-3 text-sm text-muted">
        An attribute is a <strong className="text-body">selectable trait</strong> —
        colour, material, grade. Something you measure, with a unit, is a
        <strong className="text-body"> Spec</strong>. Both are attached to categories
        on the Category Tagging tab.
      </div>
      <MasterCrud<MasterAttribute>
        title="Attribute" queryKey="attributes" searchable
        managePerm="master.attribute.manage"
        columns={[
          { key: "code", header: "Code", render: (r) => <Code>{r.code}</Code> },
          { key: "name", header: "Name", render: (r) => r.name },
          { key: "type", header: "Type", render: (r) => r.data_type },
          { key: "uom", header: "Unit", hideOnNarrow: true, render: (r) => r.uom_code ?? "—" },
          { key: "opts", header: "Options", hideOnNarrow: true,
            render: (r) => r.allowed_values?.length ? r.allowed_values.join(", ") : "—" },
          { key: "active", header: "Status", render: (r) => <Active on={r.is_active} /> },
        ]}
        renderCard={(r) => (
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Code>{r.code}</Code><Active on={r.is_active} />
            </div>
            <div className="text-sm text-body">{r.name}</div>
            <div className="text-xs text-muted">
              {r.data_type}{r.uom_code ? " \u00b7 " + r.uom_code : ""}
            </div>
          </div>
        )}
        fetchList={(search) => mastersApi.attributes.list({ search, size: 200 }).then((p) => p.items)}
        fields={[
          { key: "code", label: "Code", required: true, maxLength: 50,
            pattern: /^[A-Za-z0-9_]+$/,
            patternMessage: "Use letters, numbers or an underscore" },
          { key: "name", label: "Name", required: true, maxLength: 200 },
          { key: "data_type", label: "Type", type: "select", options: DATA_TYPES },
          // A real UOM row, not free text: "kg", "Kg" and "kilogram" used to be
          // three different units nothing could reconcile.
          { key: "uom_id", label: "Unit", type: "select", options: uoms },
          { key: "allowed_values_text", label: "Options for LIST, comma separated",
            validate: (value, all) => all.data_type === "LIST" && !String(value ?? "").trim()
              ? "A LIST attribute needs at least one option" : null },
          { key: "description", label: "Description", maxLength: 300 },
          { key: "is_active", label: "Active", type: "switch" },
        ]}
        emptyForm={{ code: "", name: "", data_type: "TEXT", uom_id: null,
                     allowed_values_text: "", description: "", is_active: true }}
        toForm={(r) => ({ code: r.code, name: r.name, data_type: r.data_type,
          uom_id: r.uom_id ?? null,
          allowed_values_text: (r.allowed_values ?? []).join(", "),
          description: r.description ?? "", is_active: r.is_active })}
        // The form takes a comma-separated string; the API wants a list.
        bulk={mastersApi.attributes}
        onCreate={(v) => mastersApi.attributes.create(toAttributePayload(v))}
        onUpdate={(id, v) => mastersApi.attributes.update(id, toAttributePayload(v))}
        onDeactivate={mastersApi.attributes.deactivate}
      />
    </>
  );
}

export function toAttributePayload(v: Record<string, unknown>): Partial<MasterAttribute> {
  const raw = String(v.allowed_values_text ?? "").trim();
  return {
    code: String(v.code ?? ""),
    name: String(v.name ?? ""),
    data_type: v.data_type as MasterAttribute["data_type"],
    uom_id: v.uom_id == null ? null : Number(v.uom_id),
    allowed_values: raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [],
    description: (v.description as string) || null,
    is_active: Boolean(v.is_active),
  };
}

export function SpecsTab({ uoms }: { uoms: Option[] }) {
  return (
    <>
      <div className="mb-3 rounded-xl bg-content2 px-4 py-3 text-sm text-muted">
        A spec is something you <strong className="text-body">measure</strong> —
        operating voltage in volts, capacity in litres. It always carries a unit.
        Attach it to a category, and mark it required, on Category Tagging.
      </div>
      <MasterCrud<MasterSpec>
        title="Spec" queryKey="specs" searchable managePerm="master.spec.manage"
        columns={[
          { key: "code", header: "Code", render: (r) => <Code>{r.code}</Code> },
          { key: "name", header: "Name", render: (r) => r.name },
          { key: "uom", header: "Measured in", render: (r) => r.uom_code ?? "—" },
          { key: "desc", header: "Description", hideOnNarrow: true,
            render: (r) => r.description ?? "—" },
          { key: "active", header: "Status", render: (r) => <Active on={r.is_active} /> },
        ]}
        renderCard={(r) => (
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Code>{r.code}</Code><Active on={r.is_active} />
            </div>
            <div className="text-sm text-body">{r.name}</div>
            <div className="text-xs text-muted">{r.uom_code ?? "no unit"}</div>
          </div>
        )}
        fetchList={(search) => mastersApi.specs.list({ search, size: 200 }).then((p) => p.items)}
        fields={[
          { key: "code", label: "Code", required: true, maxLength: 50,
            pattern: /^[A-Za-z0-9_]+$/,
            patternMessage: "Use letters, numbers or an underscore" },
          { key: "name", label: "Name", required: true, maxLength: 200 },
          { key: "uom_id", label: "Measured in", type: "select", options: uoms,
            required: true },
          { key: "description", label: "Description", maxLength: 300 },
          { key: "is_active", label: "Active", type: "switch" },
        ]}
        emptyForm={{ code: "", name: "", uom_id: null, description: "", is_active: true }}
        toForm={(r) => ({ code: r.code, name: r.name, uom_id: r.uom_id ?? null,
          description: r.description ?? "", is_active: r.is_active })}
        bulk={mastersApi.specs}
        onCreate={(v) => mastersApi.specs.create(v as Partial<MasterSpec>)}
        onUpdate={(id, v) => mastersApi.specs.update(id, v as Partial<MasterSpec>)}
        onDeactivate={mastersApi.specs.deactivate}
      />
    </>
  );
}

/** One screen for the three things a category expects of its items. Attributes,
 *  specs and features answer the same two questions — which one, and is it
 *  required — so they were three tabs doing one job. */

/** One screen for the three things a category expects of its items. Attributes,
 *  specs and features answer the same two questions — which one, and is it
 *  required — so they were three tabs doing one job. */
export function CategoryTaggingTab({ categories }: { categories: Option[] }) {
  const [tagType, setTagType] = useState<CategoryTagType>("ATTRIBUTE");

  const attributes = useQuery({
    queryKey: ["masters", "attributes", "all"],
    queryFn: () => mastersApi.attributes.list({ size: 300 }).then((p) => p.items),
  });
  const specs = useQuery({
    queryKey: ["masters", "specs", "all"],
    queryFn: () => mastersApi.specs.list({ size: 300 }).then((p) => p.items),
  });
  const features = useQuery({
    queryKey: ["masters", "features", "all"],
    queryFn: () => mastersApi.features.list({ size: 300 }).then((p) => p.items),
  });

  const source = { ATTRIBUTE: attributes.data, SPEC: specs.data,
                   FEATURE: features.data }[tagType] ?? [];
  const tagOpts: Option[] = source.map((r) => ({
    value: r.id, label: r.code + " — " + r.name,
  }));

  return (
    <>
      <div className="mb-3 rounded-xl bg-content2 px-4 py-3 text-sm text-muted">
        This says <strong className="text-body">what a category expects</strong> of its
        items. When someone creates an item in that category, these fields appear on
        the item form, and the required ones must be answered.
      </div>
      <MasterCrud<MasterCategoryTag>
        title="Category tag" queryKey="category-tags" searchable
        managePerm="master.attribute.manage"
        columns={[
          { key: "category", header: "Category",
            render: (r) => r.category_name ?? r.category_id },
          { key: "kind", header: "Kind", render: (r) => r.tag_type },
          { key: "tag", header: "Field", render: (r) => r.tag_name ?? r.tag_code },
          { key: "unit", header: "Unit", hideOnNarrow: true,
            render: (r) => r.tag_uom_code ?? "—" },
          { key: "req", header: "Required",
            render: (r) => (r.is_required ? "Yes" : "No") },
          { key: "active", header: "Status", render: (r) => <Active on={r.is_active} /> },
        ]}
        renderCard={(r) => (
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-ink">{r.tag_name}</span>
              <Active on={r.is_active} />
            </div>
            <div className="text-xs text-muted">
              {r.category_name} · {r.tag_type.toLowerCase()}
              {r.tag_uom_code ? " · " + r.tag_uom_code : ""}
              {r.is_required ? " · required" : ""}
            </div>
          </div>
        )}
        fetchList={(search) =>
          mastersApi.categoryTags.list({ search, size: 500 }).then((p) => p.items)}
        fields={[
          { key: "category_id", label: "Category", type: "select",
            options: categories, required: true },
          { key: "tag_type", label: "Kind of field", type: "select",
            options: [
              { value: "ATTRIBUTE", label: "Attribute — a selectable trait" },
              { value: "SPEC", label: "Spec — a measurement with a unit" },
              { value: "FEATURE", label: "Feature — a yes/no trait" },
            ],
            clearOnChange: ["tag_id"],
            onChange: (value) => setTagType((value || "ATTRIBUTE") as CategoryTagType) },
          { key: "tag_id", label: "Which one", type: "select", options: tagOpts,
            required: true },
          { key: "is_required", label: "Required on the item", type: "switch" },
          { key: "is_active", label: "Active", type: "switch" },
        ]}
        emptyForm={{ category_id: null, tag_type: tagType, tag_id: null,
                     is_required: false, is_active: true }}
        toForm={(r) => {
          // Keeps the "which one" dropdown showing the right master when an
          // existing row is opened for editing.
          setTagType(r.tag_type);
          return { category_id: r.category_id, tag_type: r.tag_type,
                   tag_id: r.tag_id, is_required: r.is_required,
                   is_active: r.is_active };
        }}
        bulk={mastersApi.categoryTags}
        onCreate={(v) => mastersApi.categoryTags.create(v as Partial<MasterCategoryTag>)}
        onUpdate={(id, v) =>
          mastersApi.categoryTags.update(id, v as Partial<MasterCategoryTag>)}
        onDeactivate={mastersApi.categoryTags.deactivate}
      />
      <div className="mt-3 text-xs text-muted">
        Showing {tagType.toLowerCase()}s in the “Which one” list. Change “Kind of
        field” in the form to switch.
      </div>
    </>
  );
}

/** Which items a user group may request. A group is defined by role or position in
 *  the RBAC module; this only decides its catalogue. */
