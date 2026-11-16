import Barcode from "react-barcode";
import { QRCodeSVG } from "qrcode.react";
import type { BarFormat, CodeKind, FontSize } from "../docLabels";
import { fontScale } from "../docLabels";

/**
 * One printed sticker, at its real size in millimetres (2026-10-28).
 *
 * The one drawing of a pack or unit label: Box labels and the issue / receipt label
 * dialog both render this, so a sticker printed at the desk that posted an issue is
 * the sticker the Labels page prints for the same code. What it carries is the
 * caller's choice — a Code128 / Code39 barcode for a scanner gun, a QR that opens the
 * pack's live details on any phone, or both — and which lines of text, in what size.
 *
 * Wide labels put the QR beside the text; tall ones (4 × 6 in) stack it above.
 */
export function LabelSticker({
  code, qrValue, title, rows, w, h, kind = "BOTH", barFormat = "CODE128", font = "M",
  className = "",
}: {
  code: string;
  qrValue: string;
  title?: string | null;
  rows: [string, string | null | undefined][];
  w: number;
  h: number;
  kind?: CodeKind;
  barFormat?: BarFormat;
  font?: FontSize;
  className?: string;
}) {
  const k = fontScale({ w, h, font });
  const tall = h > w;
  const showQr = kind !== "BARCODE";
  const showBar = kind !== "QR";
  const lines = rows.filter(([, v]) => v != null && v !== "");
  // Code39 cannot carry lower case; it is only offered for codes that fit it.
  const barValue = barFormat === "CODE39" ? code.toUpperCase() : code;
  return (
    <div className={`doc-label flex flex-col overflow-hidden rounded border border-line bg-white text-black ${className}`}
         style={{ width: `${w}mm`, height: `${h}mm`, padding: `${Math.max(1, Math.min(w, h) * 0.05)}mm` }}>
      <div className={`flex min-h-0 flex-1 gap-[1.5mm] ${tall ? "flex-col items-center" : ""}`}>
        {showQr && (
          <QRCodeSVG value={qrValue} size={256} level="M"
                     className={tall ? "block h-auto w-[60%] shrink-0" : "block h-full max-h-full w-auto shrink-0"} />
        )}
        <div className={`min-w-0 flex-1 leading-tight ${tall ? "w-full" : ""}`}>
          {title && (
            <div className="truncate font-bold" style={{ fontSize: `${7 * k}px` }}>{title}</div>
          )}
          <div className="mt-[0.3mm] space-y-[0.3mm]" style={{ fontSize: `${5.5 * k}px` }}>
            {lines.map(([label, value]) => (
              <div key={label} className="flex gap-[1mm] leading-none">
                <span className="shrink-0 font-semibold uppercase">{label}</span>
                <span className="truncate font-mono">{value}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      {showBar && (
        <div className="mt-[0.5mm] flex w-full items-center justify-center overflow-hidden [&_svg]:h-full [&_svg]:max-w-full"
             style={{ height: kind === "BARCODE" ? "34%" : "22%" }}>
          <Barcode value={barValue} format={barFormat} width={1} height={40} margin={0}
                   displayValue={false} background="#ffffff" />
        </div>
      )}
      <div className="w-full truncate text-center font-mono font-bold leading-none" style={{ fontSize: `${6.5 * k}px` }}>
        {code}
      </div>
    </div>
  );
}
