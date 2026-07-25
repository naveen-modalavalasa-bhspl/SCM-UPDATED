import { Outlet } from "react-router-dom";

/**
 * Parent for the legacy /warehouse/transactions/* paths.
 *
 * Each warehouse screen is now its own entry in the left rail and has a flat route
 * (/warehouse/grn and so on), so this no longer draws a sub-navigation strip — two
 * levels of navigation showing the same six links was just noise. The nested paths
 * stay routable so older links keep working.
 */
export function TransactionsLayout() {
  return <Outlet />;
}

export default TransactionsLayout;
