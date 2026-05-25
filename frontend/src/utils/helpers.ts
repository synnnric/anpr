export function generateMessageId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 16; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export function decodeBase64(str: string): string {
  try {
    return atob(str);
  } catch {
    return str;
  }
}

export function encodeBase64(str: string): string {
  try {
    return btoa(str);
  } catch {
    return str;
  }
}

export function decodeBase64Utf8(str: string): string {
  try {
    const bytes = atob(str);
    const uint8Array = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      uint8Array[i] = bytes.charCodeAt(i);
    }
    return new TextDecoder('utf-8').decode(uint8Array);
  } catch {
    return str;
  }
}

export function encodeBase64Utf8(str: string): string {
  try {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(str);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  } catch {
    return str;
  }
}

export function formatTimestamp(ts: number): string {
  if (!ts) return 'N/A';
  const d = ts > 1e12 ? new Date(ts) : new Date(ts * 1000);
  return d.toLocaleString();
}

/**
 * Parse a backend (Postgres) timestamp string as a Date.
 *
 * The DB container runs in UTC and returns naked strings like
 * "2026-05-12 09:39:59.568785" — JS would otherwise treat that as local time
 * and shift it by the viewer's offset. We append "Z" when no TZ is present so
 * the resulting Date is anchored to UTC; toLocaleString() then renders it in
 * the viewer's local TZ.
 *
 * Strings that already carry a TZ (Z or ±HH:MM) are parsed as-is.
 */
export function parsePgTs(ts: string | null | undefined): Date | null {
  if (!ts) return null;
  let iso = ts.includes('T') ? ts : ts.replace(' ', 'T');
  if (!/[Z+-]\d{0,2}:?\d{0,2}$/.test(iso)) iso += 'Z';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

/** Full date+time in the viewer's local TZ (or em-dash on null). */
export function fmtPgTs(ts: string | null | undefined): string {
  const d = parsePgTs(ts);
  return d ? d.toLocaleString() : '—';
}

/** Time-only (HH:MM:SS) in the viewer's local TZ. */
export function fmtPgTime(ts: string | null | undefined): string {
  const d = parsePgTs(ts);
  return d ? d.toLocaleTimeString() : '—';
}

/**
 * Idle / disconnect-friendly time formatter.
 *
 *   < 1 minute      →  "Ns ago"               (still effectively live)
 *   < 1 hour        →  "Nm ago"               (recent)
 *   < 1 day         →  "Hh Mm Ss ago"         (precise — device may still be in trouble)
 *   ≥ 1 day         →  absolute datetime      (long offline → exact last-online point matters more than relative)
 */
export function fmtIdleTime(ts: string | null | undefined): string {
  const d = parsePgTs(ts);
  if (!d) return '—';
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 0) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${h}h ${m}m ${sec}s ago`;
  }
  // ≥ 24h — show absolute local date+time
  return d.toLocaleString();
}

export function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

export function truncate(str: string, len: number): string {
  if (str.length <= len) return str;
  return str.slice(0, len) + '...';
}
