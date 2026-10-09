import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import Barcode from "react-barcode";
import { QRCodeSVG } from "qrcode.react";
import { Printer } from "lucide-react";
import { Button } from "@/shared/components";

/**
 * The print surface for any sheet of labels.
 *
 * Portalled to `document.body` on purpose. The earlier sheets printed blank: they
 * lived inside a `position: relative; overflow: hidden` card and positioned
 * themselves `absolute; inset: 0`, so at print time the card had collapsed to ~100px
 * (its only child was out of flow) and clipped the labels down to a sliver. With the
 * sheet as a direct child of `body` there is no ancestor left to clip or collapse it,
 * every other top-level node is simply removed for the print run, and the labels
 * paginate naturally instead of being pinned to page one.
 */
export function PrintPortal({
  id,
  columns = 2,
  children,
}: {
  id: string;
  columns?: number;
  children: ReactNode;
}) {
  return createPortal(
    <div id={id} data-print-sheet style={{ display: "none" }}>
      <style>{`
        @media print {
          body > *:not(#${id}) { display: none !important; }
          #${id} {
            display: grid !important;
            grid-template-columns: repeat(${columns}, minmax(0, 1fr));
            gap: 6mm;
            padding: 8mm;
            background: #fff;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }
          #${id} > * { break-inside: avoid; page-break-inside: avoid; }
        }
      `}</style>
      {children}
    </div>,
    document.body,
  );
}

/**
 * Barcode and QR labels for bins, packages and serials.
 *
 * The label sheet prints through a scoped `@media print` block rather than
 * `react-to-print`: that library opens a second window and re-mounts the subtree,
 * which meant the printed sheet was rendered by a copy of React with none of the
 * app's CSS — labels came out unstyled often enough that people stopped trusting
 * them. Printing the live node keeps what you see and what comes out identical.
 */

export interface LabelSpec {
  /** What the scanner reads. */
  code: string;
  title: string;
  subtitle?: string;
  /** Small key/value lines under the code, e.g. batch and expiry. */
  meta?: { label: string; value: string }[];
  /** QR carries more than a linear barcode — used for packages and serials. */
  kind?: "barcode" | "qr";
}

export function Label({ spec }: { spec: LabelSpec }) {
  const { code, title, subtitle, meta = [], kind = "barcode" } = spec;
  return (
    <div className="wh-label flex w-[280px] flex-col items-center gap-1 rounded-lg border border-line bg-white p-3 text-center">
      <div className="w-full truncate text-sm font-bold text-ink">{title}</div>
      {subtitle && <div className="w-full truncate text-[11px] text-muted">{subtitle}</div>}

      <div className="my-1">
        {kind === "qr" ? (
          <QRCodeSVG value={code} size={104} level="M" />
        ) : (
          <Barcode value={code} height={48} width={1.4} fontSize={11} margin={0} displayValue />
        )}
      </div>

      {kind === "qr" && <div className="font-mono text-[11px] font-semibold text-ink">{code}</div>}

      {meta.length > 0 && (
        <dl className="w-full space-y-0.5 text-left text-[10px] leading-tight text-ink">
          {meta.map((m) => (
            <div key={m.label} className="flex justify-between gap-2">
              <dt className="text-muted">{m.label}</dt>
              <dd className="truncate font-semibold">{m.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/**
 * A printable sheet of labels.
 *
 * Everything outside `#wh-label-sheet` is hidden at print time, so the browser's
 * print dialog produces the labels alone with no app chrome around them.
 */
export function LabelSheet({
  labels,
  title = "Labels",
  emptyHint = "Nothing to print yet.",
}: {
  labels: LabelSpec[];
  title?: string;
  emptyHint?: string;
}) {
  return (
    <div>
      <PrintPortal id="wh-label-sheet" columns={3}>
        {labels.map((spec, i) => (
          <Label key={`print-${spec.code}-${i}`} spec={spec} />
        ))}
      </PrintPortal>

      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="text-sm text-muted">
          {labels.length} label{labels.length === 1 ? "" : "s"}
        </span>
        <Button onClick={() => window.print()} disabled={labels.length === 0}>
          <Printer className="h-4 w-4" /> Print {title.toLowerCase()}
        </Button>
      </div>

      {labels.length === 0 ? (
        <div className="rounded-2xl border border-line/70 bg-content1 py-10 text-center text-sm text-muted">
          {emptyHint}
        </div>
      ) : (
        <div className="flex flex-wrap gap-3">
          {labels.map((spec, i) => (
            <Label key={`${spec.code}-${i}`} spec={spec} />
          ))}
        </div>
      )}
    </div>
  );
}
