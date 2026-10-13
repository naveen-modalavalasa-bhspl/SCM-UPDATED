import { Select, SelectItem, Tooltip } from "@heroui/react";
import { AlertTriangle, Barcode, CalendarClock, Lock, MapPin, Package } from "lucide-react";
import { LocationTrail } from "./LocationTrail";
import { fmtQty } from "../format";
import type { BatchChoice, LocationChoice } from "../issueSplits";

/**
 * The batch and storage-location pickers on a material issue pick.
 *
 * They were two plain `Lookup`s over `/options/batches` and `/options/bins`, which
 * return an id and a code and nothing else. So the two decisions that actually matter
 * at the shelf — **which batch expires first**, and **how much is in the bay I am
 * being sent to** — were invisible at the moment they were being made. A storekeeper
 * picked `batch-25aug` over `batch-02sep` because it was first in the list, not
 * because he knew one expired six weeks before the other; and he picked a bay holding
 * three units for a line taking ten, then found out at the unit picker.
 *
 * Both read the SAME rows the server validates the save against
 * (`issue_stock_sources`), so what is offered here is what `_assert_issue_sources`
 * accepts. A dropdown that offers what the server refuses is a dropdown nobody trusts
 * twice — and a screen that filters more tightly than the server is a screen that
 * hides stock somebody can see on the shelf.
 *
 * Neither picker fetches anything: the sources are already loaded once for the whole
 * document. Two dropdowns per pick over fifty picks used to be a hundred cached
 * queries with the batch id in the key.
 */

const HINT = "text-[11px] leading-tight text-muted";

/** A date the way a storekeeper reads one, and never a bare ISO string in a sentence.
 *  An undated batch says so — "no expiry recorded" is a fact, `—` is a shrug. */
export function expiryLabel(iso: string | null | undefined): string {
  if (!iso) return "No expiry recorded";
  const at = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleDateString(undefined, {
    day: "2-digit", month: "short", year: "numeric",
  });
}

/** How long is left, which is what FEFO is actually about. Past-dated stock is called
 *  out in words: a red date is only red to somebody looking for it. */
export function expiryTone(iso: string | null | undefined): {
  label: string; tone: string;
} {
  if (!iso) return { label: "No expiry recorded", tone: "text-muted" };
  const at = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(at.getTime())) return { label: iso, tone: "text-muted" };
  const days = Math.round((at.getTime() - Date.now()) / 86_400_000);
  if (days < 0) return { label: `Expired ${-days}d ago`, tone: "text-bad" };
  if (days <= 30) return { label: `${days}d left`, tone: "text-warn" };
  return { label: `${days}d left`, tone: "text-muted" };
}

/* --------------------------------------------------------------------- batch -- */

interface BatchProps {
  choices: BatchChoice[];
  value: number | null | undefined;
  onChange: (choice: BatchChoice | null) => void;
  isDisabled?: boolean;
  isBatchTracked: boolean;
  /** The batch number the document itself carries. A posted or approved issue does not
   *  re-read the shelf — the stock has moved — so without the snapshot the field would
   *  render "Batch 11" over a document that plainly says AUG-26. */
  fallbackNo?: string | null;
  /** The oldest batch on the shelf, when this pick is not on it. Advice, not a rule —
   *  see `batchChoices`. */
  fefoHint?: string | null;
  isExpired?: boolean;
}

