import type { ReactNode } from "react";
import { useAuth } from "@/shared/auth/AuthContext";

/** Renders children only if the user holds the permission. UX only — the backend
 * is the real gate. */
export function Can({ do: code, children }: { do: string; children: ReactNode }) {
  const { can } = useAuth();
  return can(code) ? <>{children}</> : null;
}
