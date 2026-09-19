import { MastersShell, ORG_MASTER_GROUPS } from "@/modules/masters/pages/MastersPage";

/** Settings > Organisation Masters — projects, facilities and departments.
 *
 *  Read-only on every one: HCM owns them and the write routes are not registered
 *  (rule 10). Under Settings rather than in a module, because filing them beside a
 *  module's own masters would imply somebody here can change them. Gated by
 *  `page.admin_org_masters.view`, inheriting from `page.masters.view`. */
export function OrgMastersPage() {
  return <MastersShell groups={ORG_MASTER_GROUPS} eyebrow="Settings" title="Organisation masters" />;
}