export function BatchPicker({
  choices, value, onChange, isDisabled, isBatchTracked, fallbackNo, fefoHint, isExpired,
}: BatchProps) {
  const todayIso = new Date().toISOString().slice(0, 10);
  const validChoices = choices.filter((row) => !(row.expiry && row.expiry < todayIso));
  const selected = validChoices.find((row) => (row.batchId ?? 0) === (value ?? 0));
  // A batch already on the line that the shelf no longer offers — every unit of it
  // spoken for by another document since the draft was written. It stays selectable
  // only if not expired.
  const orphan = !selected && value && !isExpired
    ? { batchId: value, batchNo: fallbackNo ?? null, expiry: null, mfg: null, drawable: 0,
        total: 0, locations: 0, allocated: false, allowed: true,
        blocked: null, hasCodes: false, codeException: false } as BatchChoice
    : null;
  const rows = orphan ? [...validChoices, orphan] : validChoices;

  const trigger = (
    <Select
      aria-label="Batch"
      variant="bordered"
      radius="md"
      isDisabled={isDisabled || rows.length === 0}
      placeholder={
        !isBatchTracked ? "No batch"
          : rows.length === 0 ? "Nothing on the shelf"
            : "Pick a batch"
      }
      selectedKeys={
        value && rows.some((row) => (row.batchId ?? 0) === value)
          ? [String(value)] : []
      }
      disabledKeys={rows.filter((row) => !row.allowed)
        .map((row) => String(row.batchId ?? 0))}
      onSelectionChange={(keys) => {
        const key = Array.from(keys as Set<string>)[0];
        const picked = rows.find((row) => String(row.batchId ?? 0) === key);
        onChange(picked && picked.allowed ? picked : null);
      }}
      classNames={{ trigger: "min-h-11 border-line bg-content1" }}
      renderValue={() => (
        <span className="truncate font-mono text-xs">
          {selected?.batchNo ?? fallbackNo ?? (value ? `Batch ${value}` : "")}
        </span>
      )}
      items={rows}
    >
      {(row: BatchChoice) => {
        const expiry = expiryTone(row.expiry);
        return (
          <SelectItem
            key={String(row.batchId ?? 0)}
            textValue={row.batchNo ?? "Unbatched"}
          >
            <div className="flex items-start justify-between gap-3 py-0.5">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-mono text-xs font-semibold text-ink">
                    {row.batchNo ?? "Unbatched stock"}
                  </span>
                  {row.earliest && (
                    <span className="rounded bg-ok-bg px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-ok">
                      Earliest expiry
                    </span>
                  )}
                  {row.hasCodes && (
                    <span className="inline-flex items-center gap-0.5 rounded bg-info-bg px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-info">
                      <Barcode className="h-2.5 w-2.5" /> Codes
                    </span>
                  )}
                  {row.codeException && (
                    <span className="rounded bg-warn-bg px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-warn">
                      Unlocked
                    </span>
                  )}
                  {!row.allowed && <Lock className="h-3 w-3 shrink-0 text-muted" />}
                </div>
                <div className={`mt-0.5 flex flex-wrap items-center gap-x-2 ${HINT}`}>
                  <span className="inline-flex items-center gap-1">
                    <CalendarClock className="h-3 w-3" />
                    {expiryLabel(row.expiry)}
                  </span>
                  <span className={expiry.tone}>{expiry.label}</span>
                  <span>
                    {row.locations} location{row.locations === 1 ? "" : "s"}
                  </span>
                </div>
                {row.blocked && (
                  <div className="mt-0.5 text-[11px] leading-tight text-warn">
                    {row.blocked}
                  </div>
                )}
                {row.codeException && (
                  <div className="mt-0.5 text-[11px] leading-tight text-info">
                    The allocated batch has no codes, so this — the oldest batch that
                    does — may be issued instead. Saving moves the reservation here.
                  </div>
                )}
              </div>
              <div className="shrink-0 text-right">
                <div className="tabular text-xs font-semibold text-ink">
                  {fmtQty(row.drawable)}
                </div>
                <div className="text-[10px] leading-tight text-muted">
                  can give
                  {row.total > row.drawable && ` · ${fmtQty(row.total)} here`}
                </div>
              </div>
            </div>
          </SelectItem>
        );
      }}
    </Select>
  );

  if (!selected) return trigger;
  return (
    <Tooltip
      placement="top-start"
      delay={300}
      closeDelay={0}
      content={<BatchCard choice={selected} fefoHint={fefoHint} />}
      classNames={{ content: "p-0 bg-content1 border border-line shadow-lg" }}
    >
      <div>{trigger}</div>
    </Tooltip>
  );
}

/** Everything known about the chosen batch, on hover — the same four facts the option
 *  row shows, kept reachable once the dropdown has closed over them. */
