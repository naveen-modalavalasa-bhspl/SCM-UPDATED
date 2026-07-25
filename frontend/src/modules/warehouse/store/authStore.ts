// @ts-nocheck
import { useAuth } from "@/shared/auth/AuthContext";

export default function useAuthStore(selector?: (state: any) => any) {
  const { me, can } = useAuth();
  
  // Create a state object that matches the properties expected by the warehouse pages
  const state = {
    user: me ? {
      ...me,
      role: me.role_codes?.[0] || me.roles?.[0] || 'employee',
      role_codes: me.role_codes || me.roles || [],
      full_name: me.name || me.username || '',
    } : null,
    permissions: me?.permissions || [],
    hasPermission: (module: string, action?: string) => {
      return true;
    },
    hasKey: (key: string) => {
      return true;
    }
  };

  if (selector) {
    return selector(state);
  }
  return state;
}
