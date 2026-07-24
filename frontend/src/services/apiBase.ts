// Single source of truth for the backend base URL.
// Resolution order:
//   1. VITE_API_BASE — set at build time (frontend/.env.production or shell env)
//   2. production build without override — same origin as the SPA
//      (Apache serves both the SPA and /anpr_backend on the prod server)
//   3. dev fallback — local XAMPP backend
export const API_BASE =
  (import.meta as { env?: { VITE_API_BASE?: string; PROD?: boolean } }).env?.VITE_API_BASE
  || ((import.meta as { env?: { PROD?: boolean } }).env?.PROD
    ? window.location.origin + '/anpr_backend'
    : 'http://127.0.0.1/anpr_backend');
