import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Checkbox } from "@heroui/react";
import Barcode from "react-barcode";
import { QRCodeSVG } from "qrcode.react";
import { AlertCircle, ArrowLeft, CheckCircle2, Package, Lock, PackagePlus, Printer, QrCode, Trash2, Truck, Unlock } from "lucide-react";
import { Button, Can, ErrorBanner, Field, Input, PageHeader, Select, StatusPill } from "@/shared/components";
import { MetaCard, MetaRow, Section } from "../components/DocumentMeta";
import { Lookup } from "../components/Lookup";
import { SerialNumbersModal } from "../components/SerialNumbersModal";
import {
  carrierOptions,
  createConsignment,
  getConsignment,
  getIssueDispatchSource,
  issueOptions,
  updateConsignment,
  vehicleOptions,
  vendorOptions,
  allWarehouseOptions,
} from "../api";
import { fmtMoney, fmtQty, num, today } from "../format";
import type {
  ConsignmentPackageItemWrite,
  ConsignmentPackageWrite,
  ConsignmentWrite,
  Dispatch,
  IssueDispatchSource,
  IssueDispatchSourceItem,
} from "../types";
import { usePointLabel } from "../usePointLabel";

const PACKAGE_TYPES = [
  { value: "BOX", label: "Box" },
  { value: "CARTON", label: "Carton" },
  { value: "PALLET", label: "Pallet" },
  { value: "DRUM", label: "Drum" },
  { value: "CRATE", label: "Crate" },
  { value: "BAG", label: "Bag" },
];

const DISPATCH_TYPES = [
  { value: "PROJECT", label: "To issue destination" },
  { value: "TRANSFER", label: "Stock transfer" },
  { value: "CUSTOMER", label: "To a customer" },
  { value: "VENDOR_RETURN", label: "Vendor return" },
];

const MODES = [
  { value: "ROAD", label: "Road" },
  { value: "RAIL", label: "Rail" },
  { value: "AIR", label: "Air" },
  { value: "SEA", label: "Sea" },
  { value: "COURIER", label: "Courier" },
];

type PackageDraft = ConsignmentPackageWrite & { key: string; locked?: boolean };
type SerialTarget = { packageIndex: number; line: IssueDispatchSourceItem } | null;

// `crypto.randomUUID` exists only in a secure context, so it is undefined for anyone
// reaching the app over plain http on the LAN. The key is a React list key inside one
// form — a counter is enough and works everywhere.
let packageKeySeq = 0;

const newPackage = (count: number): PackageDraft => ({
  key: `pkg-${(packageKeySeq += 1)}`,
  package_no: `PKG-${String(count + 1).padStart(2, "0")}`,
  package_type: "BOX",
  barcode: "",
  weight_kg: null,
  length_cm: null,
  width_cm: null,
  height_cm: null,
  is_fragile: false,
  is_temp_controlled: false,
  locked: false,
  items: [],
});

const lineKey = (line: Pick<IssueDispatchSourceItem, "item_id" | "batch_id">) =>
  `${line.item_id}:${line.batch_id ?? 0}`;

const itemLabel = (line: IssueDispatchSourceItem) =>
  `${line.item_code ?? line.item_id}${line.batch_no ? ` / ${line.batch_no}` : ""}`;

const packageQty = (line: Pick<ConsignmentPackageItemWrite, "quantity">) => num(line.quantity);

const destinationOf = (doc?: Dispatch | null, source?: IssueDispatchSource | null) =>
  source?.destination_office_name
  ?? doc?.destination_office_name
  ?? doc?.delivery_address
  ?? doc?.to_warehouse_name
  ?? doc?.customer_name
  ?? doc?.vendor_name
  ?? "";

/** The destination office's service area code. Only the office has one — the fallbacks
 *  `destinationOf` walks (delivery address, transfer target, customer, vendor) are not
 *  offices, so there is nothing to read a SAC off and it stays blank rather than
 *  showing a code that belongs to somewhere else. */
const destinationSacOf = (doc?: Dispatch | null, source?: IssueDispatchSource | null) =>
  source?.destination_office_sac ?? doc?.destination_office_sac ?? null;

type ScanCardSpec = {
  code: string;
  title: string;
  subtitle?: string;
  accent: "consignment" | "package";
  meta: { label: string; value: string | number | null | undefined }[];
};

