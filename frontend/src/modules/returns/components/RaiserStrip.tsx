import { AlertTriangle, ArrowRight, Briefcase, User, Warehouse } from "lucide-react";
import { Card } from "@/shared/components";
import type { Raiser } from "../types";

/**
 * WHO is returning WHAT, FROM where, ADDRESSED to where — the identity block, as a strip.
 *
 * REDRAWN 2026-09-07. It was five stacked `<Input disabled>` rows in the details rail:
 * ~330px of vertical space for five short facts, in a control that reads as a broken
 * form field rather than as context. A disabled text box invites the eye to try typing
 * in it, and five of them made the rail twice as tall as the card it sat beside — which
 * is where the hollow right-hand column on this screen came from.
 *
 * Every fact is the same, in the same words, and still read-only: the backend derives
 * all of it from the signed-in position and none of it is ever posted, so a browser
 * cannot claim to be returning somebody else's stock from somebody else's office.
 * "Employee id" moved under the name rather than off the screen — it is the same person,
 * and two lines in one cell says so more plainly than two cells did.
 *
 * Skeletons rather than em dashes while it loads: this strip is the first thing on the
 * page, and four "—" cells read as "we do not know who you are", which is alarming and
 * also untrue a few hundred milliseconds later. Nothing moves when the data lands.
 */
function Cell({
  icon: Icon,
  label,
  value,
  sub,
  loading,
  tone = "text-ink",
}: {
  icon: typeof User;
  label: string;
  value: string | null | undefined;
  sub?: string | null;
  loading: boolean;
  tone?: string;
}) {
  return (
    <div className="min-w-0 px-1 py-2 sm:px-4">
      <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted/80" />
        {label}
      </span>
      {loading ? (
        <span className="mt-1.5 block h-4 w-24 max-w-full animate-pulse rounded bg-line" />
      ) : (
        <span className={`mt-0.5 block truncate text-sm font-bold ${tone}`} title={value ?? undefined}>
          {value || "—"}
        </span>
      )}
      {!loading && sub && (
        <span className="mt-0.5 block truncate text-[11px] font-medium text-muted" title={sub}>
          {sub}
        </span>
      )}
    </div>
  );
}

export function RaiserStrip({ raiser, className = "" }: { raiser?: Raiser; className?: string }) {
  const loading = !raiser;
  return (
    <Card className={`overflow-hidden ${className}`}>
      {/* The brand's four stops, as a hairline across the top of the first card on the
        * page. `.bg-brand` is the sweep as a background image — the one definition, the
        * same one the rail's active row and the progress bars use — so this is the app
        * signing the screen rather than a gradient invented here. `overflow-hidden` is
        * what keeps it inside the card's own radius.
        *
        * Deliberately the ONLY saturated colour on the form that carries no meaning.
        * Everything else that is coloured is coloured because it is saying something:
        * green for a step that is done, the live blue for the step to do next, red for a
        * quantity over the shelf. The page's ground does the rest — Returns has its own
        * pastel rose in `index.css`, like every other module. */}
      <span aria-hidden="true" className="block h-1 w-full bg-brand" />
      <div className="px-3 py-2">
      <div className="grid grid-cols-2 gap-y-1 sm:grid-cols-4 sm:gap-0 sm:divide-x sm:divide-line/60">
        <Cell
          icon={User}
          label="Returned by"
          value={raiser?.employee_name}
          sub={raiser?.employee_code ? `Employee id ${raiser.employee_code}` : null}
          loading={loading}
        />
        <Cell icon={Briefcase} label="Position" value={raiser?.position_name} loading={loading} />
        <Cell
          icon={Warehouse}
          label="Returning from"
          value={raiser?.from_warehouse_name}
          loading={loading}
        />
        {/* The destination is the one cell that can legitimately be missing — an office
          * with no stocking point above it has nowhere to send stock — and when it is,
          * the reason is already shouted in a banner at the top of the form. Coloured
          * here as well, because a strip that draws a gap identically to a warehouse
          * name is the reason nobody read the banner.
          *
          * FIX 2026-09-10: it is labelled ADDRESSED TO, not "Going to". The point derived
          * from this position is where the return is addressed when it is raised — it is
          * not where the stock ends up. "Send to a stocking point" puts the material on
          * whichever point the reviewer picks at sign-off (a warehouse, an MDP, any
          * stocking point), and that picker no longer pre-fills, so a strip that read
          * "Going to X" was announcing a decision nobody had taken. The line under the
          * name says who takes it. */}
        <Cell
          icon={!loading && !raiser?.to_warehouse_name ? AlertTriangle : ArrowRight}
          label="Addressed to"
          value={raiser?.to_warehouse_name || (loading ? null : "Not set")}
          sub={raiser?.to_warehouse_name ? "Sign-off picks the stocking point it goes to" : null}
          loading={loading}
          tone={!loading && !raiser?.to_warehouse_name ? "text-bad" : "text-ink"}
        />
      </div>
      <p className="mt-1 px-1 pb-0.5 text-[11px] text-muted sm:px-4">
        Filled in from your position — it cannot be edited here.
      </p>
      </div>
    </Card>
  );
}
