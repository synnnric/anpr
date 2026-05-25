import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { fetchMe, login as loginApi, type AuthUser } from '../services/authService';

interface AuthContextValue {
  user: AuthUser | null;
  token: string | null;
  status: 'unknown' | 'authenticated' | 'unauthenticated';
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);
const TOKEN_KEY = 'anpr_auth_token';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));
  const [status, setStatus] = useState<'unknown' | 'authenticated' | 'unauthenticated'>('unknown');

  // On mount or whenever token changes: validate it by hitting /me.
  // Bad/expired tokens land us in 'unauthenticated' which forces the login screen.
  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setUser(null);
      setStatus('unauthenticated');
      return;
    }
    fetchMe(token)
      .then(u => { if (!cancelled) { setUser(u); setStatus('authenticated'); } })
      .catch(() => {
        if (cancelled) return;
        localStorage.removeItem(TOKEN_KEY);
        setToken(null);
        setUser(null);
        setStatus('unauthenticated');
      });
    return () => { cancelled = true; };
  }, [token]);

  const login = useCallback(async (username: string, password: string) => {
    const res = await loginApi(username, password);
    localStorage.setItem(TOKEN_KEY, res.token);
    setUser(res.user);
    setToken(res.token);
    setStatus('authenticated');
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setUser(null);
    setStatus('unauthenticated');
  }, []);

  return (
    <AuthContext.Provider value={{ user, token, status, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
