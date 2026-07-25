import { Navigate } from "react-router-dom";

/**
 * /inventory has no dashboard of its own — it only ever re-rendered the stock
 * screens — so it sends people to the first real one instead of showing a shell.
 * Replace this with a genuine summary if one is ever built.
 */
export function InventoryOverviewPage() {
  return <Navigate to="/inventory/stock-balance" replace />;
}
