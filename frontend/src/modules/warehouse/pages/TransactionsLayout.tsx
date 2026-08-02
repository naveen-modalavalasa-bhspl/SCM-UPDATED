import { Outlet } from "react-router-dom";

/**
 * The transactions shell — a pass-through.
 *
 * It used to carry its own tab strip over the document chain, which duplicated the
 * module tabs the layout already derives from `rbac_pages`. Two rows of navigation
 * disagreeing about where you are is worse than one, so the strip is gone and the
 * top module tabs are the only navigation. The route level stays because eleven
 * child routes hang off it.
 */
export default function TransactionsLayout() {
  return <Outlet />;
}
