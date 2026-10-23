import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Checkbox } from "@heroui/react";
import Barcode from "react-barcode";
import { QRCodeSVG } from "qrcode.react";
import { AlertCircle, ArrowLeft, CheckCheck, CheckCircle2, ClipboardCheck, Download, Layers, Lock, MapPin, Package, PackagePlus, Printer, QrCode, ScanLine, Trash2, Truck, Unlock, XCircle } from "lucide-react";
import { Button, Can, ErrorBanner, Field, Input, Select } from "@/shared/components";
import { ConsignmentIdentityCard, type ConsignmentIssue } from "../components/ConsignmentIdentityCard";
import { PrintPortal } from "../components/LabelPrint";
import { Lookup } from "../components/Lookup";
import { MultiIssuePanel, type IssueRoute, type SelectedIssue } from "../components/MultiIssuePanel";
import { SerialNumbersModal } from "../components/SerialNumbersModal";
import {
  carrierOptions,
  createConsignment,
  getConsignment,
  getIssueDispatchSource,
  getIssueDispatchSources,
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

/**
 * One row per material-issue LINE.
 *
 * Keyed on (issue, item, batch) before, which is not unique: one batch drawn from two
 * storage locations is two issue lines, and both rows shared a key — typing a quantity
 * into one wrote it into the other, and both showed the same codes. The issue line id
 * is the identity; the old triple stays only for consignments saved before the server
 * carried it, where both sides of the form are built from the same rows and agree.
 */
const lineKey = (line: Pick<IssueDispatchSourceItem, "issue_id" | "item_id" | "batch_id" | "issue_item_id">) =>
  line.issue_item_id
    ? `line:${line.issue_item_id}`
    : `${line.issue_id ?? 0}:${line.item_id}:${line.batch_id ?? 0}`;

const itemLabel = (line: IssueDispatchSourceItem) =>
  `${line.item_code ?? line.item_id}${line.batch_no ? ` / ${line.batch_no}` : ""}${line.bin_code ? ` @ ${line.bin_code}` : ""}`;

/** What one code on a row is called, in the plural. */
const CODE_NOUN: Record<string, string> = {
  SERIAL: "serials", IMEI: "IMEIs", ASSET: "asset codes", CONSUMABLE: "codes",
};
const codeNoun = (line: IssueDispatchSourceItem) =>
  CODE_NOUN[line.tracking_type ?? ""] ?? (line.is_imei_tracked ? "IMEIs" : "serials");

/** Asset and consumable codes are the system's own labels, so the screen may choose
 *  them; a serial or an IMEI is read off the goods and only ever follows the count. */
const autoCoded = (line: IssueDispatchSourceItem) =>
  line.tracking_type === "ASSET" || line.tracking_type === "CONSUMABLE";

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
  publicToken: string;
  title: string;
  subtitle?: string;
  accent: "consignment" | "package";
  meta: { label: string; value: string | number | null | undefined }[];
  /** Printed on the label itself, so a carton can be checked without a scanner. */
  lines?: { code: string; name: string; qty: string }[];
};

/** How many content lines fit on a label before it stops being one card. */
const LABEL_LINES = 6;

/** A deployment normally uses its current public origin. Developers printing from
 * localhost can set this to the PC's LAN URL, e.g. http://192.168.1.20:5173. */
const publicAppOrigin = () => (
  (import.meta.env.VITE_PUBLIC_APP_URL as string | undefined)?.trim().replace(/\/+$/, "")
  || window.location.origin
);

/** The QR matrix and the barcode encoding, and NOTHING that changes while packing.
 *
 *  qrcode.react recomputes the error-correction matrix and react-barcode re-runs
 *  JsBarcode on every render they are given. Inline in `ScanCard` — which is drawn
 *  twice per card, once on screen and once in the print portal — that was every label
 *  on the consignment re-encoding itself on every quantity keystroke and every button
 *  press, which is what made the screen feel stuck. Both codes depend on one string,
 *  so they are memoised on it and a packing edit costs nothing here. */
const ScanQr = memo(function ScanQr({
  value, size = 108, level = "M",
}: {
  value: string;
  size?: number;
  level?: "L" | "M" | "Q" | "H";
}) {
  return <QRCodeSVG value={value} size={size} level={level} />;
});
const ScanBarcode = memo(function ScanBarcode({ code }: { code: string }) {
  return (
    <div className="overflow-hidden">
      <Barcode value={code} height={54} width={1.35} fontSize={12} margin={0} displayValue />
    </div>
  );
});

