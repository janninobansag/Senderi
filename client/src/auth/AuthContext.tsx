import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError, apiFetch } from "../api/client";

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  bio: string;
  info: {
    location?: string;
    website?: string;
  };
  avatarId?: string;
  coverId?: string;
  createdAt: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  isLoading: boolean;
  initializationError: string | null;
  register: (input: { email: string; password: string; displayName: string }) => Promise<void>;
  signIn: (input: { email: string; password: string }) => Promise<void>;
  signOut: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [initializationError, setInitializationError] = useState<string | null>(null);

  const refreshUser = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await apiFetch<{ user: AuthUser }>("/api/auth/me");
      setUser(response.user);
      setInitializationError(null);
    } catch (error) {
      setUser(null);
      setInitializationError(
        isUnauthorized(error)
          ? null
          : "We couldn’t restore your session. You can still sign in or create an account.",
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshUser();
  }, [refreshUser]);

  const register = useCallback(async (input: { email: string; password: string; displayName: string }) => {
    const response = await apiFetch<{ user: AuthUser }>("/api/auth/register", {
      method: "POST",
      body: input,
    });
    setUser(response.user);
    setInitializationError(null);
  }, []);

  const signIn = useCallback(async (input: { email: string; password: string }) => {
    const response = await apiFetch<{ user: AuthUser }>("/api/auth/login", {
      method: "POST",
      body: input,
    });
    setUser(response.user);
    setInitializationError(null);
  }, []);

  const signOut = useCallback(async () => {
    await apiFetch<void>("/api/auth/logout", { method: "POST" });
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ user, isLoading, initializationError, register, signIn, signOut, refreshUser }),
    [user, isLoading, initializationError, register, signIn, signOut, refreshUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider.");
  return context;
}
