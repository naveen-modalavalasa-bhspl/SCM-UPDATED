/**
 * The number card's data and its rules. The fields, the pattern and every part of the
 * number come from the server (`platform/doc_numbering`), so editing a series on
 * Settings > Document Numbering changes the card with no change here.
 */
import { api } from "@/shared/api/client";

export type DocNumberField = "organisation" | "project" | "department" | "fiscal_year";

export interface DocNumberOption { id: number; code?: string | null; name: string }

export interface DocNumberCardData {
  doc_type: string;
  pattern: string;
  prefix: string;
  fields: { key: DocNumberField; label: string; in_number: boolean }[];
  fiscal_years: string[];
  current_fiscal_year: string;
  organisations: DocNumberOption[];
  departments: DocNumberOption[];
  projects: DocNumberOption[];
  default_organization_id: number | null;
  own_project_id: number | null;
  /** What HCM fixes for the person raising (2026-11-09): their project, else their
   *  department matched by name to the feed. Indents, STRs and monthly indents lock these;
   *  the save fixes the same values. */
  mapped_project_id?: number | null;
  mapped_project_name?: string | null;
  mapped_org_department_id?: number | null;
  mapped_org_department_name?: string | null;
  /** A default organisation is configured, so documents raised by a person use it. */
  organisation_fixed?: boolean;
}

export interface DocNumberPart {
  kind: string;
  /** Null: a selection not made yet. */
  text: string | null;
  field: DocNumberField | null;
}

export interface DocNumberPreview {
  number: string | null;
  parts: DocNumberPart[];
  missing: DocNumberField[];
  scope_source: "project" | "department" | null;
}

/** The part of a form's state the card edits. */
export interface DocNumberValue {
  organizationId: number | "";
  projectId: number | "";
  orgDepartmentId: number | "";
  fiscalYear: string;
  /** Snapshots: a closed organisation on a draft, or a carried project with no master row,
   *  still has to show its name. `projectName` also drives the number when `projectId`
   *  is empty. */
  organizationName?: string;
  projectName?: string;
  departmentName?: string;
}

export interface DocNumberLocks {
  /** Fixed once submitted: nothing on the card can change. */
  all?: boolean;
  organisation?: boolean;
  project?: boolean;
  department?: boolean;
  /** Why a locked field is locked, when it is not "copied from the document before". */
  reasons?: Partial<Record<DocNumberField, string>>;
}

export const docNumberApi = {
  card: (docType: string) =>
    api.get<DocNumberCardData>(`/api/document-numbering/${encodeURIComponent(docType)}/card`)
      .then((r) => r.data),
  preview: (docType: string, value: DocNumberValue) =>
    api.get<DocNumberPreview>(`/api/document-numbering/${encodeURIComponent(docType)}/preview`, {
      params: {
        organization_id: value.organizationId === "" ? undefined : value.organizationId,
        project_id: value.projectId === "" ? undefined : value.projectId,
        org_department_id: value.orgDepartmentId === "" ? undefined : value.orgDepartmentId,
        project_name: value.projectId === "" ? value.projectName || undefined : undefined,
        fiscal_year: value.fiscalYear || undefined,
      },
    }).then((r) => r.data),
};

const lastProjectKey = (docType: string) => `scm.document-number.project.${docType}`;

/** Per-browser convenience only, so a blocked store simply means no remembered choice. */
export function readLastProject(docType: string): number | null {
  try {
    return Number(window.localStorage.getItem(lastProjectKey(docType))) || null;
  } catch {
    return null;
  }
}

export function rememberProject(docType: string, projectId: number): void {
  try {
    window.localStorage.setItem(lastProjectKey(docType), String(projectId));
  } catch {
    // Nothing depends on it.
  }
}

export interface DocNumberDefaults {
  patch: Partial<DocNumberValue>;
  /** Filled from a guess, so the card asks the person to check it. */
  guessed: DocNumberField[];
}

/**
 * What a new document opens on. Anything already filled (the document before it, a
 * copy) stands. Organisation: the configured default, else the first in the list as a
 * guess. Project: the person's own from HCM, else their last choice here, else the first
 * as a guess, unless a department or a carried project already answers it. Year: today's.
 */
