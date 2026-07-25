// @ts-nocheck
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import * as XLSX from 'xlsx';
import { message } from 'antd';
import { DATE_FORMAT, DATETIME_FORMAT, STATUS_COLORS, STATUS_LABELS } from './constants';

dayjs.extend(utc);
dayjs.extend(timezone);

// All human-visible timestamps are in IST. Backend stores UTC — we convert on
// display.
const IST_TZ = 'Asia/Kolkata';

export const formatCurrency = (amount, currency = 'INR') => {
  if (amount == null) return '-';
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(amount);
};

export const formatNumber = (num) => {
  if (num == null) return '-';
  return new Intl.NumberFormat('en-IN').format(num);
};

/**
 * Normalize legacy short doc numbers (e.g. "MR-00047") to the fiscal-year
 * format "BHSPL/FY/TYPE/sequence" used by all newer records. If the input
 * already contains "/", returned untouched. `date` is used to infer the FY
 * (Apr–Mar); missing date falls back to today's FY.
 */
export const formatDocNumber = (docNumber, date) => {
  if (!docNumber) return '';
  if (docNumber.includes('/')) return docNumber;
  const d = date ? new Date(date) : new Date();
  const y = d.getFullYear();
  const month = d.getMonth() + 1;
  const fyStart = month >= 4 ? y : y - 1;
  const fyStartShort = fyStart.toString().slice(-2);
  const fyEndShort = (fyStart + 1).toString().slice(-2);
  const fy = `${fyStartShort}-${fyEndShort}`;
  // BUG-FE-125: accept multi-segment legacy codes like "PO-AP-00012" by
  // capturing everything before the final dash-separated number.
  const m = docNumber.match(/^([A-Z][A-Z0-9_-]*?)[-_](\d+)$/i);
  if (!m) return docNumber;
  const [, prefix, seq] = m;
  return `BHSPL/${fy}/${prefix.toUpperCase()}/${seq.padStart(5, '0')}`;
};

// BUG-FE-126: bare date strings ("2026-04-28") are parsed by dayjs() in browser
// local TZ, so calling .tz('Asia/Kolkata') on a non-IST browser shifts them by
// up to a day (e.g. Apr 28 in UTC -> Apr 28 05:30 IST is fine, but Apr 28 in
// PST -> Apr 28 12:30 IST is fine; however a same-day 22:00 PST creation
// timestamp typed as date-only would land on Apr 29 IST). For YYYY-MM-DD strings
// we therefore *don't* convert TZ — we treat the date as already-IST.
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Backend stores `DateTime` as naive UTC (no tz suffix). dayjs(str) parses
// such strings as browser-local, so a non-tagged UTC value displayed via
// .tz(IST) ends up +5:30 ahead. Force-parse as UTC, then convert to IST.
export const formatDate = (date) => {
  if (!date) return '-';
  if (typeof date === 'string' && DATE_ONLY_RE.test(date)) {
    return dayjs(date, 'YYYY-MM-DD').format(DATE_FORMAT);
  }
  return dayjs.utc(date).tz(IST_TZ).format(DATE_FORMAT);
};

export const formatDateTime = (date) => {
  if (!date) return '-';
  if (typeof date === 'string' && DATE_ONLY_RE.test(date)) {
    return dayjs(date, 'YYYY-MM-DD').format(DATETIME_FORMAT);
  }
  return dayjs.utc(date).tz(IST_TZ).format(DATETIME_FORMAT);
};

export const formatDateForAPI = (date) => {
  // BUG-FE-127: distinguish between "no value" and "0" / falsy-but-valid.
  // Empty string / null / undefined return undefined so the caller can omit
  // the param. A real date that happens to evaluate falsy in JS is preserved.
  if (date === '' || date === null || date === undefined) return undefined;
  if (typeof date === 'string' && DATE_ONLY_RE.test(date)) {
    return date; // already in API format, preserve as-is
  }
  const parsed = dayjs(date);
  if (!parsed.isValid()) return undefined;
  return parsed.tz(IST_TZ).format('YYYY-MM-DD');
};

