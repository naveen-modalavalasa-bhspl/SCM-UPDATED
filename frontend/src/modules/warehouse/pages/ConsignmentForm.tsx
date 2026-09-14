import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Checkbox } from "@heroui/react";
import Barcode from "react-barcode";
import { QRCodeSVG } from "qrcode.react";
import { AlertCircle, ArrowLeft, CheckCircle2, ClipboardCheck, Lock, Package, PackagePlus, Printer, QrCode, ScanLine, Trash2, Truck, Unlock } from "lucide-react";
import { Button, Can, ErrorBanner, Field, Input, Select, StatusPill } from "@/shared/components";
import { MetaCard, MetaRow } from "../components/DocumentMeta";
import { PrintPortal } from "../components/LabelPrint";
import { Lookup } from "../components/Lookup";
import { SerialNumbersModal } from "../components/SerialNumbersModal";
import {
  carrierOptions,
  createConsignment,
  getConsignment,
  getIssueDispatchSource,
  issueOptions,
  updateConsignment,
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

const VEHICLE_IN_NAME = /([A-Z]{2}\d{1,2}[A-Z]{1,3}\d{3,4})$/;

/** The registration number an MMU office carries at the end of its own name
 *  (`AP-104-MMU-Badangi-AP39UH4792`) — the same string the delivery address is
 *  filled from. Mirrors `warehouse.service._vehicle_from_office_name`. */
const vehicleFromName = (name?: string | null) => {
  const tail = (name ?? "").replace(/\s/g, "").toUpperCase().split("-").pop() ?? "";
  return VEHICLE_IN_NAME.exec(tail)?.[1] ?? null;
};

/** The vehicle the consignment travels on. Derived, never picked: `trn_vehicles` is
 *  empty, so the lookup that used to sit in this box offered "No results found" and
 *  every consignment went out with no vehicle at all. The server derives and stores
 *  the same value (`_consignment_vehicle`); this only shows it before the save. */
const vehicleOf = (
  doc?: Dispatch | null,
  source?: IssueDispatchSource | null,
  destination?: string | null,
) => doc?.vehicle_number ?? source?.vehicle_number ?? vehicleFromName(destination) ?? "";

/** The same office name with that registration number taken off, which is what the
 *  delivery address wants: the number is its own field now, and printing it twice
 *  on one consignment only invites the two to disagree. Mirrors
 *  `warehouse.service._address_without_vehicle`. */
const addressWithoutVehicle = (name?: string | null) => {
  if (!name || !vehicleFromName(name)) return name ?? "";
  const cut = name.lastIndexOf("-");
  return (cut < 0 ? name : name.slice(0, cut)).replace(/[\s-]+$/, "") || name;
};

type ScanCardSpec = {
  code: string;
  title: string;
  subtitle?: string;
  accent: "consignment" | "package";
  meta: { label: string; value: string | number | null | undefined }[];
  /** Printed on the label itself, so a carton can be checked without a scanner. */
  lines?: { code: string; name: string; qty: string }[];
};

/** How many content lines fit on a label before it stops being one card. */
const LABEL_LINES = 6;

/** The QR matrix and the barcode encoding, and NOTHING that changes while packing.
 *
 *  qrcode.react recomputes the error-correction matrix and react-barcode re-runs
 *  JsBarcode on every render they are given. Inline in `ScanCard` — which is drawn
 *  twice per card, once on screen and once in the print portal — that was every label
 *  on the consignment re-encoding itself on every quantity keystroke and every button
 *  press, which is what made the screen feel stuck. Both codes depend on one string,
 *  so they are memoised on it and a packing edit costs nothing here. */
const ScanQr = memo(function ScanQr({ code }: { code: string }) {
  return (
    <div className="flex justify-center rounded-lg border border-line bg-white p-3">
      <QRCodeSVG value={code} size={108} level="M" />
    </div>
  );
});
const ScanBarcode = memo(function ScanBarcode({ code }: { code: string }) {
  return (
    <div className="overflow-hidden">
      <Barcode value={code} height={54} width={1.35} fontSize={12} margin={0} displayValue />
    </div>
  );
});

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
        {/* Both codes carry the bare document number, as they always did. A QR holding
            a URL sent every phone through the login screen before it could show
            anything; the number is what the yard actually reads out loud. What the
            code means is answered by the Scan screen, reached from inside the app. */}
        <ScanQr code={spec.code} />
        <div className="min-w-0 rounded-lg border border-line bg-white p-3">
          <ScanBarcode code={spec.code} />
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

      {spec.lines && spec.lines.length > 0 && (
        <div className="mt-3 rounded-lg border border-line bg-white p-3">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
            Contents ({spec.lines.length})
          </div>
          <ul className="space-y-0.5 text-[11px] leading-tight">
            {spec.lines.slice(0, LABEL_LINES).map((line, index) => (
              <li key={`${line.code}-${index}`} className="flex items-baseline justify-between gap-2">
                <span className="min-w-0">
                  <span className="font-mono font-semibold text-ink">{line.code}</span>
                  <span className="ml-2 text-muted">{line.name}</span>
                </span>
                <span className="shrink-0 font-semibold tabular text-ink">{line.qty}</span>
              </li>
            ))}
            {spec.lines.length > LABEL_LINES && (
              <li className="text-muted">+{spec.lines.length - LABEL_LINES} more line(s) — scan the QR for the full list</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

/** A calmer frame for this document only. It deliberately leaves all of the
 * form controls alone, while making the physical journey of a consignment clear. */
function ConsignmentSection({
  title,
  hint,
  actions,
  icon: Icon,
  children,
}: {
  title: string;
  hint?: string;
  actions?: ReactNode;
  icon: typeof Package;
  children: ReactNode;
}) {
  return (
    <section className="mb-5 overflow-hidden rounded-2xl border border-line bg-content1 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4 sm:px-6">
        <div className="flex min-w-0 items-start gap-2.5">
          <Icon className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
          <div className="min-w-0">
            <h2 className="font-display text-[15px] font-bold text-ink">{title}</h2>
            {hint && <p className="mt-0.5 text-xs leading-5 text-muted">{hint}</p>}
          </div>
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      <div className="p-5 sm:p-6">{children}</div>
    </section>
  );
}

function ConsignmentJourney({
  title,
  actions,
}: {
  title: string;
  actions: ReactNode;
}) {
  return (
    <div className="mb-5 overflow-hidden rounded-2xl border border-line bg-content1 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4 px-5 py-5 sm:px-6">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
            <Truck className="h-3.5 w-3.5 text-brand" /> Consignment
          </div>
          <h1 className="mt-2 font-display text-[26px] font-bold tracking-tight text-ink">{title}</h1>
          <p className="mt-1.5 max-w-2xl text-sm leading-6 text-muted">Organise goods from the material issue into packages, then move them to their destination.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      </div>
    </div>
  );
}

export default function ConsignmentForm() {
  const { id } = useParams();
  const editing = !!id && id !== "new";
  const nav = useNavigate();
  const qc = useQueryClient();

  // One screen, two front doors: the warehouse works consignments under /warehouse,
  // the logistics desk works the same document under /logistics. Every route this
  // form pushes has to stay on the side it was opened from — hardcoding /warehouse
  // handed a logistics user over to the warehouse module mid-flow, and the module
  // rail, the tabs and the eyebrow all changed under them.
  const inLogistics = useLocation().pathname.startsWith("/logistics");
  // `/warehouse/consignments`, not `/warehouse/dispatch/consignments`: that path is
  // retired and now REDIRECTS to logistics, so Back would have walked a warehouse
  // user out of their own module.
  const listPath = inLogistics ? "/logistics/consignments" : "/warehouse/consignments";
  // The next step is the same screen through either door — the warehouse's own
  // dispatch confirm is retired, and a redirect could not carry it there anyway: it
  // would drop the `consignment_id` and open the confirm screen on nothing.
  const dispatchPath = (docId: number) => `/logistics/dispatch/new?consignment_id=${docId}`;

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
      delivery_address: addressWithoutVehicle(doc.delivery_address),
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
      vehicle_number: doc.vehicle_number ?? null,
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
        delivery_address: current.delivery_address
          || addressWithoutVehicle(result.destination_office_name),
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
      if (!editing) nav(`${listPath}/${saved.id}`, { replace: true });
    },
  });

  const locked = !!doc && !["DRAFT", "PACKED"].includes(doc.status);
  const destination = destinationOf(doc, source);
  const destinationSac = destinationSacOf(doc, source);
  const vehicleNumber = vehicleOf(doc, source, destination || form.delivery_address);

  // Origin: the material issue's warehouse on a new consignment, the saved one on an
  // existing doc. The server derives the same value, so this is a display of its
  // decision, not an input.
  const originId = source?.warehouse_id ?? doc?.warehouse_id ?? null;
  const ALL_HOUSES_KEY = ["wh-lookup", "warehouses", "all"];
  const { data: allHouses = [] } = useQuery({
    queryKey: ALL_HOUSES_KEY,
    queryFn: () => allWarehouseOptions(),
    staleTime: 5 * 60_000,
  });
  const originName = doc?.warehouse_name
    ?? allHouses.find((w) => w.id === originId)?.name
    ?? "";
  /** The network minus the origin — a transfer to itself is what the backend
   *  rejects, so it should never be offered in the first place.
   *
   *  Read THROUGH the cache entry above rather than calling the endpoint again: both
   *  want the same 993-row list, and fetching it twice on one screen was most of the
   *  wait after picking an issue. `useCallback` because `Lookup` is memoised and a
   *  loader with a fresh identity every render would defeat it. */
  const destinationOptions = useCallback(
    () => qc.fetchQuery({
      queryKey: ALL_HOUSES_KEY,
      queryFn: () => allWarehouseOptions(),
      staleTime: 5 * 60_000,
    }).then((rows) => rows.filter((w) => w.id !== originId)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [qc, originId],
  );

  /** The three lookup handlers, stable for the same reason the loader above is: a new
   *  arrow on every render is a changed prop, and a changed prop is a memoised
   *  dropdown re-rendering for a package edit that has nothing to do with it. */
  const pickIssue = useCallback((value: number | "") => {
    const issueId = value === "" ? 0 : value;
    setForm((current) => ({ ...current, issue_id: issueId }));
    setSource(null);
    setPackages([newPackage(0)]);
    if (issueId) loadIssue.mutate(issueId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadIssue.mutate]);
  const pickDestination = useCallback((value: number | "") =>
    setForm((f) => ({ ...f, to_warehouse_id: value === "" ? null : value })), []);
  const pickCarrier = useCallback((value: number | "") =>
    setForm((f) => ({ ...f, carrier_id: value === "" ? null : value })), []);

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
      // An item put in the carton with no quantity on it is an empty item. The
      // logistics grid lists only what the package HOLDS, so such a row reads as
      // packed while nothing is in the box, and locking froze it that way. The
      // warehouse door lists every issue line whether or not it is in this
      // carton, where a blank simply means "not this one" - so this is the
      // logistics door's rule only.
      if (inLogistics && qty <= 0) {
        errors.push(`${line.item_code ?? line.item_id} has no quantity - enter one, or remove it from this package.`);
      }
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

  // Logistics packages are made one at a time.  Once the packer locks the open
  // carton, make the next carton only when issue quantity is still waiting to be
  // packed.  Warehouse keeps its existing explicit Add package flow below.
  const lockLogisticsPackage = (packageIndex: number) => {
    setPackages((rows) => {
      const next = rows.map((pkg, index) => (index === packageIndex ? { ...pkg, locked: true } : pkg));
      const packedByLine = new Map<string, number>();
      next.forEach((pkg) => pkg.items.forEach((line) => {
        const key = lineKey(line);
        packedByLine.set(key, (packedByLine.get(key) ?? 0) + packageQty(line));
      }));
      const hasRemaining = (source?.items ?? []).some(
        (line) => (packedByLine.get(lineKey(line)) ?? 0) < num(line.quantity),
      );
      return hasRemaining ? [...next, newPackage(next.length)] : next;
    });
  };

  const patchPackage = (index: number, patch: Partial<PackageDraft>) =>
    setPackages((rows) => rows.map((pkg, i) => (i === index ? { ...pkg, ...patch } : pkg)));

  const patchPackageLine = (
    packageIndex: number,
    sourceLine: IssueDispatchSourceItem,
    patch: Partial<ConsignmentPackageItemWrite>,
    keepEmpty = false,
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
          ].filter((line) => keepEmpty || num(line.quantity) > 0 || (line.serial_numbers?.length ?? 0) > 0),
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

  const scanCards: ScanCardSpec[] = useMemo(() => (doc ? [
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
      // The consignment label lists its cartons; a package label lists its items.
      lines: packages.map((pkg, index) => ({
        code: pkg.package_no || `P${index + 1}`,
        name: `${pkg.items.filter((line) => packageQty(line) > 0).length} item line(s)`,
        qty: fmtQty(pkg.items.reduce((sum, line) => sum + packageQty(line), 0)),
      })),
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
      lines: pkg.items
        .filter((line) => packageQty(line) > 0)
        .map((line) => ({
          code: String(line.item_code ?? line.item_id),
          name: line.item_name ?? "",
          qty: `${fmtQty(line.quantity)} ${line.uom_code ?? ""}`.trim(),
        })),
    })),
  ] : []), [doc, packages, destination]);

  if (editing && isLoading) return <div className="py-16 text-center text-muted">Loading...</div>;

  return (
    <div>
      <ConsignmentJourney
        title={editing ? `Consignment ${doc?.dispatch_no ?? ""}` : "New consignment"}
        actions={
          <>
            <Button variant="ghost" onClick={() => nav(listPath)}>
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
            {/* APPROVED as well as PACKED. Nothing on THIS screen releases a
                consignment any more, but `transport_release_blocked` still submits
                one to its DISPATCH ladder on the dispatch press, and the warehouse's
                own Dispatch screen still has a release button — so APPROVED is a
                state a consignment reaches, and gating this press on PACKED alone
                left it with no way forward at all: the form is locked by then and
                the only control on the page was Back. */}
            {(doc?.status === "PACKED" || doc?.status === "APPROVED") && (
              <Can do={inLogistics ? "transport.create" : "dispatch.gate_out"}>
                {/* This press does not dispatch anything — it opens the screen where
                    the mode and the provider are chosen and the transport request is
                    raised. The load actually leaves later, on the shipment. Calling it
                    "Confirm dispatch" read as the final word on a consignment that had
                    not yet been offered to a carrier. */}
                <Button variant="soft" onClick={() => nav(dispatchPath(doc.id))}>
                  <Truck className="h-4 w-4" /> Process dispatch
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
        <div className="mb-5 rounded-2xl border border-warn/25 bg-warn-bg/70 px-5 py-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-warn">
            <AlertCircle className="h-4 w-4 shrink-0" /> No consignment needed
          </div>
          <p className="mt-1.5 text-xs leading-5 text-body">
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

      <ConsignmentSection
        title={inLogistics ? "Consignment Details" : "Material issue"}
        icon={ClipboardCheck}
        hint="Set the consignment route and delivery information before packing."
      >
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
          <Field label="Against material issue">
            <Lookup
              name="posted-issues"
              load={issueOptions}
              value={form.issue_id || ""}
              isDisabled={locked || editing}
              onChange={pickIssue}
              placeholder="Select material issue"
            />
          </Field>
          <Field label="Type">
            <Select value={form.dispatch_type} onChange={(value) => setForm((f) => ({ ...f, dispatch_type: value }))}
                    options={DISPATCH_TYPES} isDisabled={locked} />
          </Field>
          <Field label="Date">
            {/* Read-only on the logistics door: the date the consignment goes out is
                the warehouse's to set, and logistics only carries the leg after it. */}
            <Input type="date" value={form.dispatch_date} disabled={locked || inLogistics}
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
            {/* `warehouses-destination`, not `warehouses`: the cache key is the name,
                and MaterialIssueForm's lookup of the same name loads the SCOPED list.
                Sharing one entry meant whichever screen mounted first decided whether
                this box offered the whole network or only the points this login
                holds — and a destination is by definition somebody else's. */}
            <Lookup name="warehouses-destination" load={destinationOptions}
                    value={form.to_warehouse_id ?? ""} isDisabled={locked}
                    onChange={pickDestination}
                    placeholder="Auto from the indent" />
          </Field>
          {!inLogistics && (
            <Field label="Destination">
              <Input value={destination || "—"} disabled />
            </Field>
          )}
          {/* Comes with the material issue, like the destination beside it: the code
              belongs to the office the consignment is addressed to, so picking the
              issue fills it and nothing on this screen sets it. */}
          <Field label="Service area code (SAC)">
            <Input
              value={destinationSac ?? (destination ? "No service area code for this office" : "—")}
              disabled
            />
          </Field>
          <Field label="Expected delivery">
            {/* Goods cannot arrive before they leave. `min` is the dispatch date, not
                today: a consignment can be back-dated, and its delivery date has to
                stay consistent with whatever date it actually went out on. */}
            <Input type="date" value={form.expected_delivery ?? ""} disabled={locked}
                   min={form.dispatch_date || undefined}
                   onChange={(event) => setForm((f) => ({ ...f, expected_delivery: event.target.value || null }))} />
          </Field>
          {/* How it travels (mode, carrier) and who moves it (vehicle, driver, LR,
              the delivery address) are the warehouse's half of the document: derived
              from, or written against, the material issue. The logistics door shows
              none of them — the mode and the provider are the one decision the floor
              makes on the DISPATCH press, not here, and the rest still travel with
              the payload untouched. */}
          {!inLogistics && (
            <>
              <Field label="Mode">
                <Select value={form.transport_mode ?? "ROAD"} onChange={(value) => setForm((f) => ({ ...f, transport_mode: value }))}
                        options={MODES} isDisabled={locked} />
              </Field>
              <Field label="Carrier">
                <Lookup name="carriers" load={carrierOptions} value={form.carrier_id ?? ""} isDisabled={locked}
                        onChange={pickCarrier}
                        placeholder="Carrier" />
              </Field>
              {/* Not editable: nothing on this screen chooses a vehicle — the number is
                  read off the issue or the destination office's name. See `vehicleOf`. */}
              <Field label="Vehicle">
                <Input value={vehicleNumber || "—"} disabled />
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
            </>
          )}
        </div>
      </ConsignmentSection>

      <ConsignmentSection
        title="Packages"
        icon={Package}
        hint={inLogistics
          ? "Select issued items for the open package. Locking it automatically opens the next package only when quantity remains."
          : "Lock each package after its quantities and serials are correct. Add the next package only after the current one is locked."}
        actions={!inLogistics && !locked && (
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
        <div className="mb-5 rounded-xl border border-warn/25 bg-warn-bg/60 px-4 py-3.5">
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-warn">
              <AlertCircle className="h-4 w-4 shrink-0" /> Complete these before saving
            </div>
            <ul className="grid gap-1.5 text-xs leading-5 text-body md:grid-cols-2">
              {formIssues.slice(0, 8).map((issue) => (
                <li key={issue}>• {issue}</li>
              ))}
              {formIssues.length > 8 && <li>• {formIssues.length - 8} more issue(s)</li>}
            </ul>
          </div>
        )}
        {!source && !doc ? (
          <div className="rounded-xl border border-dashed border-line px-4 py-12 text-center text-sm text-muted">
            Select a material issue to load issue lines.
          </div>
        ) : (
          <div className="space-y-5">
            {inLogistics && (() => {
              const editablePackageIndex = packages.findIndex((pkg) => !pkg.locked);
              const editablePackage = packages[editablePackageIndex];
              return (
                <div className="overflow-hidden rounded-xl border border-line bg-content1">
                  <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3.5 sm:px-5">
                    <div className="min-w-0">
                      <h3 className="font-display text-sm font-bold text-ink">Issued items</h3>
                      <p className="mt-0.5 text-xs leading-5 text-muted">
                        Select only the items going into {editablePackage?.package_no ?? "the open package"}. The issue total stays fixed; To pack is the live balance.
                      </p>
                    </div>
                    <div className="shrink-0 text-xs text-muted">
                      Remaining to pack: <b className="tabular text-ink">{fmtQty(remainingToPack)}</b>
                    </div>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="min-w-[760px] w-full text-sm">
                      <thead className="border-b border-line bg-content2/45 text-left text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
                        <tr>
                          <th className="px-3 py-2">Item</th>
                          <th className="px-3 py-2">Batch</th>
                          <th className="px-3 py-2">Mfg</th>
                          <th className="px-3 py-2">Expiry</th>
                          <th className="px-3 py-2 text-right">Issued total</th>
                          <th className="px-3 py-2 text-right">To pack</th>
                          <th className="px-3 py-2">Package</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(source?.items ?? []).map((line) => {
                          const packed = allocation.get(lineKey(line)) ?? 0;
                          const remaining = Math.max(0, num(line.quantity) - packed);
                          const selected = !!editablePackage && !!packageLine(editablePackage, line);
                          return (
                            <tr key={lineKey(line)} className="border-t border-line/70 transition-colors hover:bg-content2/40">
                              <td className="px-3 py-2">
                                <div className="font-mono text-xs font-semibold text-ink">{line.item_code ?? line.item_id}</div>
                                <div className="max-w-[260px] truncate text-xs text-muted">{line.item_name ?? "—"}</div>
                              </td>
                              <td className="px-3 py-2 text-xs text-muted">{line.batch_no ?? "—"}</td>
                              <td className="px-3 py-2 text-xs text-muted">{line.mfg_date ?? "—"}</td>
                              <td className="px-3 py-2 text-xs text-muted">{line.expiry_date ?? "—"}</td>
                              <td className="px-3 py-2.5 text-right tabular text-ink">{fmtQty(line.quantity)} {line.uom_code ?? ""}</td>
                              <td className={`px-3 py-2.5 text-right font-semibold tabular ${remaining === 0 ? "text-ok" : "text-ink"}`}>
                                {fmtQty(remaining)}
                              </td>
                              <td className="px-3 py-2">
                                <Button
                                  variant={selected ? "subtle" : "primary"}
                                  disabled={locked || editablePackageIndex < 0 || (!selected && remaining <= 0)}
                                  onClick={() => {
                                    if (editablePackageIndex < 0) return;
                                    patchPackageLine(editablePackageIndex, line, {
                                      quantity: 0,
                                      serial_numbers: [],
                                      is_serial_tracked: !!line.is_serial_tracked,
                                    }, !selected);
                                  }}
                                >
                                  {selected ? "Remove" : remaining > 0 ? "Select" : "Packed"}
                                </Button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })()}
            {packages.map((pkg, packageIndex) => {
              const pkgErrors = packageErrors(pkg, packageIndex);
              const pkgLocked = locked || !!pkg.locked;
              const pkgQty = pkg.items.reduce((sum, line) => sum + packageQty(line), 0);
              const laterOpenPackageHasSelections = packages.slice(packageIndex + 1).some(
                (row) => !row.locked && row.items.length > 0,
              );
              return (
              <div key={pkg.key} className={`overflow-hidden rounded-xl border bg-content1 ${
                pkgLocked ? "border-ok/35" : pkgErrors.length ? "border-warn/35" : "border-line"
              }`}>
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3.5 sm:px-5">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                    <div className="flex items-center gap-2.5">
                      <Package className={`h-4 w-4 shrink-0 ${pkgLocked ? "text-ok" : "text-brand"}`} />
                      <h3 className="font-display text-sm font-bold text-ink">
                        {pkg.package_no || `Package ${packageIndex + 1}`}
                      </h3>
                      <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                        pkgLocked ? "border-ok/40 text-ok" : "border-warn/40 text-warn"
                      }`}>
                        {pkgLocked ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
                        {pkgLocked ? "Locked" : "Editable"}
                      </span>
                    </div>
                    <div className="text-xs text-muted">
                      {fmtQty(pkgQty)} packed in this package
                    </div>
                  </div>
                  {!locked && (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant={pkg.locked ? "subtle" : "primary"}
                        disabled={pkg.locked
                          ? inLogistics && laterOpenPackageHasSelections
                          : pkgErrors.length > 0}
                        onClick={() => {
                          if (pkg.locked && inLogistics) {
                            // Reopening a package should return the packer to that
                            // package. Discard only the empty draft auto-created
                            // after it; never discard a package that has quantities.
                            setPackages((rows) => rows
                              .filter((row, index) => index <= packageIndex || row.locked || row.items.length > 0)
                              .map((row, index) => (index === packageIndex ? { ...row, locked: false } : row)));
                          } else if (pkg.locked) patchPackage(packageIndex, { locked: false });
                          else if (inLogistics) lockLogisticsPackage(packageIndex);
                          else patchPackage(packageIndex, { locked: true });
                        }}
                      >
                        {pkg.locked ? <Unlock className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
                        {pkg.locked ? "Unlock package" : "Lock package"}
                      </Button>
                      {!inLogistics && packages.length > 1 && !pkg.locked && (
                        <Button variant="danger" onClick={() => setPackages((rows) => rows.filter((_, i) => i !== packageIndex))}>
                          <Trash2 className="h-4 w-4" /> Remove
                        </Button>
                      )}
                    </div>
                  )}
                </div>
                <div className="p-4 sm:p-5">
                  {pkgErrors.length > 0 && !pkgLocked && (
                    <div className="mb-4 flex items-start gap-2 rounded-xl border border-warn/25 bg-warn-bg/60 px-3 py-2.5 text-xs text-warn">
                      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                      <ul className="space-y-1">
                        {pkgErrors.map((message) => <li key={message}>{message}</li>)}
                      </ul>
                    </div>
                  )}
                <div className="mb-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
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
                  {!inLogistics && (
                    <div className="flex items-end pb-2.5 text-xs text-muted">
                      <div>
                        Remaining after all packages: <b className="tabular text-ink">{fmtQty(remainingToPack)}</b>
                      </div>
                    </div>
                  )}
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
                  {/* Two flags, not two more panels: a tinted box inside a tinted
                      grid inside a card was three frames deep for one checkbox each. */}
                  <div className="flex flex-wrap items-center gap-x-7 gap-y-2 border-t border-line pt-4 sm:col-span-2 lg:col-span-4">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">Handling</div>
                    <label className={`flex min-h-11 items-center gap-2 text-sm ${
                      pkgLocked ? "cursor-not-allowed text-muted" : "cursor-pointer text-body"
                    }`}>
                      <Checkbox isSelected={!!pkg.is_fragile} isDisabled={pkgLocked}
                                onValueChange={(value) => patchPackage(packageIndex, { is_fragile: value })} />
                      <span className={pkg.is_fragile ? "font-semibold text-ink" : ""}>Fragile</span>
                    </label>
                    <label className={`flex min-h-11 items-center gap-2 text-sm ${
                      pkgLocked ? "cursor-not-allowed text-muted" : "cursor-pointer text-body"
                    }`}>
                      <Checkbox isSelected={!!pkg.is_temp_controlled} isDisabled={pkgLocked}
                                onValueChange={(value) => patchPackage(packageIndex, { is_temp_controlled: value })} />
                      <span className={pkg.is_temp_controlled ? "font-semibold text-ink" : ""}>Temperature controlled</span>
                    </label>
                  </div>
                </div>

                <div className="overflow-x-auto rounded-xl border border-line bg-content1">
                  <table className="min-w-[980px] w-full text-sm">
                    <thead className="border-b border-line bg-content2/45 text-left text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
                      <tr>
                        <th className="px-3 py-2">Item</th>
                        <th className="px-3 py-2">Batch</th>
                        <th className="px-3 py-2">Mfg</th>
                        <th className="px-3 py-2">Expiry</th>
                        <th className="px-3 py-2 text-right">Issued total</th>
                        <th className="px-3 py-2 text-right">To pack</th>
                        {!inLogistics && <th className="px-3 py-2 text-right">Packed</th>}
                        <th className="px-3 py-2 text-right">This package</th>
                        <th className="px-3 py-2">Serials</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(inLogistics
                        ? (source?.items ?? []).filter((line) => !!packageLine(pkg, line))
                        : (source?.items ?? [])
                      ).map((line) => {
                        const current = packageLine(pkg, line);
                        const packed = allocation.get(lineKey(line)) ?? 0;
                        const thisQty = num(current?.quantity);
                        // In this package but with nothing written against it.
                        const needsQty = inLogistics && !pkgLocked && thisQty <= 0;
                        const remaining = Math.max(0, num(line.quantity) - packed + thisQty);
                        // What is still unpacked across every package - this package's own qty
                        // is already counted in `packed`, so it is excluded here on purpose.
                        const outstanding = Math.max(0, num(line.quantity) - packed);
                        const complete = packed === num(line.quantity);
                        return (
                          <tr key={lineKey(line)} className="border-t border-line/70 transition-colors hover:bg-content2/40">
                            <td className="px-3 py-2">
                              <div className="font-mono text-xs font-semibold text-ink">{line.item_code ?? line.item_id}</div>
                              <div className="max-w-[260px] truncate text-xs text-muted">{line.item_name ?? "—"}</div>
                            </td>
                            <td className="px-3 py-2 text-xs text-muted">{line.batch_no ?? "—"}</td>
                            <td className="px-3 py-2 text-xs text-muted">{line.mfg_date ?? "—"}</td>
                            <td className="px-3 py-2 text-xs text-muted">{line.expiry_date ?? "—"}</td>
                            <td className="px-3 py-2.5 text-right tabular text-ink">{fmtQty(line.quantity)} {line.uom_code ?? ""}</td>
                            <td className={`px-3 py-2.5 text-right font-semibold tabular ${outstanding === 0 ? "text-ok" : "text-ink"}`}>
                              {fmtQty(outstanding)}
                            </td>
                            {!inLogistics && (
                              <td className={`px-3 py-2 text-right tabular ${complete ? "text-ok" : "text-body"}`}>
                                {fmtQty(packed)}
                              </td>
                            )}
                            <td className="px-3 py-2 text-right">
                              <Input
                                className={`text-right ${needsQty ? "ring-1 ring-warn/50" : ""}`}
                                type="number"
                                min={0}
                                max={remaining}
                                disabled={pkgLocked}
                                onWheel={(event) => event.currentTarget.blur()}
                                // Empty, not "0", while the field is being retyped: a
                                // cleared box that reprints 0 turns the next keystroke
                                // into "05".
                                value={thisQty > 0 ? String(thisQty) : ""}
                                onChange={(event) => {
                                  const nextQty = Math.min(Number(event.target.value || 0), remaining);
                                  const nextSerials = (current?.serial_numbers ?? []).slice(0, Math.floor(nextQty));
                                  // keepEmpty: clearing the number is editing it, not
                                  // dropping the item. Without it the backspace that
                                  // emptied the box pruned the line from the package,
                                  // and on the logistics door — which lists only the
                                  // lines the package holds — the row vanished
                                  // mid-keystroke. Remove is the only way out.
                                  patchPackageLine(packageIndex, line, {
                                    quantity: nextQty,
                                    serial_numbers: line.is_serial_tracked ? nextSerials : current?.serial_numbers,
                                    is_serial_tracked: !!line.is_serial_tracked,
                                  }, true);
                                }}
                              />
                              {needsQty && (
                                <div className="mt-1 text-[11px] font-semibold text-warn">Enter a quantity</div>
                              )}
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
              </div>
              );
            })}
          </div>
        )}
      </ConsignmentSection>

      {editing && (
        <>
          <ConsignmentSection title="Summary" icon={ClipboardCheck} hint="A quick view of the packed consignment.">
            <div className="grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-3">
              <div className="bg-content1 px-4 py-4">
                <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">Packages</div>
                <div className="mt-1.5 font-display text-2xl font-bold tabular text-ink">{totals.packages}</div>
              </div>
              <div className="bg-content1 px-4 py-4">
                <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">Packed qty</div>
                <div className="mt-1.5 font-display text-2xl font-bold tabular text-ink">{fmtQty(totals.qty)}</div>
              </div>
              <div className="bg-content1 px-4 py-4">
                <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">Value</div>
                <div className="mt-1.5 font-display text-2xl font-bold tabular text-ink">₹ {fmtMoney(totals.value)}</div>
              </div>
            </div>
          </ConsignmentSection>

          <ConsignmentSection
            title="Scan labels"
            icon={ScanLine}
            hint="Consignment and package identities. Each card carries both QR and barcode for scanning."
            actions={
              <Button onClick={() => window.print()} disabled={scanCards.length === 0}>
                <Printer className="h-4 w-4" /> Print labels
              </Button>
            }
          >
            {/* The printed sheet is its own copy of the cards, portalled to <body>.
                Printing the on-screen node put it inside a clipping card and the paper
                came out blank; see PrintPortal. */}
            <PrintPortal id="wh-consignment-scan-labels">
              {scanCards.map((card) => (
                <ScanCard key={`print-${card.accent}-${card.code}`} spec={card} />
              ))}
            </PrintPortal>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {scanCards.map((card) => (
                <ScanCard key={`${card.accent}-${card.code}`} spec={card} />
              ))}
            </div>
          </ConsignmentSection>
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