/** One card's identity — which label a per-card download prints. */
const scanKey = (card: ScanCardSpec) => `${card.accent}-${card.code}`;

function ScanCard({ spec, onDownload }: { spec: ScanCardSpec; onDownload?: () => void }) {
  const accent = spec.accent === "consignment"
    ? "border-brand/40 bg-brand-050/30"
    : "border-line bg-content1";
  const appOrigin = publicAppOrigin();
  const onlineUrl = `${appOrigin}/c/${spec.publicToken}`;
  let onlineIsLocal = false;
  try {
    onlineIsLocal = ["localhost", "127.0.0.1", "::1"].includes(new URL(appOrigin).hostname);
  } catch {
    onlineIsLocal = true;
  }
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
        <div className="flex shrink-0 items-center gap-2">
          <div className="rounded-md bg-content1 px-2 py-1 font-mono text-[11px] font-semibold text-ink">
            {spec.code}
          </div>
          {onDownload && (
            <button
              type="button"
              onClick={onDownload}
              title="Download this label (choose Save as PDF)"
              aria-label={`Download label ${spec.code}`}
              className="flex h-11 w-11 items-center justify-center rounded-lg border border-line bg-white text-brand hover:bg-brand-050 print:hidden"
            >
              <Download className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[128px_1fr]">
        {/* One short signed URL: easy to scan, current at open time, and incapable of
            granting access to any application route. */}
        <div className="flex flex-col items-center rounded-lg border border-line bg-white p-2 text-center">
          <div className="mb-1 text-[9px] font-bold uppercase tracking-wide text-brand">Scan · View details</div>
          <ScanQr value={onlineUrl} size={108} level="M" />
          <div className="mt-1 text-[9px] leading-tight text-muted">
            {onlineIsLocal ? "Open this app by its LAN address before printing" : "Current read-only details"}
          </div>
        </div>
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
    issue_ids: [],
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
  const [sourceMode, setSourceMode] = useState<"single" | "multiple">("single");
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
    const docIssueIds = (doc.sources ?? []).map((row) => row.issue_id).filter((value): value is number => !!value);
    setForm({
      issue_id: doc.ref_id ?? docIssueIds[0] ?? 0,
      issue_ids: docIssueIds,
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
    setSourceMode((doc.sources?.length ?? 0) > 1 || doc.ref_type === "MULTI_ISSUE" ? "multiple" : "single");
    const grouped = (doc.packages ?? []).map((pkg) => {
      const byPackageLine = new Map<string, ConsignmentPackageItemWrite>();
      (doc.items ?? [])
        .filter((line) => line.package_id === pkg.id)
        .forEach((line) => {
          const key = lineKey(line);
          const existing = byPackageLine.get(key);
          byPackageLine.set(key, {
            ...(existing ?? {}),
            issue_id: line.issue_id ?? doc.ref_id ?? null,
            issue_no: line.issue_no ?? doc.ref_no ?? null,
            issue_item_id: line.issue_item_id ?? null,
            bin_code: line.bin_code ?? null,
            mr_id: line.mr_id ?? null,
            mr_no: line.mr_no ?? null,
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
        issue_id: line.issue_id ?? doc.ref_id ?? null,
        issue_no: line.issue_no ?? doc.ref_no ?? null,
        issue_item_id: line.issue_item_id ?? null,
        bin_code: line.bin_code ?? null,
        mr_id: line.mr_id ?? null,
        mr_no: line.mr_no ?? null,
        indent_id: line.indent_id,
        indent_no: line.indent_no ?? null,
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
      issue_id: doc.ref_id ?? docIssueIds[0] ?? 0,
      issue_ids: docIssueIds,
      issue_no: doc.ref_no ?? "",
      issue_nos: (doc.sources ?? []).map((row) => row.issue_no).filter((value): value is string => !!value),
      warehouse_id: doc.warehouse_id,
      project_id: doc.project_id,
      destination_office_id: doc.destination_office_id ?? null,
      destination_office_name: doc.destination_office_name ?? doc.delivery_address ?? null,
      destination_office_sac: doc.destination_office_sac ?? null,
      vehicle_number: doc.vehicle_number ?? null,
      destination_warehouse_id: doc.to_warehouse_id ?? null,
      destination_warehouse_name: doc.to_warehouse_name ?? null,
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

  /** Several material issues at once. The choice is COMMITTED only when the server accepts it:
   *  a rejected addition (another LIP, already packed elsewhere) leaves the list, the
   *  packages and the destination exactly as they were, and the banner says why. The
   *  destination is always the new set's own — never one left over from an earlier
   *  pick, which is how a lot for one LIP could be saved addressed to another. */
  const loadIssues = useMutation({
    mutationFn: (issueIds: number[]) => getIssueDispatchSources(issueIds),
    onSuccess: (result) => {
      setSource(result);
      setPackages([newPackage(0)]);
      setForm((current) => ({
        ...current,
        issue_id: result.issue_ids?.[0] ?? result.issue_id,
        issue_ids: result.issue_ids ?? [result.issue_id],
        project_id: result.project_id ?? current.project_id,
        to_warehouse_id: result.destination_warehouse_id ?? null,
        delivery_address: addressWithoutVehicle(result.destination_office_name),
      }));
    },
  });

  const payload = (): ConsignmentWrite => ({
    ...form,
    packages: packages.map(({ key: _key, locked: _locked, ...pkg }, index) => ({
      ...pkg,
      package_no: pkg.package_no || `PKG-${String(index + 1).padStart(2, "0")}`,
      barcode: pkg.barcode || `${source?.issue_nos?.[0] ?? source?.issue_no ?? "CONS"}|${pkg.package_no || `P${index + 1}`}`,
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
      // The issues just packed must leave every picker and suggestion at once, not
      // after the five-minute lookup cache runs out.
      qc.invalidateQueries({ queryKey: ["consignment-recommendations"] });
      qc.invalidateQueries({
        predicate: (query) => query.queryKey[0] === "wh-lookup"
          && String(query.queryKey[1] ?? "").startsWith("posted-issues"),
      });
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

  /** What the multiple-issue list shows: one row per issue, read off the packing source
   *  the server accepted — so the list and the lines below can never disagree. */
  const selectedIssues: SelectedIssue[] = useMemo(() => {
    const ids = source?.issue_ids ?? [];
    return ids.map((issueId, index) => {
      const lines = (source?.items ?? []).filter((line) => line.issue_id === issueId);
      return {
        issue_id: issueId,
        issue_no: source?.issue_nos?.[index]
          ?? (doc?.sources ?? []).find((row) => row.issue_id === issueId)?.issue_no
          ?? `Issue ${issueId}`,
        indent_nos: Array.from(new Set(lines.map((line) => line.indent_no).filter((no): no is string => !!no))),
        lines: lines.length,
        qty: lines.reduce((sum, line) => sum + num(line.quantity), 0),
      };
    });
  }, [source, doc]);
  /** The issues on the saved consignment, one entry per issue: a source row is per
   *  issue-and-request, so an issue feeding two requests arrives as two rows. */
  const consignmentIssues: ConsignmentIssue[] = useMemo(() => {
    if (!doc) return [];
    const byNo = new Map<string, ConsignmentIssue>();
    for (const row of doc.sources ?? []) {
      const no = row.issue_no ?? row.source_no;
      if (!no) continue;
      const entry = byNo.get(no) ?? { issue_no: no, indent_nos: [], qty: 0 };
      entry.qty += num(row.quantity);
      if (row.indent_no && !entry.indent_nos.includes(row.indent_no)) entry.indent_nos.push(row.indent_no);
      byNo.set(no, entry);
    }
    if (byNo.size === 0 && doc.ref_no) {
      return [{ issue_no: doc.ref_no, indent_nos: [], qty: num(doc.total_qty) }];
    }
    return [...byNo.values()];
  }, [doc]);
  const issueRoute: IssueRoute | null = source?.warehouse_id
    ? {
      warehouseId: source.warehouse_id,
      warehouseName: originName,
      destinationId: source.destination_warehouse_id ?? null,
      destinationName: source.destination_warehouse_name ?? null,
    }
    : null;

  /** The three lookup handlers, stable for the same reason the loader above is: a new
   *  arrow on every render is a changed prop, and a changed prop is a memoised
   *  dropdown re-rendering for a package edit that has nothing to do with it. */
  const pickIssue = useCallback((value: number | "") => {
    const issueId = value === "" ? 0 : value;
    // The destination and address belong to the issue: a new issue brings its own,
    // rather than inheriting the last one's.
    setForm((current) => ({
      ...current, issue_id: issueId, issue_ids: issueId ? [issueId] : [],
      to_warehouse_id: null, delivery_address: "",
    }));
    setSource(null);
    setPackages([newPackage(0)]);
    if (issueId) loadIssue.mutate(issueId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadIssue.mutate]);
  /** Empty the consignment's source entirely — issues, lines, packages, route. */
  const clearSource = useCallback(() => {
    setSource(null);
    setPackages([newPackage(0)]);
    setForm((current) => ({
      ...current, issue_id: 0, issue_ids: [], to_warehouse_id: null, delivery_address: "",
    }));
  }, []);
  /** The issues currently accepted by the server — the base every change starts from. */
  const acceptedIds = source?.issue_ids ?? [];
  const applyIssues = useCallback((issueIds: number[]) => {
    const nextIds = Array.from(new Set(issueIds));
    if (nextIds.length === 0) clearSource();
    else loadIssues.mutate(nextIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearSource, loadIssues.mutate]);
  const addIssue = useCallback(
    (issueId: number) => applyIssues([...acceptedIds, issueId]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [applyIssues, acceptedIds.join(",")],
  );
  const removeIssue = useCallback(
    (issueId: number) => applyIssues(acceptedIds.filter((value) => value !== issueId)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [applyIssues, acceptedIds.join(",")],
  );
  /** Single issue by default; multiple issues is a deliberate switch, and either way
   *  starts from a clean form so nothing chosen under one carries into the other. */
  const switchMode = (mode: "single" | "multiple") => {
    if (mode === sourceMode) return;
    loadIssue.reset();
    loadIssues.reset();
    clearSource();
    setSourceMode(mode);
  };
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
        errors.push(`${itemLabel(sourceLine.line)} is packed above issued quantity.`);
      }
      if (line.is_serial_tracked && (line.serial_numbers?.length ?? 0) !== qty) {
        const noun = sourceLine ? codeNoun(sourceLine.line) : "serials";
        errors.push(`${sourceLine ? itemLabel(sourceLine.line) : line.item_code ?? line.item_id} needs ${fmtQty(qty)} ${noun} selected.`);
      }
    }
    return Array.from(new Set(errors));
  };

  const formIssues = useMemo(() => {
    const issues: string[] = [];
    if (!form.issue_id) issues.push(sourceMode === "multiple" ? "Add at least one material issue." : "Select a material issue.");
    if (!form.expected_delivery) issues.push("Enter expected delivery.");
    packages.forEach((pkg, index) => {
      packageErrors(pkg, index).forEach((message) => issues.push(`${pkg.package_no || `Package ${index + 1}`}: ${message}`));
      if (!pkg.locked) issues.push(`${pkg.package_no || `Package ${index + 1}`}: Lock the package before saving.`);
    });
    lineProgress.forEach(({ issued, packed, line }) => {
      if (packed !== issued) {
        issues.push(`${itemLabel(line)} packed ${fmtQty(packed)} of ${fmtQty(issued)}.`);
      }
    });
    selectedSerials.duplicates.forEach((serial) => issues.push(`${serial} is selected in more than one package.`));
    return Array.from(new Set(issues));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allocation, form.expected_delivery, form.issue_id, lineProgress, packages, selectedSerials, sourceMode]);

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

  /** A package row built off its issue line — every identifying field copied, so two
   *  rows of one batch can never be written back as one. */
  const toPackageLine = (
    sourceLine: IssueDispatchSourceItem,
    existing: ConsignmentPackageItemWrite | undefined,
    patch: Partial<ConsignmentPackageItemWrite>,
  ): ConsignmentPackageItemWrite => ({
    issue_id: sourceLine.issue_id,
    issue_no: sourceLine.issue_no,
    issue_item_id: sourceLine.issue_item_id ?? null,
    bin_code: sourceLine.bin_code ?? null,
    mr_id: sourceLine.mr_id,
    mr_no: sourceLine.mr_no,
    indent_id: sourceLine.indent_id,
    item_id: sourceLine.item_id,
    item_code: sourceLine.item_code,
    item_name: sourceLine.item_name,
    uom_code: sourceLine.uom_code,
    batch_id: sourceLine.batch_id,
    batch_no: sourceLine.batch_no,
    mfg_date: sourceLine.mfg_date,
    expiry_date: sourceLine.expiry_date,
    is_serial_tracked: sourceLine.is_serial_tracked,
    serial_numbers: [],
    quantity: 0,
    rate: sourceLine.rate,
    remarks: sourceLine.remarks,
    ...existing,
    ...patch,
  });

  /** The codes of one issue line that no OTHER package row is carrying yet. */
  const freeCodes = (
    rows: PackageDraft[], packageIndex: number, sourceLine: IssueDispatchSourceItem,
  ) => {
    const used = new Set<string>();
    rows.forEach((pkg, index) => pkg.items.forEach((line) => {
      if (index === packageIndex && lineKey(line) === lineKey(sourceLine)) return;
      line.serial_numbers?.forEach((code) => used.add(code.toLowerCase()));
    }));
    return (sourceLine.serial_numbers ?? []).filter((code) => !used.has(code.toLowerCase()));
  };

  /**
   * Select all: put everything still unpacked into this package, codes included.
   *
   * Each row takes what its OWN issue line has left after every other package — so a
   * second carton "selects all" of the remainder, never the whole issue again — and the
   * codes come off that line's own list, skipping any already in another carton. The
   * whole remainder of a line is a fact, not a guess, which is why serials and IMEIs
   * are filled here too: every one of them is going in.
   */
  const selectAllInto = (packageIndex: number) => setPackages((rows) => {
    const elsewhere = new Map<string, number>();
    rows.forEach((pkg, index) => {
      if (index === packageIndex) return;
      pkg.items.forEach((line) => elsewhere.set(
        lineKey(line), (elsewhere.get(lineKey(line)) ?? 0) + packageQty(line)));
    });
    const target = rows[packageIndex];
    const items = (source?.items ?? []).flatMap((line) => {
      const qty = Math.max(0, num(line.quantity) - (elsewhere.get(lineKey(line)) ?? 0));
      if (qty <= 0) return [];
      const existing = target.items.find((row) => lineKey(row) === lineKey(line));
      const codes = line.is_serial_tracked
        ? freeCodes(rows, packageIndex, line).slice(0, Math.floor(qty))
        : [];
      return [toPackageLine(line, existing, {
        quantity: qty,
        serial_numbers: codes,
        is_serial_tracked: !!line.is_serial_tracked,
      })];
    });
    return rows.map((pkg, index) => (index === packageIndex ? { ...pkg, items } : pkg));
  });

  /** Deselect all: empty this package and hand its quantity back to To pack. */
  const deselectAllFrom = (packageIndex: number) =>
    setPackages((rows) => rows.map((pkg, index) => (
      index === packageIndex ? { ...pkg, items: [] } : pkg)));

  /** What this package could still take — drives whether Select all has anything to do. */
  const canFill = (source?.items ?? []).some(
    (line) => num(line.quantity) > (allocation.get(lineKey(line)) ?? 0));

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
          issue_id: sourceLine.issue_id,
          issue_no: sourceLine.issue_no,
          issue_item_id: sourceLine.issue_item_id ?? null,
          bin_code: sourceLine.bin_code ?? null,
          mr_id: sourceLine.mr_id,
          mr_no: sourceLine.mr_no,
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

  // Which label the next print run carries: null = every card on the sheet.
  const [printOnly, setPrintOnly] = useState<string | null>(null);
  /** Print one label, or all of them. The browser's dialog is the download — "Save as
   *  PDF" names the file after the label, because the page title is the label's code
   *  for the duration of the print run. flushSync so the sheet is narrowed to that one
   *  card BEFORE the dialog snapshots the page. */
  const printLabels = (card: ScanCardSpec | null) => {
    const title = document.title;
    flushSync(() => setPrintOnly(card ? scanKey(card) : null));
    document.title = (card ? `Label ${card.code}` : `Labels ${doc?.dispatch_no ?? ""}`)
      .trim().replace(/[\/|:*?"<>]/g, "-");
    try {
      window.print();
    } finally {
      document.title = title;
      setPrintOnly(null);
    }
  };

  const scanCards: ScanCardSpec[] = useMemo(() => {
    if (!doc?.public_scan_token) return [];
    return [{
      code: doc.dispatch_no,
      publicToken: doc.public_scan_token,
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
    ...packages.flatMap((pkg, index): ScanCardSpec[] => {
      const publicToken = (doc.packages ?? [])
        .find((saved) => String(saved.id) === pkg.key)?.public_scan_token;
      if (!publicToken) return [];
      return [{
      code: pkg.barcode || `${doc.dispatch_no}|${pkg.package_no || `P${index + 1}`}`,
      publicToken,
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
    }];
    }),
  ];
  }, [doc, packages, destination]);

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
            {/* Single issue is the default. Multiple issues is one deliberate press, up
                here where it is seen before anything is picked. */}
            {!editing && (
              <Can do="dispatch.create">
                <Button
                  variant={sourceMode === "multiple" ? "soft" : "subtle"}
                  onClick={() => switchMode(sourceMode === "multiple" ? "single" : "multiple")}
                  disabled={loadIssue.isPending || loadIssues.isPending}
                >
                  <Layers className="h-4 w-4" />
                  {sourceMode === "multiple" ? "Back to single issue" : "Multiple material issues"}
                </Button>
              </Can>
            )}
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
                <Button variant="soft" onClick={() => nav(dispatchPath(doc.id))} disabled={!doc.expected_delivery}>
                  <Truck className="h-4 w-4" /> Process dispatch
                </Button>
              </Can>
            )}
            {!locked && (
              <Can do="dispatch.create">
                <Button
                  onClick={() => save.mutate()}
                  disabled={save.isPending || formIssues.length > 0}
                  title={formIssues.length > 0 ? formIssues[0] : undefined}
                >
                  {save.isPending ? "Saving..." : "Save consignment"}
                </Button>
              </Can>
            )}
          </>
        }
      />

      <ErrorBanner error={save.error ?? loadIssue.error ?? loadIssues.error} />

      {/* What this consignment IS comes first — the number, the route, the load —
          and what it carries follows. */}
      {doc && (
        <ConsignmentIdentityCard
          dispatchNo={doc.dispatch_no}
          status={doc.status}
          from={originName}
          to={destination}
          sac={destinationSac}
          issues={consignmentIssues}
          packages={doc.total_packages}
          quantity={num(doc.total_qty)}
        />
      )}

      {sourceMode === "multiple" && (
        <MultiIssuePanel
          selected={selectedIssues}
          route={issueRoute}
          busy={loadIssues.isPending}
          readOnly={editing || locked}
          onUseSuggestion={applyIssues}
          onAdd={addIssue}
          onRemove={removeIssue}
          onClear={clearSource}
        />
      )}

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

      <ConsignmentSection
        title={inLogistics ? "Consignment Details" : "Material issue"}
        icon={ClipboardCheck}
        hint="Set the consignment route and delivery information before packing."
      >
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
          <Field label={sourceMode === "multiple" ? "Material issues in this consignment" : "Against material issue"}>
            {sourceMode === "multiple" ? (
              // Chosen in the multiple-issue panel above; this only states the count.
              <Input
                value={selectedIssues.length
                  ? `${selectedIssues.length} material issue${selectedIssues.length === 1 ? "" : "s"} selected`
                  : "Add material issues above"}
                disabled
              />
            ) : (
              <Lookup
                name="posted-issues"
                load={issueOptions}
                value={form.issue_id || ""}
                isDisabled={locked || editing}
                onChange={pickIssue}
                placeholder="Select material issue"
              />
            )}
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
          <Field label="Expected delivery" required>
            {/* Goods cannot arrive before they leave. `min` is the dispatch date, not
                today: a consignment can be back-dated, and its delivery date has to
                stay consistent with whatever date it actually went out on. */}
            <Input type="date" value={form.expected_delivery ?? ""} disabled={locked}
                   aria-required="true"
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
            {sourceMode === "multiple"
              ? "Add material issues above to load their issued items."
              : "Select a material issue to load issue lines."}
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
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      <span className="mr-1 text-xs text-muted">
                        Remaining to pack: <b className="tabular text-ink">{fmtQty(remainingToPack)}</b>
                      </span>
                      {!locked && editablePackageIndex >= 0 && (
                        <SelectAllBar
                          canSelect={canFill}
                          canClear={(editablePackage?.items.length ?? 0) > 0}
                          onSelect={() => selectAllInto(editablePackageIndex)}
                          onClear={() => deselectAllFrom(editablePackageIndex)}
                        />
                      )}
                    </div>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="min-w-[760px] w-full text-sm">
                      <thead className="border-b border-line bg-content2/45 text-left text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
                        <tr>
                          <th className="px-3 py-2">Item</th>
                          <th className="px-3 py-2">Batch / location</th>
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
                              <td className="px-3 py-2"><BatchPlace line={line} /></td>
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
                    <div className="flex flex-wrap items-center gap-2">
                      {!pkgLocked && (
                        <SelectAllBar
                          canSelect={canFill}
                          canClear={pkg.items.length > 0}
                          onSelect={() => selectAllInto(packageIndex)}
                          onClear={() => deselectAllFrom(packageIndex)}
                        />
                      )}
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
                           placeholder={`${source?.issue_nos?.[0] ?? source?.issue_no ?? "CONS"}|${pkg.package_no ?? `P${packageIndex + 1}`} (auto)`} />
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
                        <th className="px-3 py-2">Batch / location</th>
                        <th className="px-3 py-2">Mfg</th>
                        <th className="px-3 py-2">Expiry</th>
                        <th className="px-3 py-2 text-right">Issued total</th>
                        <th className="px-3 py-2 text-right">To pack</th>
                        {!inLogistics && <th className="px-3 py-2 text-right">Packed</th>}
                        <th className="px-3 py-2 text-right">This package</th>
                        <th className="px-3 py-2">Codes</th>
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
                            <td className="px-3 py-2"><BatchPlace line={line} /></td>
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
                                  // Trim when lowered; for asset/consumable codes also TOP UP
                                  // when raised, from this line's codes no other carton holds.
                                  const kept = (current?.serial_numbers ?? []).slice(0, Math.floor(nextQty));
                                  const nextSerials = autoCoded(line)
                                    ? [...kept, ...freeCodes(packages, packageIndex, line)
                                        .filter((code) => !kept.includes(code))]
                                        .slice(0, Math.floor(nextQty))
                                    : kept;
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
                                    <><CheckCircle2 className="h-4 w-4 text-ok" /> {thisQty} {codeNoun(line)}</>
                                  ) : thisQty > 0 ? (
                                    <span className="text-warn">{current?.serial_numbers?.length ?? 0}/{thisQty} {codeNoun(line)}</span>
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
              <Button onClick={() => printLabels(null)} disabled={scanCards.length === 0}>
                <Printer className="h-4 w-4" /> Print all labels
              </Button>
            }
          >
            {/* The printed sheet is its own copy of the cards, portalled to <body>.
                Printing the on-screen node put it inside a clipping card and the paper
                came out blank; see PrintPortal. */}
            <PrintPortal id="wh-consignment-scan-labels">
              {scanCards
                .filter((card) => printOnly === null || scanKey(card) === printOnly)
                .map((card) => (
                  <ScanCard key={`print-${scanKey(card)}`} spec={card} />
                ))}
            </PrintPortal>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {scanCards.map((card) => (
                <ScanCard key={scanKey(card)} spec={card} onDownload={() => printLabels(card)} />
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

/** The batch, and under it the storage location the issue line drew from. Two rows of
 *  one batch are two locations; without the second line they read as a duplicate. */
function BatchPlace({ line }: { line: IssueDispatchSourceItem }) {
  return (
    <div className="min-w-0 text-xs">
      <div className="font-mono text-body">{line.batch_no ?? "—"}</div>
      {line.bin_code && (
        <div className="mt-0.5 flex items-center gap-1 text-[11px] text-muted" title="Storage location">
          <MapPin className="h-3 w-3 shrink-0 text-brand" aria-hidden />
          <span className="truncate font-mono">{line.bin_code}</span>
        </div>
      )}
    </div>
  );
}

/** Select all / Deselect all for one package. */
function SelectAllBar({ canSelect, canClear, onSelect, onClear }: {
  canSelect: boolean; canClear: boolean; onSelect: () => void; onClear: () => void;
}) {
  return (
    <div className="inline-flex items-center gap-1 rounded-xl border border-line bg-content2/40 p-1">
      <Button variant="ghost" disabled={!canSelect} onClick={onSelect}
              title="Put everything still to pack into this package, with its codes">
        <CheckCheck className="h-4 w-4 text-ok" /> Select all
      </Button>
      <Button variant="ghost" disabled={!canClear} onClick={onClear}
              title="Empty this package; its quantity goes back to To pack">
        <XCircle className="h-4 w-4 text-muted" /> Deselect all
      </Button>
    </div>
  );
}

function indexOrZero(value: number | undefined) {
  return value && value > 0 ? value - 1 : 0;
}
