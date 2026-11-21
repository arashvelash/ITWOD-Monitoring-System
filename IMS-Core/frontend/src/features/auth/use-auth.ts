import { useAuthState } from '@/lib/auth-store';
import type { UserRole } from '@/lib/types';

const RANK: Record<UserRole, number> = { VIEWER: 1, OPERATOR: 2, ADMIN: 3 };

export function roleAtLeast(role: UserRole | undefined, min: UserRole): boolean {
  return role ? RANK[role] >= RANK[min] : false;
}

export function useAuth() {
  const state = useAuthState();
  return {
    ...state,
    can: (min: UserRole) => roleAtLeast(state.user?.role, min),
  };
}
