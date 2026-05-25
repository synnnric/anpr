import type { AuthUser } from './authService';

const API_BASE = (import.meta as { env?: { VITE_API_BASE?: string } }).env?.VITE_API_BASE
  || 'http://127.0.0.1/anpr_backend';
const TOKEN_KEY = 'anpr_auth_token';

interface ApiResponse<T> { code: number; message: string; data: T }

function authHeader(): HeadersInit {
  const t = localStorage.getItem(TOKEN_KEY);
  return t ? { Authorization: `Bearer ${t}` } : {};
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(API_BASE + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...authHeader(),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json: ApiResponse<T> = await res.json();
  if (!res.ok || json.code !== 200) {
    throw new Error(json.message || `HTTP ${res.status}`);
  }
  return json.data;
}

export type Role = 'admin' | 'operator' | 'viewer';

export interface CreateUserPayload {
  username: string;
  password: string;
  display_name?: string;
  role: Role;
}

export interface UpdateUserPayload {
  display_name?: string | null;
  role?: Role;
  enabled?: boolean;
}

export const listUsers       = () => request<AuthUser[]>('GET', '/api/users');
export const createUser      = (body: CreateUserPayload) => request<{ id: number }>('POST', '/api/users', body);
export const updateUser      = (id: number, body: UpdateUserPayload) => request<AuthUser>('PUT', `/api/users/${id}`, body);
export const setUserPassword = (id: number, password: string) =>
  request<null>('POST', `/api/users/${id}/password`, { password });
export const deleteUser      = (id: number) => request<null>('DELETE', `/api/users/${id}`);
