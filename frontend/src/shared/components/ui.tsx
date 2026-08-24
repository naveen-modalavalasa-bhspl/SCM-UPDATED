import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowDownRight, ArrowLeft, ArrowUpRight } from "lucide-react";
import {
  Autocomplete,
  AutocompleteItem,
  Button as HButton,
  Card as HCard,
  Input as HInput,
  Select as HSelect,
  SelectItem as HSelectItem,
} from "@heroui/react";

/* ---------------------------------------------------------------------------
 * Shared UI kit (built on HeroUI). Modules import from here — never re-style
 * these primitives locally. See CLAUDE.md "Frontend module pattern".
 * ------------------------------------------------------------------------- */

type Variant =
  | "primary" | "ghost" | "danger" | "subtle" | "secondary" | "soft" | "dangerSoft";

/**
 * `subtle` and `ghost` used to carry no colour at all, so HeroUI fell back to its
 * neutral grey. Every secondary action in the app — Save, Back, Cancel, Add line —
 * rendered as grey-on-white and read as disabled; the warehouse forms, which use
 * them for nearly every button, looked switched off.
 *
 * They are brand-coloured now. `soft` (a filled tint) is for a real action that is
 * not the primary one on the screen — Save next to Post to stock — and `dangerSoft`
 * for a destructive secondary, so cancelling a document never looks like Save.
 */
const VARIANT: Record<Variant, { color?: any; variant?: any }> = {
  primary: { color: "primary", variant: "solid" },
  secondary: { color: "secondary", variant: "solid" },
  danger: { color: "danger", variant: "solid" },
  soft: { color: "primary", variant: "flat" },
  dangerSoft: { color: "danger", variant: "flat" },
  subtle: { color: "primary", variant: "bordered" },
  ghost: { color: "primary", variant: "light" },
};

interface BtnProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "color"> {
  variant?: Variant;
}

export function Button({ variant = "primary", onClick, disabled, type, className, children }: BtnProps) {
  return (
    <HButton
      {...VARIANT[variant]}
      radius="md"
      type={type}
      isDisabled={disabled}
      onPress={onClick as any}
      className={`min-h-11 font-semibold ${className ?? ""}`}
    >
      {children}
    </HButton>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <HCard shadow="sm" radius="lg" className={`border border-line/70 bg-content1 ${className}`}>
      {children}
    </HCard>
  );
}

export function PageHeader({ eyebrow: _eyebrow, title, actions, back }: {
  eyebrow?: string;
  title: string;
  actions?: ReactNode;
  /** The way out of a screen you arrived AT rather than navigated to.
   *
   *  NEW 2026-08-23. Indents grew this by hand (`indents/pages/DetailPage`) — a
   *  muted, 44px-tall labelled link sitting just above the title — and every other
   *  module's detail and form screens had nothing, so the only way back off a
   *  requisition, an RFQ, a consolidation or a shipment was the browser button or the
   *  rail, which drops you at the module's first tab rather than the list you came
   *  from. Defined here rather than copied a fourteenth time, so the placement and
   *  the tap target are one decision.
   *
   *  It names its destination — "Back to All indents", never a bare arrow: an arrow
   *  alone makes the reader guess where it lands, and on a form that has unsaved work
   *  in it that guess is expensive.
   *
   *  A screen reached from the rail does not take one. Nothing to go back TO is not
   *  the same as going back to the dashboard. */
  back?: { to: string; label: string };
}) {
  return (
    <>
      {back && <BackLink to={back.to} label={back.label} />}
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      {/* The eyebrow is accepted and deliberately not drawn (2026-08-22). The sticky
          header names the module and the tab strip beside it names the screen, so a
          third naming of the same thing in brand caps above the title was noise on
          every page in the app. The prop stays so no call site had to change. */}
      <h1 className="font-display text-[26px] font-bold text-ink">{title}</h1>
      {/* flex-wrap, not nowrap: a document form puts up to six buttons here (Back,
       * Save, Submit, Approve, Reject, Cancel), which overflows a 375px screen
       * sideways without it. The outer div already wraps; this one has to as well. */}
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
    </>
  );
}

/** The back link itself, exported so a screen computing its destination at render
 *  time (Indents' detail page picks between four, depending on where the reader came
 *  from) can place it without going through `PageHeader`. */
export function BackLink({ to, label }: { to: string; label: string }) {
  const nav = useNavigate();
  return (
    <button
      type="button"
      onClick={() => nav(to)}
      className="mb-3 inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-muted transition-colors hover:text-body focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 rounded"
    >
      <ArrowLeft className="h-4 w-4" /> {label}
    </button>
  );
}

