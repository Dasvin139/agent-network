import crypto from 'node:crypto';

export const toVec = (arr) => `[${Array.from(arr, (x) => Number(x.toFixed(6))).join(',')}]`;
export const fromVec = (s) => JSON.parse(s);

export function normalize(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return Array.from(v, (x) => x / n);
}

export function cosine(a, b) {
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return d / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const newApiKey = () => `an_${crypto.randomBytes(24).toString('base64url')}`;
export const newSecret = () => `whsec_${crypto.randomBytes(24).toString('base64url')}`;
export const isUuid = (s) => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
export const round = (n, d = 3) => (n == null ? null : Number(Number(n).toFixed(d)));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
