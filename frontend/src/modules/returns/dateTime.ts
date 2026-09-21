/**
 * How the returns screens read a timestamp. The module's own copy, because a module only
 * touches `src/modules/<name>/` — nothing here is shared with, or changed for, any other
 * module.
 *
 * The journey serves its stamps with the `+05:30` offset on them (`app/shared/time.iso`).
 * Older fields on the document are still naive, and a naive stamp is the branch's own wall
 * clock — so it is parsed as local time and never stamped `Z`, which would render an IST
 * timestamp 5h30 early.
 */
const hasOffset = /(?:z|[+-]\d{2}:?\d{2})$/i;

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  day: "2-digit",
  month: "short",
  year: "numeric",
});

export function parseReturnTimestamp(value?: string | null) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  // A space instead of the `T` is what MySQL prints; Safari refuses that form outright.
  const parsed = new Date(hasOffset.test(trimmed) ? trimmed : trimmed.replace(" ", "T"));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function formatReturnDateTime(value?: string | null) {
  const parsed = parseReturnTimestamp(value);
  return parsed ? dateTimeFormatter.format(parsed) : null;
}

export function formatReturnDate(value?: string | null) {
  const parsed = parseReturnTimestamp(value);
  return parsed ? dateFormatter.format(parsed) : null;
}
