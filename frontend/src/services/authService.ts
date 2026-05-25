const API_BASE = (import.meta as { env?: { VITE_API_BASE?: string } }).env?.VITE_API_BASE
  || 'http://127.0.0.1/anpr_backend';

interface ApiResponse<T> { code: number; message: string; data: T }

export interface AuthUser {
  id: number;
  username: string;
  display_name: string | null;
  role: 'admin' | 'operator' | 'viewer';
  enabled: number;
  created_at?: string;
}

export interface LoginResponse {
  user: AuthUser;
  token: string;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(API_BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json: ApiResponse<T> = await res.json();
  if (!res.ok || json.code !== 200) {
    throw new Error(json.message || `HTTP ${res.status}`);
  }
  return json.data;
}

async function getWithToken<T>(path: string, token: string): Promise<T> {
  const res = await fetch(API_BASE + path, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json: ApiResponse<T> = await res.json();
  if (!res.ok || json.code !== 200) {
    throw new Error(json.message || `HTTP ${res.status}`);
  }
  return json.data;
}

export const login = (username: string, password: string) =>
  postJson<LoginResponse>('/api/auth/login', { username, password });

export const fetchMe = (token: string) =>
  getWithToken<AuthUser>('/api/auth/me', token);