function ScanCard({ spec }: { spec: ScanCardSpec }) {
  const accent = spec.accent === "consignment"
    ? "border-brand/40 bg-brand-050/30"
    : "border-line bg-content1";
  return (
    <div className={`rounded-lg border ${accent} p-4 shadow-sm`}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {spec.accent === "consignment" ? (
              <QrCode className="h-4 w-4 text-brand" />
            ) : (
              <Package className="h-4 w-4 text-brand" />
            )}
            <h3 className="truncate font-display text-base font-bold text-ink">{spec.title}</h3>
          </div>
          {spec.subtitle && <div className="mt-1 truncate text-xs text-muted">{spec.subtitle}</div>}
        </div>
        <div className="rounded-md bg-content1 px-2 py-1 font-mono text-[11px] font-semibold text-ink">
          {spec.code}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[128px_1fr]">
        <div className="flex justify-center rounded-lg border border-line bg-white p-3">
          <QRCodeSVG value={spec.code} size={108} level="M" />
        </div>
        <div className="min-w-0 rounded-lg border border-line bg-white p-3">
          <div className="overflow-hidden">
            <Barcode value={spec.code} height={54} width={1.35} fontSize={12} margin={0} displayValue />
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
            {spec.meta.map((row) => (
              <div key={row.label} className="min-w-0 rounded-md bg-content2 px-2 py-1">
                <dt className="truncate text-[10px] font-semibold uppercase text-muted">{row.label}</dt>
                <dd className="truncate font-semibold text-ink">{row.value ?? "-"}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </div>
  );
}

export default function ConsignmentForm() {
  const pointLabel = usePointLabel();
  const { id } = useParams();
  const editing = !!id && id !== "new";
  const nav = useNavigate();
  const qc = useQueryClient();

  const [form, setForm] = useState<ConsignmentWrite>({
    issue_id: 0,
    dispatch_type: "PROJECT",
    dispatch_date: today(),
    to_warehouse_id: null,
    customer_id: null,
    vendor_id: null,
    project_id: null,
    delivery_address: "",
    contact_person: "",
    contact_phone: "",
    transport_mode: "ROAD",
    carrier_id: null,
    vehicle_id: null,
    driver_name: "",
    driver_phone: "",
    lr_no: "",
    eway_bill_no: "",
    freight_amount: null,
    expected_delivery: null,
    remarks: "",
    packages: [],
  });
  const [source, setSource] = useState<IssueDispatchSource | null>(null);
  const [packages, setPackages] = useState<PackageDraft[]>([newPackage(0)]);
  const [serialTarget, setSerialTarget] = useState<SerialTarget>(null);

  const { data: doc, isLoading } = useQuery({
    queryKey: ["wh-consignment", id],
    queryFn: () => getConsignment(Number(id)),
    enabled: editing,
  });

  useEffect(() => {
    if (!doc) return;
    setForm({
      issue_id: doc.ref_id ?? 0,
      dispatch_type: doc.dispatch_type,
      dispatch_date: doc.dispatch_date,
      to_warehouse_id: doc.to_warehouse_id ?? null,
      customer_id: doc.customer_id ?? null,
      vendor_id: doc.vendor_id ?? null,
      project_id: doc.project_id ?? null,
      delivery_address: doc.delivery_address ?? "",
      contact_person: doc.contact_person ?? "",
      contact_phone: doc.contact_phone ?? "",
      transport_mode: doc.transport_mode ?? "ROAD",
      carrier_id: doc.carrier_id ?? null,
      vehicle_id: doc.vehicle_id ?? null,
      driver_name: doc.driver_name ?? "",
      driver_phone: doc.driver_phone ?? "",
      lr_no: doc.lr_no ?? "",
      eway_bill_no: doc.eway_bill_no ?? "",
      freight_amount: doc.freight_amount ?? null,
      expected_delivery: doc.expected_delivery ?? null,
      remarks: doc.remarks ?? "",
      packages: [],
    });
    const grouped = (doc.packages ?? []).map((pkg) => {
      const byPackageLine = new Map<string, ConsignmentPackageItemWrite>();
      (doc.items ?? [])
        .filter((line) => line.package_id === pkg.id)
        .forEach((line) => {
          const key = lineKey(line);
          const existing = byPackageLine.get(key);
          byPackageLine.set(key, {
            ...(existing ?? {}),
            indent_id: line.indent_id,
            item_id: line.item_id,
            item_code: line.item_code,
            item_name: line.item_name,
            uom_code: line.uom_code,
            batch_id: line.batch_id,
            batch_no: line.batch_no,
            mfg_date: line.mfg_date,
            expiry_date: line.expiry_date,
            is_serial_tracked: !!line.serial_no || !!existing?.is_serial_tracked,
            serial_numbers: [
              ...(existing?.serial_numbers ?? []),
              ...(line.serial_no ? [line.serial_no] : []),
            ],
            quantity: num(existing?.quantity) + num(line.quantity),
            rate: line.rate ?? existing?.rate ?? null,
            remarks: line.remarks ?? existing?.remarks ?? null,
          });
        });
      return {
        key: String(pkg.id),
        package_no: pkg.package_no,
        package_type: pkg.package_type ?? "BOX",
        barcode: pkg.barcode ?? "",
        weight_kg: pkg.weight_kg ?? null,
        length_cm: pkg.length_cm ?? null,
        width_cm: pkg.width_cm ?? null,
        height_cm: pkg.height_cm ?? null,
        is_fragile: pkg.is_fragile,
        is_temp_controlled: pkg.is_temp_controlled,
        locked: true,
        items: Array.from(byPackageLine.values()),
      };
    });
    setPackages(grouped.length ? grouped : [newPackage(indexOrZero(doc.total_packages))]);
    const byLine = new Map<string, IssueDispatchSourceItem>();
    (doc.items ?? []).forEach((line) => {
      const key = lineKey(line);
      const existing = byLine.get(key);
      byLine.set(key, {
        indent_id: line.indent_id,
        item_id: line.item_id,
        item_code: line.item_code,
        item_name: line.item_name,
        uom_code: line.uom_code,
        batch_id: line.batch_id,
        batch_no: line.batch_no,
        mfg_date: line.mfg_date ?? existing?.mfg_date ?? null,
        expiry_date: line.expiry_date ?? existing?.expiry_date ?? null,
        imei_by_serial: {
          ...(existing?.imei_by_serial ?? {}),
          ...(line.serial_no && line.imei_no ? { [line.serial_no]: line.imei_no } : {}),
        },
        is_serial_tracked: !!line.serial_no || !!existing?.is_serial_tracked,
        serial_numbers: [
          ...(existing?.serial_numbers ?? []),
          ...(line.serial_no ? [line.serial_no] : []),
        ],
        quantity: num(existing?.quantity) + num(line.quantity),
        rate: line.rate ?? existing?.rate ?? null,
        remarks: line.remarks ?? existing?.remarks ?? null,
      });
    });
    setSource({
      issue_id: doc.ref_id ?? 0,
      issue_no: doc.ref_no ?? "",
      warehouse_id: doc.warehouse_id,
      project_id: doc.project_id,
      destination_office_id: doc.destination_office_id ?? null,
      destination_office_name: doc.destination_office_name ?? doc.delivery_address ?? null,
      destination_office_sac: doc.destination_office_sac ?? null,
      items: Array.from(byLine.values()),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);

  const loadIssue = useMutation({
    mutationFn: (issueId: number) => getIssueDispatchSource(issueId),
    onSuccess: (result) => {
      setSource(result);
      setForm((current) => ({
        ...current,
        issue_id: result.issue_id,
        project_id: result.project_id ?? current.project_id,
        // Default the destination to the point that raised the indent. The server
        // derives the same value when this is left blank, but nobody could see the
        // decision before saving — and half the consignments went out with nothing
        // for the receiving point to raise a GRN against. Still editable: the packer
        // can route it to any other point he holds.
        to_warehouse_id: current.to_warehouse_id ?? result.destination_warehouse_id ?? null,
        delivery_address: current.delivery_address || result.destination_office_name || "",
      }));
    },
  });

  const payload = (): ConsignmentWrite => ({
    ...form,
    packages: packages.map(({ key: _key, locked: _locked, ...pkg }, index) => ({
      ...pkg,
      package_no: pkg.package_no || `PKG-${String(index + 1).padStart(2, "0")}`,
      barcode: pkg.barcode || `${source?.issue_no ?? "CONS"}|${pkg.package_no || `P${index + 1}`}`,
      items: pkg.items
        .map((line) => ({
          ...line,
          quantity: packageQty(line),
        }))
        .filter((line) => num(line.quantity) > 0),
    })),
  });

  const save = useMutation({
    mutationFn: () => (editing ? updateConsignment(Number(id), payload()) : createConsignment(payload())),
    onSuccess: (saved: Dispatch) => {
      qc.invalidateQueries({ queryKey: ["wh-consignments"] });
      qc.invalidateQueries({ queryKey: ["wh-dispatches"] });
      qc.invalidateQueries({ queryKey: ["wh-consignment", String(saved.id)] });
      if (!editing) nav(`/warehouse/dispatch/consignments/${saved.id}`, { replace: true });
    },
  });

  const locked = !!doc && !["DRAFT", "PACKED"].includes(doc.status);
  const destination = destinationOf(doc, source);
  const destinationSac = destinationSacOf(doc, source);

  // Origin: the material issue's warehouse on a new consignment, the saved one on an
  // existing doc. The server derives the same value, so this is a display of its
  // decision, not an input.
  const originId = source?.warehouse_id ?? doc?.warehouse_id ?? null;
  const { data: allHouses = [] } = useQuery({
    queryKey: ["wh-lookup", "warehouses", "all"],
    queryFn: () => allWarehouseOptions(),
    staleTime: 5 * 60_000,
  });
  const originName = doc?.warehouse_name
    ?? allHouses.find((w) => w.id === originId)?.name
    ?? "";
  /** The network minus the origin — a transfer to itself is what the backend
   *  rejects, so it should never be offered in the first place. */
  const destinationOptions = (search?: string) =>
    allWarehouseOptions(search).then((rows) => rows.filter((w) => w.id !== originId));

  const allocation = useMemo(() => {
    const map = new Map<string, number>();
    for (const pkg of packages) {
      for (const line of pkg.items) {
        const qty = packageQty(line);
        map.set(lineKey(line), (map.get(lineKey(line)) ?? 0) + qty);
      }
    }
    return map;
  }, [packages]);

  const selectedSerials = useMemo(() => {
    const map = new Map<string, number>();
    const duplicates = new Set<string>();
    packages.forEach((pkg) => {
      pkg.items.forEach((line) => {
        line.serial_numbers?.forEach((serial) => {
          const count = map.get(serial) ?? 0;
          if (count > 0) duplicates.add(serial);
          map.set(serial, count + 1);
        });
      });
    });
    return { map, duplicates };
  }, [packages]);

  const lineProgress = useMemo(() => {
    const rows = new Map<string, { issued: number; packed: number; line: IssueDispatchSourceItem }>();
    for (const line of source?.items ?? []) {
      rows.set(lineKey(line), {
        issued: num(line.quantity),
        packed: allocation.get(lineKey(line)) ?? 0,
        line,
      });
    }
    return rows;
  }, [allocation, source]);

  const packageErrors = (pkg: PackageDraft, packageIndex: number) => {
    const errors: string[] = [];
    const hasQty = pkg.items.some((line) => packageQty(line) > 0);
    if (!pkg.package_no?.trim()) errors.push("Package no is required.");
    if (!pkg.package_type?.trim()) errors.push("Package type is required.");
    if (!hasQty) errors.push("Add at least one item quantity.");
    const duplicatePackageNo = packages.some(
      (row, index) => index !== packageIndex && row.package_no?.trim().toLowerCase() === pkg.package_no?.trim().toLowerCase(),
    );
    if (duplicatePackageNo) errors.push("Package no must be unique.");
    for (const line of pkg.items) {
      const sourceLine = lineProgress.get(lineKey(line));
      const qty = num(line.quantity);
      if (qty < 0) errors.push(`${line.item_code ?? line.item_id} cannot have negative quantity.`);
      if (sourceLine && (allocation.get(lineKey(line)) ?? 0) > sourceLine.issued) {
        errors.push(`${line.item_code ?? line.item_id} is packed above issued quantity.`);
      }
      if (line.is_serial_tracked && (line.serial_numbers?.length ?? 0) !== qty) {
        errors.push(`${line.item_code ?? line.item_id} needs ${fmtQty(qty)} serials selected.`);
      }
    }
    return Array.from(new Set(errors));
  };

  const formIssues = useMemo(() => {
    const issues: string[] = [];
    if (!form.issue_id) issues.push("Select a material issue.");
    packages.forEach((pkg, index) => {
      packageErrors(pkg, index).forEach((message) => issues.push(`${pkg.package_no || `Package ${index + 1}`}: ${message}`));
      if (!pkg.locked) issues.push(`${pkg.package_no || `Package ${index + 1}`}: Lock the package before saving.`);
    });
    lineProgress.forEach(({ issued, packed, line }) => {
      if (packed !== issued) {
        const label = `${line.item_code ?? line.item_id}${line.batch_no ? ` / ${line.batch_no}` : ""}`;
        issues.push(`${label} packed ${fmtQty(packed)} of ${fmtQty(issued)}.`);
      }
    });
    selectedSerials.duplicates.forEach((serial) => issues.push(`${serial} is selected in more than one package.`));
    return Array.from(new Set(issues));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allocation, form.issue_id, lineProgress, packages, selectedSerials]);

  const totals = {
    packages: packages.length,
    qty: Array.from(allocation.values()).reduce((sum, qty) => sum + qty, 0),
    value: packages.reduce(
      (sum, pkg) => sum + pkg.items.reduce((s, line) => s + packageQty(line) * num(line.rate), 0),
      0,
    ),
  };

  const remainingToPack = Array.from(lineProgress.values())
    .reduce((sum, row) => sum + Math.max(0, row.issued - row.packed), 0);
  const lastPackageIndex = packages.length - 1;
  const lastPackage = packages[lastPackageIndex];
  const canAddPackage = !!source
    && !!lastPackage
    && !!lastPackage.locked
    && packageErrors(lastPackage, lastPackageIndex).length === 0
    && remainingToPack > 0
    && !locked;

  const patchPackage = (index: number, patch: Partial<PackageDraft>) =>
    setPackages((rows) => rows.map((pkg, i) => (i === index ? { ...pkg, ...patch } : pkg)));

  const patchPackageLine = (
    packageIndex: number,
    sourceLine: IssueDispatchSourceItem,
    patch: Partial<ConsignmentPackageItemWrite>,
  ) => {
    setPackages((rows) =>
      rows.map((pkg, i) => {
        if (i !== packageIndex) return pkg;
        const key = lineKey(sourceLine);
        const existing = pkg.items.find((line) => lineKey(line) === key);
        const nextLine = {
          indent_id: sourceLine.indent_id,
          item_id: sourceLine.item_id,
          item_code: sourceLine.item_code,
          item_name: sourceLine.item_name,
          uom_code: sourceLine.uom_code,
          batch_id: sourceLine.batch_id,
          batch_no: sourceLine.batch_no,
          // Carried, not retyped: the consignment states which goods are in the
          // carton so the receiving GRN does not have to rebuild it from stk_batches.
          mfg_date: sourceLine.mfg_date,
          expiry_date: sourceLine.expiry_date,
          is_serial_tracked: sourceLine.is_serial_tracked,
          serial_numbers: [],
          quantity: 0,
          rate: sourceLine.rate,
          remarks: sourceLine.remarks,
          ...existing,
          ...patch,
        };
        return {
          ...pkg,
          items: [
            ...pkg.items.filter((line) => lineKey(line) !== key),
            nextLine,
          ].filter((line) => num(line.quantity) > 0 || (line.serial_numbers?.length ?? 0) > 0),
        };
      }),
    );
  };

  const packageLine = (pkg: PackageDraft, sourceLine: IssueDispatchSourceItem) =>
    pkg.items.find((line) => lineKey(line) === lineKey(sourceLine));

  const availableSerials = (target: SerialTarget) => {
    if (!target) return [];
    const used = new Set<string>();
    const current = new Set(
      packageLine(packages[target.packageIndex], target.line)?.serial_numbers ?? [],
    );
    packages.forEach((pkg, pkgIndex) => {
      pkg.items.forEach((line) => {
        if (pkgIndex === target.packageIndex && lineKey(line) === lineKey(target.line)) return;
        line.serial_numbers?.forEach((serial) => used.add(serial.toLowerCase()));
      });
    });
    return (target.line.serial_numbers ?? []).filter(
      (serial) => current.has(serial) || !used.has(serial.toLowerCase()),
    );
  };

  const scanCards: ScanCardSpec[] = doc ? [
    {
      code: doc.dispatch_no,
      title: `Consignment ${doc.dispatch_no}`,
      subtitle: doc.ref_no ? `Material issue ${doc.ref_no}` : "Consignment",
      accent: "consignment",
      meta: [
        { label: "Status", value: doc.status },
        { label: "Packages", value: doc.total_packages },
        { label: "Quantity", value: fmtQty(doc.total_qty) },
        { label: "From", value: doc.warehouse_name },
        { label: "Destination", value: destination },
        { label: "Date", value: doc.dispatch_date },
      ],
    },
    ...packages.map((pkg, index) => ({
      code: pkg.barcode || `${doc.dispatch_no}|${pkg.package_no || `P${index + 1}`}`,
      title: pkg.package_no || `Package ${index + 1}`,
      subtitle: `Consignment ${doc.dispatch_no}`,
      accent: "package" as const,
      meta: [
        { label: "Type", value: pkg.package_type },
        { label: "Weight", value: pkg.weight_kg ? `${fmtQty(pkg.weight_kg)} kg` : null },
        { label: "Size", value: [pkg.length_cm, pkg.width_cm, pkg.height_cm].some((v) => v != null)
          ? `${fmtQty(pkg.length_cm)} x ${fmtQty(pkg.width_cm)} x ${fmtQty(pkg.height_cm)} cm`
          : null },
        { label: "Items", value: pkg.items.length },
        { label: "Qty", value: fmtQty(pkg.items.reduce((sum, line) => sum + packageQty(line), 0)) },
        { label: "Handling", value: [
          pkg.is_fragile ? "Fragile" : null,
          pkg.is_temp_controlled ? "Temp controlled" : null,
        ].filter(Boolean).join(", ") || "Standard" },
      ],
    })),
  ] : [];

  if (editing && isLoading) return <div className="py-16 text-center text-muted">Loading...</div>;

  return (
    <div>
      <PageHeader
        eyebrow={pointLabel}
        title={editing ? `Consignment ${doc?.dispatch_no ?? ""}` : "New consignment"}
        actions={
          <>
            <Button variant="ghost" onClick={() => nav("/warehouse/dispatch/consignments")}>
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
            {doc?.status === "PACKED" && (
              <Can do="dispatch.gate_out">
                <Button variant="soft" onClick={() => nav(`/warehouse/dispatch/new?consignment_id=${doc.id}`)}>
                  <Truck className="h-4 w-4" /> Confirm dispatch
                </Button>
              </Can>
            )}
            {!locked && (
              <Can do="dispatch.create">
                <Button onClick={() => save.mutate()} disabled={save.isPending || formIssues.length > 0}>
                  {save.isPending ? "Saving..." : "Save consignment"}
                </Button>
              </Can>
            )}
          </>
        }
      />

      <ErrorBanner error={save.error ?? loadIssue.error} />

      {/* The issue came out of the point that raised the indent, so there is no
          journey to record. Saying nothing left a blank destination on screen, a
          consignment that could be dispatched, and a storekeeper with no consignment
          to raise a GRN against — the server now refuses it, so say why up front. */}
      {source?.destination_is_origin && !editing && (
        <div className="mb-4 rounded-lg border border-warn/30 bg-warn-bg px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-warn">
            <AlertCircle className="h-4 w-4" /> No consignment needed
          </div>
          <p className="mt-1 text-xs text-body">
            {source.issue_no} was issued at {originName || "this point"}, which is the point
            that raised the indent — the goods are already there. Acknowledge the issue
            instead, or pick a destination above to forward it on.
          </p>
        </div>
      )}

      {doc && (
        <MetaCard title="Consignment identity">
          <MetaRow
            label="Consignment no"
            value={<span className="font-mono text-sm font-bold text-brand">{doc.dispatch_no}</span>}
          />
          <MetaRow label="Status" value={<StatusPill status={doc.status} />} />
          <MetaRow label="Material issue" value={<span className="font-mono">{doc.ref_no ?? "—"}</span>} />
          <MetaRow label="Destination" value={destination || "—"} />
          <MetaRow label="Service area code (SAC)" value={destinationSac || "—"} />
          <MetaRow label="Packages" value={doc.total_packages} />
          <MetaRow label="Quantity" value={fmtQty(doc.total_qty)} />
        </MetaCard>
      )}

      <Section title="Material issue">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
          <Field label="Against material issue">
            <Lookup
              name="posted-issues"
              load={issueOptions}
              value={form.issue_id || ""}
              isDisabled={locked || editing}
              onChange={(value) => {
                const issueId = value === "" ? 0 : value;
                setForm((current) => ({ ...current, issue_id: issueId }));
                setSource(null);
                setPackages([newPackage(0)]);
                if (issueId) loadIssue.mutate(issueId);
              }}
              placeholder="Select material issue"
            />
          </Field>
          <Field label="Type">
            <Select value={form.dispatch_type} onChange={(value) => setForm((f) => ({ ...f, dispatch_type: value }))}
                    options={DISPATCH_TYPES} isDisabled={locked} />
          </Field>
          <Field label="Date">
            <Input type="date" value={form.dispatch_date} disabled={locked}
                   onChange={(event) => setForm((f) => ({ ...f, dispatch_date: event.target.value }))} />
          </Field>
          {/* Where it ships FROM. Derived by the server from the material issue and
              never editable — but it has to be on screen, because the backend refuses
              a transfer whose destination equals it and the form used to hide the one
              value that made the rejection make sense. */}
          <Field label="From warehouse">
            <Input value={originName || "—"} disabled />
          </Field>
          <Field label="To warehouse">
            {/* Destination: the whole network, because a transfer goes to a point
                this login does not hold — minus the origin, which cannot be both.

                Left blank, the server derives it from the issue's destination office.
                It has to: this is the only field the receiving point's inward screen
                matches on, and the old "For transfer only" placeholder told everyone
                to skip it — so half the consignments arrived with nothing to receive
                them against. */}
            <Lookup name="warehouses" load={destinationOptions} value={form.to_warehouse_id ?? ""} isDisabled={locked}
                    onChange={(value) => setForm((f) => ({ ...f, to_warehouse_id: value === "" ? null : value }))}
                    placeholder="Auto from the indent" />
          </Field>
          <Field label="Destination">
            <Input value={destination || "—"} disabled />
          </Field>
          {/* Comes with the material issue, like the destination beside it: the code
              belongs to the office the consignment is addressed to, so picking the
              issue fills it and nothing on this screen sets it. */}
          <Field label="Service area code (SAC)">
            <Input
              value={destinationSac ?? (destination ? "No service area code for this office" : "—")}
              disabled
            />
          </Field>
          <Field label="Vendor">
            <Lookup name="vendors" load={vendorOptions} value={form.vendor_id ?? ""} isDisabled={locked}
                    onChange={(value) => setForm((f) => ({ ...f, vendor_id: value === "" ? null : value }))}
                    placeholder="Vendor" />
          </Field>
          <Field label="Expected delivery">
            {/* Goods cannot arrive before they leave. `min` is the dispatch date, not
                today: a consignment can be back-dated, and its delivery date has to
                stay consistent with whatever date it actually went out on. */}
            <Input type="date" value={form.expected_delivery ?? ""} disabled={locked}
                   min={form.dispatch_date || undefined}
                   onChange={(event) => setForm((f) => ({ ...f, expected_delivery: event.target.value || null }))} />
          </Field>
          <Field label="Mode">
            <Select value={form.transport_mode ?? "ROAD"} onChange={(value) => setForm((f) => ({ ...f, transport_mode: value }))}
                    options={MODES} isDisabled={locked} />
          </Field>
          <Field label="Carrier">
            <Lookup name="carriers" load={carrierOptions} value={form.carrier_id ?? ""} isDisabled={locked}
                    onChange={(value) => setForm((f) => ({ ...f, carrier_id: value === "" ? null : value }))}
                    placeholder="Carrier" />
          </Field>
          <Field label="Vehicle">
            <Lookup name="vehicles" load={vehicleOptions} value={form.vehicle_id ?? ""} isDisabled={locked}
                    onChange={(value) => setForm((f) => ({ ...f, vehicle_id: value === "" ? null : value }))}
                    placeholder="Vehicle" />
          </Field>
          <Field label="Driver">
            <Input value={form.driver_name ?? ""} disabled={locked}
                   onChange={(event) => setForm((f) => ({ ...f, driver_name: event.target.value }))} />
          </Field>
          <Field label="LR no">
            <Input value={form.lr_no ?? ""} disabled={locked}
                   onChange={(event) => setForm((f) => ({ ...f, lr_no: event.target.value }))} />
          </Field>
          <div className="lg:col-span-2">
            <Field label="Delivery address">
              <Input value={form.delivery_address ?? ""} disabled={locked}
                     onChange={(event) => setForm((f) => ({ ...f, delivery_address: event.target.value }))} />
            </Field>
          </div>
        </div>
      </Section>

      <Section
        title="Packages"
        hint="Lock each package after its quantities and serials are correct. Add the next package only after the current one is locked."
        actions={!locked && (
          <Button
            variant="subtle"
            disabled={!canAddPackage}
            onClick={() => setPackages((rows) => [...rows, newPackage(rows.length)])}
          >
            <PackagePlus className="h-4 w-4" /> Add package
          </Button>
        )}
      >
        {formIssues.length > 0 && (
          <div className="mb-4 rounded-lg border border-warn/30 bg-warn-bg px-4 py-3">
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-warn">
              <AlertCircle className="h-4 w-4" /> Complete these before saving
            </div>
            <ul className="grid gap-1 text-xs text-body md:grid-cols-2">
              {formIssues.slice(0, 8).map((issue) => (
                <li key={issue}>• {issue}</li>
              ))}
              {formIssues.length > 8 && <li>• {formIssues.length - 8} more issue(s)</li>}
            </ul>
          </div>
        )}
        {!source && !doc ? (
          <div className="rounded-lg border border-line bg-content2 px-4 py-8 text-center text-sm text-muted">
            Select a material issue to load issue lines.
          </div>
        ) : (
          <div className="space-y-4">
            {packages.map((pkg, packageIndex) => {
              const pkgErrors = packageErrors(pkg, packageIndex);
              const pkgLocked = locked || !!pkg.locked;
              const pkgQty = pkg.items.reduce((sum, line) => sum + packageQty(line), 0);
              return (
              <div key={pkg.key} className={`rounded-lg border bg-content1 p-4 ${
                pkgLocked ? "border-ok/40" : pkgErrors.length ? "border-warn/40" : "border-line"
              }`}>
                <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-display text-base font-bold text-ink">
                        {pkg.package_no || `Package ${packageIndex + 1}`}
                      </h3>
                      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-semibold ${
                        pkgLocked ? "bg-ok-bg text-ok" : "bg-warn-bg text-warn"
                      }`}>
                        {pkgLocked ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
                        {pkgLocked ? "Locked" : "Editable"}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-muted">
                      {fmtQty(pkgQty)} packed in this package
                    </div>
                  </div>
                  {!locked && (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant={pkg.locked ? "subtle" : "primary"}
                        disabled={!pkg.locked && pkgErrors.length > 0}
                        onClick={() => patchPackage(packageIndex, { locked: !pkg.locked })}
                      >
                        {pkg.locked ? <Unlock className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
                        {pkg.locked ? "Unlock package" : "Lock package"}
                      </Button>
                      {packages.length > 1 && !pkg.locked && (
                        <Button variant="danger" onClick={() => setPackages((rows) => rows.filter((_, i) => i !== packageIndex))}>
                          <Trash2 className="h-4 w-4" /> Remove
                        </Button>
                      )}
                    </div>
                  )}
                </div>
                {pkgErrors.length > 0 && !pkgLocked && (
                  <div className="mb-4 rounded-lg border border-warn/30 bg-warn-bg/60 px-3 py-2 text-xs text-warn">
                    {pkgErrors[0]}
                  </div>
                )}
                <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-4">
                  {/* Both identifiers are issued by the server when left blank, and
                      the barcode is checked for uniqueness there. Letting them be typed
                      meant a hand-keyed barcode could collide with a generated one and
                      only fail on save. Read-only; the placeholder shows what you get. */}
                  <Field label="Package no">
                    <Input value={pkg.package_no ?? ""} disabled
                           placeholder={`P${packageIndex + 1} (auto)`} />
                  </Field>
                  <Field label="Package type">
                    <Select value={pkg.package_type ?? "BOX"} options={PACKAGE_TYPES} isDisabled={pkgLocked}
                            onChange={(value) => patchPackage(packageIndex, { package_type: value })} />
                  </Field>
                  <Field label="Barcode">
                    <Input value={pkg.barcode ?? ""} disabled
                           placeholder={`${source?.issue_no ?? "CONS"}|${pkg.package_no ?? `P${packageIndex + 1}`} (auto)`} />
                  </Field>
                  <div className="flex items-end">
                    <div className="rounded-lg border border-line bg-content2 px-3 py-2 text-xs text-muted">
                      Remaining after all packages: <b className="text-ink">{fmtQty(remainingToPack)}</b>
                    </div>
                  </div>
                  <Field label="Weight (kg)">
                    <Input type="number" value={pkg.weight_kg ?? ""} disabled={pkgLocked}
                           onChange={(event) => patchPackage(packageIndex, { weight_kg: event.target.value === "" ? null : Number(event.target.value) })} />
                  </Field>
                  <Field label="Length (cm)">
                    <Input type="number" value={pkg.length_cm ?? ""} disabled={pkgLocked}
                           onChange={(event) => patchPackage(packageIndex, { length_cm: event.target.value === "" ? null : Number(event.target.value) })} />
                  </Field>
                  <Field label="Width (cm)">
                    <Input type="number" value={pkg.width_cm ?? ""} disabled={pkgLocked}
                           onChange={(event) => patchPackage(packageIndex, { width_cm: event.target.value === "" ? null : Number(event.target.value) })} />
                  </Field>
                  <Field label="Height (cm)">
                    <Input type="number" value={pkg.height_cm ?? ""} disabled={pkgLocked}
                           onChange={(event) => patchPackage(packageIndex, { height_cm: event.target.value === "" ? null : Number(event.target.value) })} />
                  </Field>
                  <label className="flex items-center gap-2">
                    <Checkbox isSelected={!!pkg.is_fragile} isDisabled={pkgLocked}
                              onValueChange={(value) => patchPackage(packageIndex, { is_fragile: value })} />
                    <span className="text-sm text-body">Fragile</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <Checkbox isSelected={!!pkg.is_temp_controlled} isDisabled={pkgLocked}
                              onValueChange={(value) => patchPackage(packageIndex, { is_temp_controlled: value })} />
                    <span className="text-sm text-body">Temperature controlled</span>
                  </label>
                </div>

                <div className="overflow-x-auto rounded-lg border border-line">
                  <table className="min-w-[900px] w-full text-sm">
                    <thead className="bg-content2 text-left text-[11px] uppercase text-muted">
                      <tr>
                        <th className="px-3 py-2">Item</th>
                        <th className="px-3 py-2">Batch</th>
                        <th className="px-3 py-2">Mfg</th>
                        <th className="px-3 py-2">Expiry</th>
                        <th className="px-3 py-2 text-right">Issued</th>
                        <th className="px-3 py-2 text-right">Packed</th>
                        <th className="px-3 py-2 text-right">This package</th>
                        <th className="px-3 py-2">Serials</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(source?.items ?? []).map((line) => {
                        const current = packageLine(pkg, line);
                        const packed = allocation.get(lineKey(line)) ?? 0;
                        const thisQty = num(current?.quantity);
                        const remaining = Math.max(0, num(line.quantity) - packed + thisQty);
                        const complete = packed === num(line.quantity);
                        return (
                          <tr key={lineKey(line)} className="border-t border-line">
                            <td className="px-3 py-2">
                              <div className="font-mono text-xs font-semibold text-ink">{line.item_code ?? line.item_id}</div>
                              <div className="max-w-[260px] truncate text-xs text-muted">{line.item_name ?? "—"}</div>
                            </td>
                            <td className="px-3 py-2 text-xs text-muted">{line.batch_no ?? "—"}</td>
                            <td className="px-3 py-2 text-xs text-muted">{line.mfg_date ?? "—"}</td>
                            <td className="px-3 py-2 text-xs text-muted">{line.expiry_date ?? "—"}</td>
                            <td className="px-3 py-2 text-right tabular">{fmtQty(line.quantity)} {line.uom_code ?? ""}</td>
                            <td className={`px-3 py-2 text-right tabular ${complete ? "text-ok" : "text-body"}`}>
                              {fmtQty(packed)}
                            </td>
                            <td className="px-3 py-2 text-right">
                              <Input
                                className="text-right"
                                type="number"
                                min={0}
                                max={remaining}
                                disabled={pkgLocked}
                                value={line.is_serial_tracked ? String(thisQty) : String(current?.quantity ?? "")}
                                onChange={(event) => {
                                  const nextQty = Math.min(Number(event.target.value || 0), remaining);
                                  const nextSerials = (current?.serial_numbers ?? []).slice(0, Math.floor(nextQty));
                                  patchPackageLine(packageIndex, line, {
                                    quantity: nextQty,
                                    serial_numbers: line.is_serial_tracked ? nextSerials : current?.serial_numbers,
                                    is_serial_tracked: !!line.is_serial_tracked,
                                  });
                                }}
                              />
                            </td>
                            <td className="px-3 py-2">
                              {line.is_serial_tracked ? (
                                <Button variant="subtle" disabled={pkgLocked || thisQty <= 0 || remaining < thisQty}
                                        onClick={() => setSerialTarget({ packageIndex, line })}>
                                  {(current?.serial_numbers?.length ?? 0) === thisQty && thisQty > 0 ? (
                                    <><CheckCircle2 className="h-4 w-4" /> {thisQty} serials</>
                                  ) : thisQty > 0 ? (
                                    `${current?.serial_numbers?.length ?? 0}/${thisQty} serials`
                                  ) : "Set qty first"}
                                </Button>
                              ) : (
                                <span className="text-xs text-muted">—</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
              );
            })}
          </div>
        )}
      </Section>

      {editing && (
        <>
          <Section title="Summary">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="rounded-lg border border-line bg-content1 p-4">
                <div className="text-xs uppercase text-muted">Packages</div>
                <div className="mt-1 text-2xl font-bold text-ink">{totals.packages}</div>
              </div>
              <div className="rounded-lg border border-line bg-content1 p-4">
                <div className="text-xs uppercase text-muted">Packed qty</div>
                <div className="mt-1 text-2xl font-bold text-ink">{fmtQty(totals.qty)}</div>
              </div>
              <div className="rounded-lg border border-line bg-content1 p-4">
                <div className="text-xs uppercase text-muted">Value</div>
                <div className="mt-1 text-2xl font-bold text-ink">₹ {fmtMoney(totals.value)}</div>
              </div>
            </div>
          </Section>

          <Section
            title="Scan labels"
            hint="Consignment and package identities. Each card carries both QR and barcode for scanning."
            actions={
              <Button onClick={() => window.print()} disabled={scanCards.length === 0}>
                <Printer className="h-4 w-4" /> Print labels
              </Button>
            }
          >
            <style>{`
              @media print {
                body * { visibility: hidden !important; }
                #wh-consignment-scan-labels, #wh-consignment-scan-labels * { visibility: visible !important; }
                #wh-consignment-scan-labels {
                  position: absolute; inset: 0; margin: 0; padding: 8mm;
                  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6mm;
                  align-content: flex-start;
                }
                #wh-consignment-scan-labels > * { break-inside: avoid; page-break-inside: avoid; }
              }
            `}</style>
            <div id="wh-consignment-scan-labels" className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {scanCards.map((card) => (
                <ScanCard key={`${card.accent}-${card.code}`} spec={card} />
              ))}
            </div>
          </Section>
        </>
      )}

      <SerialNumbersModal
        isOpen={!!serialTarget}
        onClose={() => setSerialTarget(null)}
        itemLabel={serialTarget ? itemLabel(serialTarget.line) : ""}
        quantity={
          serialTarget
            ? Math.floor(num(packageLine(packages[serialTarget.packageIndex], serialTarget.line)?.quantity))
            : 0
        }
        available={availableSerials(serialTarget)}
        imeiBySerial={serialTarget?.line.imei_by_serial}
        pickMode="select"
        initial={
          serialTarget
            ? (packageLine(packages[serialTarget.packageIndex], serialTarget.line)?.serial_numbers ?? [])
                .filter((serial) => availableSerials(serialTarget).includes(serial))
            : []
        }
        onSave={(serials) => {
          if (serialTarget) {
            patchPackageLine(serialTarget.packageIndex, serialTarget.line, {
              serial_numbers: serials,
              is_serial_tracked: true,
            });
          }
          setSerialTarget(null);
        }}
      />
    </div>
  );
}

function indexOrZero(value: number | undefined) {
  return value && value > 0 ? value - 1 : 0;
}
