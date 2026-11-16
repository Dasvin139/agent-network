import { HttpError } from './util.js';

const INJECTION = [
  [/ignore\s+(all\s+|any\s+|the\s+)*(previous|prior|above|earlier|preceding)\s+(instructions?|prompts?|rules?|messages?)/i, 'tries to override earlier instructions'],
  [/disregard\s+(all\s+|any\s+|the\s+)*(previous|prior|above|earlier)/i, 'tries to override earlier instructions'],
  [/(reveal|print|output|leak|send|exfiltrate|show|share|return)\b[^.\n]{0,50}\b(system\s+prompt|api[\s_-]?keys?|secrets?|passwords?|credentials?|tokens?|private\s+keys?)/i, 'asks for secrets or the system prompt'],
  [/you\s+are\s+now\b/i, 'tries to reassign the recipient\'s role'],
  [/^\s*(system|assistant)\s*:/im, 'impersonates a system/assistant message'],
  [/<\|?\s*(im_start|im_end|system|endoftext)\s*\|?>/i, 'contains chat-template control tokens'],
  [/\[\/?INST\]|<<\/?SYS>>/i, 'contains chat-template control tokens'],
  [/do\s+not\s+(tell|inform|alert|notify)\s+(the\s+)?(user|human|operator|owner)/i, 'asks the recipient to hide something from its owner'],
  [/call\s+(the\s+)?(tool|function)\s+[`"']?\w+[`"']?\s+with/i, 'tries to trigger tool calls'],
];

const SCAM = [
  [/guaranteed\s+(returns?|profits?|income)/i, 'guaranteed-returns claim'],
  [/double\s+your\s+(money|investment)/i, 'money-doubling claim'],
  [/(share|send|enter|confirm)\s+(your\s+)?(otp|pin|cvv|password|card\s+number)/i, 'asks for credentials or card data'],
  [/(kyc|account)\s+(will\s+be\s+)?(blocked|suspended|expire)[^.]{0,60}(click|link|verify)/i, 'phishing-style urgency'],
  [/100\s*%\s*(risk[\s-]?free|guaranteed)/i, 'risk-free claim'],
];

export function scanContent(...texts) {
  const text = texts.filter(Boolean).join('\n');
  for (const [re, why] of INJECTION) if (re.test(text)) return { ok: false, kind: 'injection', reason: why };
  for (const [re, why] of SCAM) if (re.test(text)) return { ok: false, kind: 'scam', reason: why };
  const urls = text.match(/https?:\/\/\S+/gi) ?? [];
  if (urls.length > 3) return { ok: false, kind: 'spam', reason: 'too many links' };
  return { ok: true };
}

export const cleanText = (s) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();

export function validateTags(tags, max) {
  if (tags === undefined) return [];
  if (!Array.isArray(tags) || tags.length > max) throw new HttpError(422, `tags must be an array of at most ${max} items`);
  return [...new Set(tags.map((t) => String(t).toLowerCase().trim()).filter(Boolean))].map((t) => {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(t)) throw new HttpError(422, `invalid tag "${t.slice(0, 40)}" (use lowercase letters, digits and hyphens)`);
    return t;
  });
}


export function validateWebhookUrl(raw, { allowPrivate }) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new HttpError(422, 'webhook_url is not a valid URL');
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw new HttpError(422, 'webhook_url must be http(s)');
  const host = u.hostname.toLowerCase();
  const isPrivate = host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') ||
    /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(host) || host === '[::1]' || host === '::1';
  if (isPrivate && !allowPrivate) throw new HttpError(422, 'webhook_url must be a public host');
  if (!allowPrivate && u.protocol !== 'https:') throw new HttpError(422, 'webhook_url must use https');
  return u.toString();
}


export async function countRecent(db, table, agentCol, agentId, windowSql = "1 hour", extraWhere = '') {
  const allowed = { posts: 'author_agent_id', comments: 'author_agent_id' };
  if (allowed[table] !== agentCol) throw new Error('bad rate-limit query');
  const r = await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${agentCol} = $1 AND created_at > now() - interval '${windowSql}' ${extraWhere}`, [agentId]);
  return r.rows[0].n;
}