export function openingValues(
  card: DocNumberCardData, value: DocNumberValue,
  { lastProject = null, defaultProject = true, locks = {} }: {
    lastProject?: number | null; defaultProject?: boolean; locks?: DocNumberLocks;
  } = {},
): DocNumberDefaults {
  const patch: Partial<DocNumberValue> = {};
  const guessed: DocNumberField[] = [];
  if (!value.fiscalYear) patch.fiscalYear = card.current_fiscal_year;
  if (value.organizationId === "" && !locks.organisation && !locks.all) {
    const first = card.organisations[0]?.id;
    const chosen = card.default_organization_id ?? first;
    if (chosen != null) {
      patch.organizationId = chosen;
      if (card.default_organization_id == null) guessed.push("organisation");
    }
  }
  const answered = value.projectId !== "" || value.orgDepartmentId !== "" || !!value.projectName;
  if (defaultProject && !answered && !locks.project && !locks.all) {
    const known = (id: number | null) => (id != null && card.projects.some((p) => p.id === id) ? id : null);
    const own = known(card.own_project_id);
    const last = known(lastProject);
    const chosen = own ?? last ?? card.projects[0]?.id;
    if (chosen != null) {
      patch.projectId = chosen;
      if (own == null && last == null) guessed.push("project");
    }
  }
  return { patch, guessed };
}

/** A saved draft keeps its number only while the selection still prints the same way. */
export function numberWillChange(saved: string | null | undefined, previewed: string | null): boolean {
  if (!saved || !previewed || saved.startsWith("DRAFT-")) return false;
  return !saved.startsWith(previewed.replace(/#+$/, ""));
}

/** A new document's card value, nothing chosen yet. */
export const emptyDocNumberValue = (): DocNumberValue => ({
  organizationId: "", projectId: "", orgDepartmentId: "", fiscalYear: "",
});

/** A saved document's scope, in the shape the card edits. */
export const docNumberValueFrom = (doc: {
  organization_id?: number | null; organization_name?: string | null;
  org_department_id?: number | null; org_department_name?: string | null;
  project_id?: number | null; project_name?: string | null; fiscal_year?: string | null;
}): DocNumberValue => ({
  organizationId: doc.organization_id ?? "",
  organizationName: doc.organization_name ?? "",
  orgDepartmentId: doc.org_department_id ?? "",
  departmentName: doc.org_department_name ?? "",
  projectId: doc.project_id ?? "",
  projectName: doc.project_name ?? "",
  fiscalYear: doc.fiscal_year ?? "",
});

/** The same values on a NEW document raised from `doc`: the year is never inherited. */
export const docNumberValueCarried: typeof docNumberValueFrom = (doc) => ({
  ...docNumberValueFrom(doc), fiscalYear: "",
});

/** What goes on the wire. Project OR department, the way the number reads them. */
export const docNumberPayload = (value: DocNumberValue) => ({
  organization_id: value.organizationId === "" ? null : value.organizationId,
  project_id: value.projectId === "" ? null : value.projectId,
  org_department_id: value.projectId !== "" || value.orgDepartmentId === ""
    ? null : value.orgDepartmentId,
  fiscal_year: value.fiscalYear || null,
});

/**
 * What HCM fixes for the person raising an indent, STR or monthly indent, as card locks
 * and the values to open on. Their project, else their department; with neither, both
 * stay open and one must be picked. The organisation is locked when a default is
 * configured. Mirrors `scope.resolve_for_raiser`, which fixes the same values on save.
 */
export function raiserScope(card: DocNumberCardData): {
  locks: DocNumberLocks; patch: Partial<DocNumberValue>;
} {
  const fromHcm = "Set from your HCM record.";
  const project = card.mapped_project_id ?? null;
  const department = card.mapped_org_department_id ?? null;
  const locks: DocNumberLocks = { reasons: {} };
  const patch: Partial<DocNumberValue> = {};
  if (card.organisation_fixed && card.default_organization_id != null) {
    locks.organisation = true;
    locks.reasons!.organisation = "Documents are raised under this organisation.";
    patch.organizationId = card.default_organization_id;
  }
  if (project != null) {
    locks.project = locks.department = true;
    locks.reasons!.project = fromHcm;
    locks.reasons!.department = "Your project prints instead.";
    Object.assign(patch, { projectId: project, projectName: card.mapped_project_name ?? "",
                           orgDepartmentId: "" as const, departmentName: "" });
  } else if (department != null) {
    locks.project = locks.department = true;
    locks.reasons!.department = fromHcm;
    locks.reasons!.project = "You hold no project in HCM; your department prints.";
    Object.assign(patch, { orgDepartmentId: department,
                           departmentName: card.mapped_org_department_name ?? "",
                           projectId: "" as const, projectName: "" });
  }
  return { locks, patch };
}
