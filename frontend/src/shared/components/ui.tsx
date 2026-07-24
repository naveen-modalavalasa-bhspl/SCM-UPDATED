import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import {
  Button as HButton,
  Card as HCard,
  Input as HInput,
  Select as HSelect,
  SelectItem,
} from "@heroui/react";

/* ---------------------------------------------------------------------------
 * Shared UI kit (built on HeroUI). Modules import from here — never re-style
 * these primitives locally. See CLAUDE.md "Frontend module pattern".
 * ------------------------------------------------------------------------- */

type Variant = "primary" | "ghost" | "danger" | "subtle" | "secondary";

const VARIANT: Record<Variant, { color?: any; variant?: any }> = {
  primary: { color: "primary", variant: "solid" },
  secondary: { color: "secondary", variant: "solid" },
  danger: { color: "danger", variant: "solid" },
  subtle: { variant: "bordered" },
  ghost: { variant: "light" },
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

export function PageHeader({ eyebrow, title, actions }: { eyebrow?: string; title: string; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        {eyebrow && (
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-brand">{eyebrow}</div>
        )}
        <h1 className="font-display text-[26px] font-bold text-ink">{title}</h1>
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
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

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-body">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <HInput
      variant="bordered"
      radius="md"
      classNames={{ inputWrapper: `min-h-11 border-line bg-content1 ${className ?? ""}` }}
      {...(props as any)}
    />
  );
}

export interface SelectOption {
  value: string | number;
  label: string;
}

// HeroUI Select with a simple options API. Use Field for the label, pass placeholder here.
export function Select({
  value,
  onChange,
  options,
  placeholder,
  label,
  isDisabled,
  className,
}: {
  value?: string | number | "";
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  label?: string;
  isDisabled?: boolean;
  className?: string;
}) {
  const selected = value === "" || value === undefined || value === null ? [] : [String(value)];
  return (
    <HSelect
      variant="bordered"
      radius="md"
      label={label}
      placeholder={placeholder}
      isDisabled={isDisabled}
      selectedKeys={selected}
      onSelectionChange={(keys) => {
        const k = Array.from(keys as Set<string>)[0];
        onChange(k ? String(k) : "");
      }}
      classNames={{ trigger: `min-h-11 border-line bg-content1 ${className ?? ""}` }}
    >
      {options.map((o) => (
        <SelectItem key={String(o.value)}>{o.label}</SelectItem>
      ))}
    </HSelect>
  );
}
