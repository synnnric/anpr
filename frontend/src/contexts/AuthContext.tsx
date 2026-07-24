import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { fetchMe, ssoLogin, type AuthUser } from '../services/authService';

type AuthStatus = 'unknown' | 'authenticated' | 'unauthenticated' | 'blocked';

interface AuthContextValue {
  user: AuthUser | null;
  token: string | null;
  status: AuthStatus;
  error: string | null;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);
const TOKEN_KEY = 'anpr_auth_token';
const PARAM_NAME = 'username';

function readUsernameParam(): string | null {
  const u = new URLSearchParams(window.location.search).get(PARAM_NAME);
  return u && u.trim() ? u.trim() : null;
}

function stripUsernameParam() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(PARAM_NAME)) return;
  url.searchParams.delete(PARAM_NAME);
  window.history.replaceState({}, '', url.pathname + (url.search ? url.search : '') + url.hash);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));
  const [status, setStatus] = useState<AuthStatus>('unknown');
  const [error, setError] = useState<string | null>(null);

  // First-load decision tree:
  //   1. If ?username=… is in the URL, exchange it for a session token (overrides any stored token).
  //   2. Else, if a token is in localStorage, validate it via /me.
  //   3. Else, we're "blocked" — caller must arrive through the parent platform.
  useEffect(() => {
    let cancelled = false;
    const paramUsername = readUsernameParam();

    if (paramUsername) {
      ssoLogin(paramUsername)
        .then(res => {
          if (cancelled) return;
          localStorage.setItem(TOKEN_KEY, res.token);
          setToken(res.token);
          setUser(res.user);
          setStatus('authenticated');
          setError(null);
          stripUsernameParam();
        })
        .catch(err => {
          if (cancelled) return;
          localStorage.removeItem(TOKEN_KEY);
          setToken(null);
          setUser(null);
          setStatus('blocked');
          setError((err as Error).message || 'SSO failed');
        });
      return () => { cancelled = true; };
    }

    if (!token) {
      setStatus('blocked');
      return;
    }

    fetchMe(token)
      .then(u => { if (!cancelled) { setUser(u); setStatus('authenticated'); } })
      .catch(() => {
        if (cancelled) return;
        localStorage.removeItem(TOKEN_KEY);
        setToken(null);
        setUser(null);
        setStatus('blocked');
      });
    return () => { cancelled = true; };
    // We intentionally only run this once on mount — `token` is read via the initializer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setUser(null);
    setStatus('blocked');
    setError(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, token, status, error, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
