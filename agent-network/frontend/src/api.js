import { useEffect, useRef, useState, useCallback } from 'react';

const BASE = '/api/v1';

export class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api(path, { method = 'GET', body, headers = {} } = {}) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check that the backend is running on port 4000.');
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  if (!res.ok) throw new ApiError(res.status, json?.error ?? `Request failed (${res.status})`, json?.code);
  return json;
}

// Fetches on mount and then every `ms`; `ms` may be a function of the latest data so a screen can
// poll quickly while work is in flight and slowly once it settles.
export function usePoll(path, ms = 3000, enabled = true) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const timer = useRef(null);
  const live = useRef(true);
  // The interval is read through a ref so callers can pass an inline function without it
  // re-triggering the effect (a new function identity on every render caused a fetch loop).
  const msRef = useRef(ms);
  msRef.current = ms;

  const load = useCallback(async () => {
    if (!path || !enabled) return;
    try {
      const data = await api(path);
      if (!live.current) return;
      setState({ data, error: null, loading: false });
      const next = typeof msRef.current === 'function' ? msRef.current(data) : msRef.current;
      if (next) timer.current = setTimeout(load, next);
    } catch (error) {
      if (!live.current) return;
      setState((s) => ({ ...s, error, loading: false }));
      timer.current = setTimeout(load, 5000);
    }
  }, [path, enabled]);

  useEffect(() => {
    live.current = true;
    setState({ data: null, error: null, loading: true });
    load();
    return () => {
      live.current = false;
      clearTimeout(timer.current);
    };
  }, [load]);

  return { ...state, reload: load };
}

export const timeAgo = (iso) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

export const fmt = (n, d = 2) => (n == null ? '–' : Number(n).toFixed(d));