function BatchCard({ choice, fefoHint }: {
  choice: BatchChoice; fefoHint?: string | null;
}) {
  const expiry = expiryTone(choice.expiry);
  return (
    <div className="max-w-xs px-3 py-2">
      <div className="flex items-center gap-1.5">
        <Package className="h-3.5 w-3.5 text-brand" />
        <span className="font-mono text-xs font-semibold text-ink">
          {choice.batchNo ?? "Unbatched stock"}
        </span>
      </div>
      <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
        <dt className="text-muted">Expires</dt>
        <dd className="text-ink">
          {expiryLabel(choice.expiry)}{" "}
          <span className={expiry.tone}>({expiry.label})</span>
        </dd>
        {choice.mfg && (
          <>
            <dt className="text-muted">Made</dt>
            <dd className="text-ink">{expiryLabel(choice.mfg)}</dd>
          </>
        )}
        <dt className="text-muted">Can give</dt>
        <dd className="tabular text-ink">
          {fmtQty(choice.drawable)} of {fmtQty(choice.total)} in this warehouse
        </dd>
        <dt className="text-muted">Spread over</dt>
        <dd className="text-ink">
          {choice.locations} storage location{choice.locations === 1 ? "" : "s"}
        </dd>
      </dl>
      {fefoHint && (
        <p className="mt-1.5 flex items-start gap-1 text-[11px] leading-tight text-warn">
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
          {fefoHint}
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ location -- */

interface LocationProps {
  choices: LocationChoice[];
  value: number | null | undefined;
  onChange: (choice: LocationChoice | null) => void;
  isDisabled?: boolean;
  /** No batch chosen yet on a batch-tracked item: there is nothing to list. */
  needsBatch?: boolean;
  fallbackCode?: string | null;
  fallbackPath?: string | null;
  isExpired?: boolean;
}

export function LocationPicker({
  choices, value, onChange, isDisabled, needsBatch, fallbackCode, fallbackPath, isExpired,
}: LocationProps) {
  const selected = choices.find((row) => (row.binId ?? 0) === (value ?? 0));
  const orphan = !selected && value && !isExpired
    ? { binId: value, binCode: fallbackCode ?? null, binPath: fallbackPath ?? null,
        drawable: 0, total: 0, ownReserved: 0, othersHold: 0,
        allocated: false } as LocationChoice
    : null;
  const rows = orphan ? [...choices, orphan] : choices;

  const trigger = (
    <Select
      aria-label="Storage location"
      variant="bordered"
      radius="md"
      isDisabled={isDisabled || needsBatch || rows.length === 0}
      placeholder={
        needsBatch ? "Pick the batch first"
          : rows.length === 0 ? "This batch is nowhere here"
            : "Pick a location"
      }
      selectedKeys={
        value && rows.some((row) => (row.binId ?? 0) === value)
          ? [String(value)] : []
      }
      onSelectionChange={(keys) => {
        const key = Array.from(keys as Set<string>)[0];
        onChange(rows.find((row) => String(row.binId ?? 0) === key) ?? null);
      }}
      classNames={{ trigger: "min-h-11 border-line bg-content1" }}
      renderValue={() => (
        <span className="truncate font-mono text-xs">
          {selected?.binCode ?? fallbackCode ?? (value ? `Location ${value}` : "")}
        </span>
      )}
      items={rows}
    >
      {(row: LocationChoice) => (
        <SelectItem
          key={String(row.binId ?? 0)}
          textValue={row.binCode ?? "Unbinned"}
        >
          <div className="flex items-start justify-between gap-3 py-0.5">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="truncate font-mono text-xs font-semibold text-ink">
                  {row.binCode ?? "Unbinned stock"}
                </span>
                {row.allocated && (
                  <span className="rounded bg-ok-bg px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-ok">
                    Allocated
                  </span>
                )}
              </div>
              {/* The walk down to it. `F1-A1-R1-B2` alone does not tell anybody which
                * end of which floor they are being sent to. */}
              <LocationTrail className={`mt-0.5 ${HINT}`} steps={null}
                             path={row.binPath} code={row.binCode} />
            </div>
            <div className="shrink-0 text-right">
              <div className="tabular text-xs font-semibold text-ink">
                {fmtQty(row.drawable)}
              </div>
              <div className="text-[10px] leading-tight text-muted">
                can give
                {row.othersHold > 0 && ` · ${fmtQty(row.othersHold)} held`}
              </div>
            </div>
          </div>
        </SelectItem>
      )}
    </Select>
  );

  if (!selected) return trigger;
  return (
    <Tooltip
      placement="top-start"
      delay={300}
      closeDelay={0}
      content={<LocationCard choice={selected} />}
      classNames={{ content: "p-0 bg-content1 border border-line shadow-lg" }}
    >
      <div>{trigger}</div>
    </Tooltip>
  );
}

function LocationCard({ choice }: { choice: LocationChoice }) {
  return (
    <div className="max-w-xs px-3 py-2">
      <div className="flex items-center gap-1.5">
        <MapPin className="h-3.5 w-3.5 text-brand" />
        <span className="font-mono text-xs font-semibold text-ink">
          {choice.binCode ?? "Unbinned stock"}
        </span>
      </div>
      {choice.binPath && (
        <div className="mt-0.5 text-[11px] leading-tight text-muted">
          {choice.binPath}
        </div>
      )}
      <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
        <dt className="text-muted">On the shelf</dt>
        <dd className="tabular text-ink">
          {fmtQty(choice.total)} of this batch, here
        </dd>
        <dt className="text-muted">Can give</dt>
        <dd className="tabular text-ink">{fmtQty(choice.drawable)}</dd>
        {choice.ownReserved > 0 && (
          <>
            <dt className="text-muted">Allocated</dt>
            <dd className="tabular text-ok">
              {fmtQty(choice.ownReserved)} reserved for this indent
            </dd>
          </>
        )}
        {choice.othersHold > 0 && (
          <>
            <dt className="text-muted">Held</dt>
            <dd className="tabular text-muted">
              {fmtQty(choice.othersHold)} by another document
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}
