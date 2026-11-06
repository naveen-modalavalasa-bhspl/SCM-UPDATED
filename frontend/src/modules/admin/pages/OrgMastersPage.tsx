import { MastersShell, ORG_MASTER_GROUPS } from "@/modules/masters/pages/MastersPage";

/** Settings > Organisation Masters — projects, facilities, HCM departments, and the
 *  organisation directory's organisations and departments.
 *
 *  Read-only on every one: their feeds own them and the write routes are not
 *  registered (rule 10). Under Settings rather than in a module, because filing them beside a
 *  module's own masters would imply somebody here can change them. Gated by
 *  `page.admin_org_masters.view`, inheriting from `page.masters.view`. */
export function OrgMastersPage() {
  return <MastersShell groups={ORG_MASTER_GROUPS} eyebrow="Settings" title="Organisation masters" />;
}