export const downloadExcel = (data, filename, sheetName = 'Sheet1') => {
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, `${filename}_${dayjs().format('YYYYMMDD_HHmmss')}.xlsx`);
};

// BUG-FE-128: accept an `options.leading` flag so callers can opt into a
// leading-edge call (lodash-style). Default behaviour (trailing-edge only)
// is preserved for existing call-sites.
export const debounce = (func, wait = 300, options = {}) => {
  const { leading = false } = options;
  let timeout = null;
  let lastArgs = null;
  let lastInvokeTime = 0;
  const debounced = (...args) => {
    lastArgs = args;
    const now = Date.now();
    const callLeading = leading && (timeout === null) && (now - lastInvokeTime >= wait);
    if (callLeading) {
      lastInvokeTime = now;
      func(...args);
    }
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => {
      timeout = null;
      if (!callLeading) {
        lastInvokeTime = Date.now();
        func(...lastArgs);
      }
    }, wait);
  };
  debounced.cancel = () => {
    if (timeout) clearTimeout(timeout);
    timeout = null;
    lastArgs = null;
  };
  return debounced;
};

export const getInitials = (name) => {
  if (!name) return '?';
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
};

export const truncate = (str, len = 50) => {
  if (!str) return '';
  return str.length > len ? str.slice(0, len) + '...' : str;
};

export const generateId = () => {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
};

export const parseQueryParams = (search) => {
  return Object.fromEntries(new URLSearchParams(search));
};

export const buildQueryString = (params) => {
  const filtered = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== null && v !== ''
  );
  return new URLSearchParams(filtered).toString();
};

export const getErrorMessage = (error) => {
  if (typeof error === 'string') return error;

  // BUG-FE-130: backend 422 validation errors are returned as
  // { success: false, message: 'Validation failed', errors: [{loc, msg, type}] }
  // NOT as { detail: [...] }. Handle 'errors' array first so the field-level
  // messages are surfaced instead of the generic 'Validation failed' fallback.
  const errorsArr = error?.response?.data?.errors;
  if (Array.isArray(errorsArr) && errorsArr.length > 0) {
    return errorsArr.map((d) => {
      const field = (d.loc || []).filter(l => l !== 'body').join(' → ') || '';
      // Strip the 'Value error, ' prefix Pydantic v2 adds to the msg
      const raw = d.msg || d.message || '';
      const msg = raw.replace(/^Value error,\s*/i, '');
      return field ? `${field}: ${msg}` : msg;
    }).join('\n');
  }

  if (error?.response?.data?.detail) {
    const detail = error.response.data.detail;
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail)) return detail.map((d) => {
      const field = (d.loc || []).filter(l => l !== 'body').join(' → ') || '';
      const raw = d.msg || d.message || '';
      const msg = raw.replace(/^Value error,\s*/i, '');
      return field ? `${field}: ${msg}` : msg;
    }).join('\n');
    // BUG-FE-123: previously fell through to JSON.stringify which leaks
    // internal field paths and types into the toast. Surface a generic
    // message instead and let the caller log the full object.
    if (detail && typeof detail === 'object') {
      // Common shapes: {message: '...'} or {error: '...'}
      if (typeof detail.message === 'string') return detail.message;
      if (typeof detail.error === 'string') return detail.error;
      return 'Request failed (see network log for details)';
    }
    return String(detail);
  }
  if (error?.response?.data?.message) return error.response.data.message;
  if (error?.message) return error.message;
  return 'An unexpected error occurred';
};

