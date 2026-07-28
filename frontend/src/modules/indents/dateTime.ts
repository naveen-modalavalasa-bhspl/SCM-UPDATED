const apiTimestampHasOffset = /(?:z|[+-]\d{2}:?\d{2})$/i;

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

const shortDateFormatter = new Intl.DateTimeFormat(undefined, {
  day: "2-digit",
  month: "short",
});

export function parseIndentTimestamp(value?: string | null) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const normalized = apiTimestampHasOffset.test(trimmed) ? trimmed : `${trimmed}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function formatIndentDateTime(value?: string | null) {
  const parsed = parseIndentTimestamp(value);
  return parsed ? dateTimeFormatter.format(parsed) : null;
}

export function formatIndentDate(value?: string | null) {
  const parsed = parseIndentTimestamp(value);
  return parsed ? dateFormatter.format(parsed) : null;
}

export function formatIndentShortDate(value?: string | null) {
  const parsed = parseIndentTimestamp(value);
  return parsed ? shortDateFormatter.format(parsed) : null;
}
