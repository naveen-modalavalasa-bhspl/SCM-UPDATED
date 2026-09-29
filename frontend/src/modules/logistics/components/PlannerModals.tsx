import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MapPin, MapPinned, Scale } from "lucide-react";
import { Alert, Button, ConfirmModal, ErrorBanner, Input, useAction } from "@/shared/components";
import { tripApi } from "../api";
import { LOAD_BASIS_WORDS, approx, cbm, kg } from "./tripLoad";

/**
 * Where is this stocking point? The gazetteer's candidates, ranked with the office's
 * own district first, to confirm with one press — the matcher declined to guess
 * because the name is ambiguous, and a person who knows the district is the reliable
 * answer to that. Clicking the map stays one press away for a point no gazetteer
 * knows (a "Backup" vehicle, a new PHC).
 */
export function PointLocatorModal({ point, onUse, onPickOnMap, onClose }: {
  point: { id: number; name: string } | null;
  onUse: (at: { lat: number; lon: number; label: string }) => void;
  onPickOnMap: () => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => { setSearch(""); setQuery(""); }, [point?.id]);
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), 350);
    return () => window.clearTimeout(timer);
  }, [search]);

  const found = useQuery({
    queryKey: ["trip-point-candidates", point?.id, query],
    queryFn: () => tripApi.candidates(point!.id, query || undefined),
    enabled: point != null,
    staleTime: 5 * 60_000,
  });
  const rows = found.data?.candidates ?? [];

  return (
    <ConfirmModal isOpen={point != null} title={`Locate ${point?.name ?? ""}`}
      confirmLabel="Click it on the map instead" onConfirm={onPickOnMap} onClose={onClose}>
      <div className="space-y-3 text-sm">
        <p className="text-muted">
          {found.data?.district
            ? <>HCM puts this office in{found.data.mandal ? <> <b className="text-body">{found.data.mandal}</b> mandal,</> : null}{" "}
              <b className="text-body">{found.data.district}</b>. Places there are listed first.</>
            : "Places with this name in the gazetteer and the postal directory."}
        </p>
        <Input value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder={found.data?.query ? `Searching “${found.data.query}” — type another spelling` : "Search a place name"}
          aria-label="Search the gazetteer" />
        <ErrorBanner error={found.error} />
        {found.isLoading && <p className="text-xs text-muted">Searching the gazetteer…</p>}
        {!found.isLoading && !rows.length && (
          <Alert tone="info">Nothing of that name. Try another spelling, or click the point on the map.</Alert>
        )}
        <ul className="max-h-80 space-y-1.5 overflow-y-auto pr-1">
          {rows.map((row) => (
            <li key={`${row.label}-${row.latitude}-${row.longitude}`}
              className={`flex items-start gap-3 rounded-lg border px-3 py-2 ${row.in_mandal
                ? "border-ok bg-ok-bg/60" : row.in_district ? "border-ok/40 bg-ok-bg/40" : "border-line bg-content1"}`}>
              <MapPin className={`mt-0.5 h-4 w-4 shrink-0 ${row.in_district || row.in_mandal ? "text-ok" : "text-muted"}`} />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-ink">{row.label}</div>
                <div className="text-[11px] text-muted">
                  {row.in_mandal ? "In the office's mandal" : row.in_district ? "In the office's district" : "Another district"}
                  {row.mandal ? ` · ${row.mandal} mandal` : ""}
                  {!row.precise && " · postcode area only — check the exact spot"}
                  {" · "}{row.latitude.toFixed(4)}, {row.longitude.toFixed(4)}
                </div>
              </div>
              <Button variant="subtle" onClick={() => onUse({ lat: row.latitude, lon: row.longitude, label: row.label })}>
                Use this
              </Button>
            </li>
          ))}
        </ul>
        <p className="flex items-center gap-1.5 text-[11px] text-muted">
          <MapPinned className="h-3.5 w-3.5" /> Choosing one still opens the coordinates to check before they are saved.
        </p>
      </div>
    </ConfirmModal>
  );
}

type Row = { weight: string; length: string; width: string; height: string };

const toNumber = (value: string) => (value.trim() === "" ? null : Number(value));
const text = (value: unknown) => (value == null || value === "" ? "" : String(Number(value)));

/**
 * Weigh and measure a packed consignment's cartons, from the planner — the one screen
 * where a missing figure actually costs something, because it has to decide whether
 * the load fits. What the planner counts it as, and on what basis, is shown above the
 * form, so the desk can see the guess it is replacing.
 */