// BUG-FE-129: Translate FastAPI 422 validation errors into per-field errors and
// push them into an Antd Form via form.setFields(). Returns the list of field
// errors that were applied so the caller can decide whether to also toast.
//
// Usage:
//   try { await api.post(...); }
//   catch (err) {
//     const applied = applyFieldErrors(form, err);
//     if (!applied.length) message.error(getErrorMessage(err));
//   }
export const applyFieldErrors = (form, error) => {
  if (!form || typeof form.setFields !== 'function') return [];
  // Handle both 'errors' array (backend 422 custom format) and 'detail' array (raw FastAPI format)
  const source = error?.response?.data?.errors || error?.response?.data?.detail;
  if (!Array.isArray(source)) return [];
  const fieldEntries = [];
  for (const d of source) {
    const loc = (d.loc || []).filter((l) => l !== 'body');
    if (!loc.length) continue;
    // Antd NamePath: single string for top-level fields, array for nested.
    const name = loc.length === 1 ? loc[0] : loc;
    const raw = d.msg || d.message || 'Invalid value';
    const msg = raw.replace(/^Value error,\s*/i, '');
    fieldEntries.push({ name, errors: [msg] });
  }
  if (fieldEntries.length) {
    form.setFields(fieldEntries);
  }
  return fieldEntries;
};

// BUG-FE-124: unify with authStore.hasPermission — default-DENY when permissions
// list is empty (was default-allow which contradicted authStore behavior and
// silently exposed gated features to unprivileged users importing this helper).
// Accepts both legacy object permissions ({module, actions:[...]}) and
// dotted-string permissions ("module.action.resource") for compatibility.
export const hasPermission = (permissions, module, action) => {
  if (!permissions || permissions.length === 0) return false;
  return permissions.some((p) => {
    if (typeof p === 'string') {
      const [pMod, pAct] = p.split('.');
      return (pMod === module || pMod === '*') && (!action || pAct === action || pAct === '*');
    }
    return p && p.module === module && (!action || p.actions?.includes(action));
  });
};

export const sortByKey = (arr, key, order = 'asc') => {
  return [...arr].sort((a, b) => {
    if (a[key] < b[key]) return order === 'asc' ? -1 : 1;
    if (a[key] > b[key]) return order === 'asc' ? 1 : -1;
    return 0;
  });
};

export const groupBy = (arr, key) => {
  return arr.reduce((acc, item) => {
    const group = item[key] || 'Other';
    acc[group] = acc[group] || [];
    acc[group].push(item);
    return acc;
  }, {});
};

export const flattenTree = (tree, childrenKey = 'children') => {
  const result = [];
  const flatten = (nodes) => {
    nodes.forEach((node) => {
      result.push(node);
      if (node[childrenKey]?.length) {
        flatten(node[childrenKey]);
      }
    });
  };
  flatten(tree);
  return result;
};

export const calcTaxAmount = (amount, rate) => {
  return Number(((amount * rate) / 100).toFixed(2));
};

export const calcTotalWithTax = (amount, cgst = 0, sgst = 0, igst = 0) => {
  const cgstAmt = calcTaxAmount(amount, cgst);
  const sgstAmt = calcTaxAmount(amount, sgst);
  const igstAmt = calcTaxAmount(amount, igst);
  return Number((amount + cgstAmt + sgstAmt + igstAmt).toFixed(2));
};

export const getStatusColor = (status) => {
  if (!status) return '#8c8c8c';
  return STATUS_COLORS[status.toLowerCase()] || '#8c8c8c';
};

export const getStatusText = (status) => {
  if (!status) return 'Unknown';
  return STATUS_LABELS[status.toLowerCase()] || status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
};

export const handleFormValidationFailed = (errorInfo) => {
  try {
    message.error('Form submission blocked. Please correct the highlighted errors.');
    const firstErrorField = errorInfo?.errorFields?.[0];
    if (firstErrorField) {
      const fieldName = Array.isArray(firstErrorField.name)
        ? firstErrorField.name.join('_')
        : firstErrorField.name;

      const element = document.getElementById(fieldName) ||
                      document.querySelector(`[name="${fieldName}"]`) ||
                      document.getElementById(`parent_${fieldName}`) ||
                      document.querySelector(`[id$="_${fieldName}"]`);

      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => {
          try {
            element.focus();
          } catch (e) {
            // silent
          }
        }, 300);
      }
    }
  } catch (err) {
    console.error('Error in handleFormValidationFailed:', err);
  }
};