/** KPI tile — the sample's stat card: label, big value, optional delta chip. */
export function StatCard({
  label,
  value,
  delta,
  icon,
  tone = "text-ink",
}: {
  label: string;
  value: ReactNode;
  delta?: number;
  icon?: ReactNode;
  tone?: string;
}) {
  const up = (delta ?? 0) >= 0;
  return (
    <Card className="p-4 sm:p-5">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</span>
        {icon && <span className={tone}>{icon}</span>}
      </div>
      <div className="flex items-end justify-between gap-2">
        <span className={`font-display text-3xl font-bold tabular ${tone}`}>{value}</span>
        {delta !== undefined && (
          <span
            className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs font-semibold ${
              up ? "bg-ok-bg text-ok" : "bg-bad-bg text-bad"
            }`}
          >
            {up ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
            {Math.abs(delta ?? 0)}%
          </span>
        )}
      </div>
    </Card>
  );
}

export function Field(
  { label, children, hint, required }:
  { label: string; children: ReactNode; hint?: string; required?: boolean },
) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-body">
        {label}
        {/* The asterisk is the only thing on the form that says "you cannot save
            without this". aria-hidden with a text equivalent beside it, because a
            screen reader announcing "star" tells nobody anything. */}
        {required && (
          <>
            <span aria-hidden="true" className="ml-0.5 text-danger">*</span>
            <span className="sr-only"> (required)</span>
          </>
        )}
      </span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Set together: the field turns red and the message renders beneath it. */
  isInvalid?: boolean;
  errorMessage?: string;
}

export function Input({ className, ...props }: InputProps) {
  return (
    <HInput
      variant="bordered"
      radius="md"
      classNames={{ inputWrapper: `min-h-11 border-line bg-content1 ${className ?? ""}` }}
      {...(props as any)}
    />
  );
}

/** Focus handler for a SEARCH or filter box: it selects whatever is already in the
 *  field, so the next thing typed REPLACES the old term instead of being appended to
 *  it. Filter boxes are the one place that is always what the user meant — the value
 *  is a single term, not prose.
 *
 *  Only for those. Never put it on an ordinary form field: selecting a quantity or a
 *  remark somebody came back to amend means their first keystroke wipes it. */
export const selectOnFocus = (event: { target: { select?: () => void } }) =>
  event.target.select?.();

export interface SelectOption {
  value: string | number;
  label: string;
}

/** How many options it takes before the box is worth SEARCHING.
 *
 *  Under this it renders as an ordinary dropdown: one click, the whole list on
 *  screen, nothing to type. Over it, a plain dropdown means scrolling a 300-row
 *  master to find one line, so the box filters as you type instead. Masters
 *  routinely feed this that many options and modes/statuses/priorities feed it five.
 *
 *  One number, not a decision retyped at 150 call sites — and `searchable` overrides
 *  it either way for a screen that knows better than the count does. */
const SEARCHABLE_FROM = 10;

interface SelectProps {
  value?: string | number | "";
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  label?: string;
  ariaLabel?: string;
  isDisabled?: boolean;
  className?: string;
  isInvalid?: boolean;
  errorMessage?: string;
  /** Force the searchable box on or off. Omitted, the option count decides. */
  searchable?: boolean;
}

/** Single-select, shared by every module.
 *
 *  Two renderings behind one set of props, chosen by how long the list is (see
 *  `SEARCHABLE_FROM`). Both report the option's own `value` through `onChange`, both
 *  take "" as "nothing chosen", and neither ever emits a value that is not in
 *  `options` — a call site cannot tell which one it got, which is the point.
 *
 *  Until 2026-08-20 every one of these was the searchable box. That is right for a
 *  masters dropdown and wrong for a five-item one, where "Type to search…" asked the
 *  user to type in order to pick from a list they could already see. */
export function Select({
  value,
  onChange,
  options,
  placeholder,
  label,
  ariaLabel,
  isDisabled,
  className,
  isInvalid,
  errorMessage,
  searchable,
}: SelectProps) {
  const selected = value === "" || value === undefined || value === null
    ? null : String(value);
  const common = {
    variant: "bordered" as const,
    radius: "md" as const,
    label,
    "aria-label": ariaLabel ?? label ?? placeholder ?? "Select an option",
    isDisabled,
    isInvalid,
    errorMessage,
  };

  if (!(searchable ?? options.length >= SEARCHABLE_FROM)) {
    return (
      <HSelect
        {...common}
        placeholder={placeholder ?? "Select an option"}
        items={options}
        // Only a key the collection actually holds. An edit form sets its value
        // before the options query lands, and HeroUI warns on every such render —
        // the field fills itself in the moment the list arrives either way, so this
        // is the same behaviour with a quiet console.
        selectedKeys={
          selected !== null && options.some((o) => String(o.value) === selected)
            ? [selected] : []
        }
        onSelectionChange={(keys) => {
          const key = Array.from(keys as Set<string | number>)[0];
          onChange(key == null ? "" : String(key));
        }}
        classNames={{ trigger: `min-h-11 border-line bg-content1 ${className ?? ""}` }}
      >
        {(option: SelectOption) => (
          <HSelectItem key={String(option.value)}>{option.label}</HSelectItem>
        )}
      </HSelect>
    );
  }

  return (
    <Autocomplete
      {...common}
      placeholder={placeholder ?? "Type to search…"}
      defaultItems={options}
      selectedKey={selected}
      // Clearing the box gives null, which must reach the caller as "" — the same
      // empty value it passes in — or a cleared field would keep its old id.
      onSelectionChange={(key) => onChange(key == null ? "" : String(key))}
      inputProps={{
        classNames: { inputWrapper: `min-h-11 border-line bg-content1 ${className ?? ""}` },
      }}
    >
      {(option: SelectOption) => (
        <AutocompleteItem key={String(option.value)}>{option.label}</AutocompleteItem>
      )}
    </Autocomplete>
  );
}
