import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/shared/api/client";
import type { Me } from "@/shared/types";
import { SCOPED_GRANTS } from "./scopedGrants";

interface AuthState {
  me: Me | null;
  loading: boolean;
  isAdmin: boolean;
  login: (username: string, password: string) => Promise<void>;
  switchPosition: (positionId: number) => Promise<void>;
  logout: () => void;
  can: (code: string) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const queryClient = useQueryClient();

  async function loadMe() {
    try {
      const { data } = await api.get<Me>("/api/auth/me");
      setMe(data);
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (localStorage.getItem("token")) loadMe();
    else setLoading(false);
  }, []);

  async function login(username: string, password: string) {
    const form = new URLSearchParams({ username, password });
    const { data } = await api.post<{ access_token: string }>("/api/auth/login", form);
    localStorage.setItem("token", data.access_token);
    setLoading(true);
    await loadMe();
  }

  async function switchPosition(positionId: number) {
    const { data } = await api.post<{ access_token: string }>(
      "/api/auth/switch-position", { position_id: positionId },
    );
    localStorage.setItem("token", data.access_token);
    // Every cached response was computed under the OLD hat — permissions, data scope
    // and "can I sign this" all key off the active position. Serving any of it after a
    // switch shows the previous position's answer: an Inventory Manager who had just
    // signed as Assistant Manager still saw the approve buttons dead, because the
    // batch in cache still said nothing was theirs to sign.
    queryClient.clear();
    setLoading(true);
    await loadMe();
  }

  function logout() {
    localStorage.removeItem("token");
    setMe(null);
  }

  const isAdmin = Boolean(
    me && (
      me.roles?.includes("ADMIN")
      || me.roles?.includes("SUPERADMIN")
      || me.roles?.includes("SUPERUSER")
      || me.permissions?.includes("admin.workflow.manage")
      || me.employee?.code === "00001"
      || me.employee?.name === "Administrator"
    )
  );

  // A button's own code, or the Stock Transfer grant scoped over it (see
  // scopedGrants.ts — the server enforces the scope).
  const can = (code: string) => !!me && (
    isAdmin
    || me.permissions.includes(code)
    || (SCOPED_GRANTS[code] !== undefined && me.permissions.includes(SCOPED_GRANTS[code])));

  return (
    <AuthContext.Provider value={{ me, loading, isAdmin, login, switchPosition, logout, can }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
