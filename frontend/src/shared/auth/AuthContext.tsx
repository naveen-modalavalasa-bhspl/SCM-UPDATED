import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "@/shared/api/client";
import type { Me } from "@/shared/types";

interface AuthState {
  me: Me | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  switchPosition: (positionId: number) => Promise<void>;
  logout: () => void;
  can: (code: string) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

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
    setLoading(true);
    await loadMe();
  }

  function logout() {
    localStorage.removeItem("token");
    setMe(null);
  }

  const can = (code: string) => !!me?.permissions.includes(code);

  return (
    <AuthContext.Provider value={{ me, loading, login, switchPosition, logout, can }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
