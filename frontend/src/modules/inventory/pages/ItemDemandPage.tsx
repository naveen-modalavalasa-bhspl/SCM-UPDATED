import { Navigate } from "react-router-dom";

/** Demand by Item has been removed from the inventory frontend. */
export function ItemDemandPage() {
  return <Navigate to="/inventory" replace />;
}