export function MeasureModal({ consignment, onClose }: {
  consignment: { dispatch_id: number; consignment_no: string } | null;
  onClose: () => void;
}) {
  const detail = useQuery({
    queryKey: ["trip-consignment-packages", consignment?.dispatch_id],
    queryFn: () => tripApi.packages(consignment!.dispatch_id),
    enabled: consignment != null,
  });
  const [rows, setRows] = useState<Record<number, Row>>({});
  useEffect(() => {
    if (!detail.data) return;
    setRows(Object.fromEntries(detail.data.packages.map((pkg) => [pkg.id, {
      weight: text(pkg.weight_kg), length: text(pkg.length_cm),
      width: text(pkg.width_cm), height: text(pkg.height_cm),
    }])));
  }, [detail.data]);

  const packages = detail.data?.packages ?? [];
  const invalid = Object.values(rows).some((row) =>
    [row.weight, row.length, row.width, row.height].some((value) =>
      value.trim() !== "" && !(Number(value) > 0)));
  const changed = packages.filter((pkg) => {
    const row = rows[pkg.id];
    return row && (row.weight !== text(pkg.weight_kg) || row.length !== text(pkg.length_cm)
      || row.width !== text(pkg.width_cm) || row.height !== text(pkg.height_cm));
  });

  const save = useAction({
    run: () => tripApi.measure(consignment!.dispatch_id, changed.map((pkg) => ({
      package_id: pkg.id, weight_kg: toNumber(rows[pkg.id].weight),
      length_cm: toNumber(rows[pkg.id].length), width_cm: toNumber(rows[pkg.id].width),
      height_cm: toNumber(rows[pkg.id].height),
    }))),
    success: (result) => `${result.consignment_no}: ${result.measures.packages_weighed} of ${result.measures.packages} packages weighed, ${result.measures.packages_measured} measured`,
    invalidates: [["trip-recommendations"], ["trip-evaluate"], ["trip-consignment-packages"]],
    onDone: onClose,
  });

  const set = (id: number, key: keyof Row, value: string) =>
    setRows((current) => ({ ...current, [id]: { ...current[id], [key]: value } }));
  const copyFirst = () => {
    const first = packages[0] && rows[packages[0].id];
    if (!first) return;
    setRows(Object.fromEntries(packages.map((pkg) => [pkg.id, { ...first }])));
  };
  const measures = detail.data?.measures;

  return (
    <ConfirmModal isOpen={consignment != null} title={`Weigh ${consignment?.consignment_no ?? ""}`}
      confirmLabel={changed.length ? `Save ${changed.length} package${changed.length === 1 ? "" : "s"}` : "Nothing changed"}
      confirmDisabled={!changed.length || invalid} busy={save.isPending} error={save.error}
      onConfirm={() => save.mutate()} onClose={onClose}>
      <div className="space-y-3 text-sm">
        <ErrorBanner error={detail.error} />
        {measures && (
          <div className="flex items-start gap-2 rounded-lg bg-content2 px-3 py-2 text-xs text-body">
            <Scale className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
            <span>
              The planner counts it as{" "}
              <b>{measures.weight_basis ? `${approx(measures.weight_basis)}${kg(measures.weight_kg)}` : "no weight"}</b>
              {measures.weight_basis && ` (${LOAD_BASIS_WORDS[measures.weight_basis]})`} and{" "}
              <b>{measures.volume_basis ? `${approx(measures.volume_basis)}${cbm(measures.volume_cbm)}` : "no size"}</b>
              {measures.volume_basis && ` (${LOAD_BASIS_WORDS[measures.volume_basis]})`}.
              Only weighed and measured figures can stop a truck being planned over its limit.
            </span>
          </div>
        )}
        {detail.isLoading && <p className="text-xs text-muted">Loading packages…</p>}
        {!!packages.length && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[460px] text-xs">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-muted">
                  <th className="py-1 pr-2 font-semibold">Package</th>
                  <th className="px-1 font-semibold">Weight kg</th>
                  <th className="px-1 font-semibold">L cm</th>
                  <th className="px-1 font-semibold">W cm</th>
                  <th className="px-1 font-semibold">H cm</th>
                </tr>
              </thead>
              <tbody>
                {packages.map((pkg) => (
                  <tr key={pkg.id}>
                    <td className="py-1 pr-2 font-mono text-[11px] text-body">{pkg.package_no}</td>
                    {(["weight", "length", "width", "height"] as const).map((key) => (
                      <td key={key} className="px-1 py-1">
                        <Input type="number" min={0} step="0.1" value={rows[pkg.id]?.[key] ?? ""}
                          aria-label={`${pkg.package_no} ${key}`}
                          onChange={(e) => set(pkg.id, key, e.target.value)} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {packages.length > 1 && (
          <Button variant="ghost" onClick={copyFirst}>Same as the first for every package</Button>
        )}
        {invalid && <Alert tone="warning">Every figure has to be more than zero — leave a box empty if it was not measured.</Alert>}
      </div>
    </ConfirmModal>
  );
}
