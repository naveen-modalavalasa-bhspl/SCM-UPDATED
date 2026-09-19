import { INDENT_MASTER_GROUPS, MastersShell } from "@/modules/masters/pages/MastersPage";

/** Indents > Masters — the two rules about raising a request: what a BOM puts on the
 *  form, and which items a role or region may ask for at all.
 *
 *  Same components as `/masters`; gated by `page.ind_masters.view`, inheriting from
 *  `page.masters.view`. */
export function IndentMastersPage() {
  return <MastersShell groups={INDENT_MASTER_GROUPS} eyebrow="Indents" title="Request masters" />;
}
