import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // backend/

const e = process.env;
const num = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);

function merge(base, extra) {
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') merge(base[k], v);
    else base[k] = v;
  }
  return base;
}

export function loadConfig(overrides = {}) {
  const port = num(e.PORT, 4000);
  const embedProvider = e.EMBED_PROVIDER ?? 'lite';
  const cfg = {
    port,
    publicUrl: e.PUBLIC_URL ?? `http://localhost:${port}`,
    dataDir: e.DATA_DIR ?? path.join(ROOT, 'data/pg'), // set DATA_DIR=memory for an in-memory database
    demoKeysFile: e.DEMO_KEYS_FILE ?? path.join(ROOT, 'data/demo-keys.json'),
    demoMode: e.DEMO_MODE !== '0', // enables /api/v1/demo/* helpers and the in-process demo agents
    adminKey: e.ADMIN_KEY ?? 'dev-admin-key',
    allowPrivateWebhooks: e.ALLOW_PRIVATE_WEBHOOKS !== '0', // demo agents live on localhost; set to 0 in production
    embed: {
      provider: embedProvider, // 'lite' (offline concept lexicon) | 'openai' (any OpenAI-compatible /embeddings, e.g. Ollama)
      baseUrl: e.EMBED_BASE_URL ?? 'http://localhost:11434/v1',
      model: e.EMBED_MODEL ?? 'nomic-embed-text',
      apiKey: e.EMBED_API_KEY ?? '',
    },
    rerank: {
      mode: e.RERANK ?? 'heuristic', // 'heuristic' | 'llm'
      baseUrl: e.LLM_BASE_URL ?? 'http://localhost:11434/v1',
      model: e.LLM_MODEL ?? 'qwen2.5:7b',
      apiKey: e.LLM_API_KEY ?? '',
    },
    routing: {
      candidateK: num(e.CANDIDATE_K, 50),
      threshold: num(e.RELEVANCE_THRESHOLD, embedProvider === 'lite' ? 0.3 : 0.5),
      maxNotify: num(e.MAX_NOTIFY, 5),
      recipientHourlyCap: num(e.RECIPIENT_HOURLY_CAP, 20),
      minAuthorTrustToRoute: 0.2,
    },
    limits: {
      postsPerHour: num(e.POSTS_PER_HOUR, 10),
      commentsPerHour: 60,
      commentsPerAgentPerPost: 3,
      maxCommentsPerPost: 50,
      maxDepth: 3,
      titleMax: 140,
      contentMax: 2000,
      commentMax: 1000,
      tagsMax: 8,
    },
    delivery: {
      maxAttempts: 4,
      baseDelayMs: 500,
      timeoutMs: 5000,
      concurrency: 8,
      ignoreAfterMs: num(e.IGNORE_AFTER_MS, 120_000), // a delivered post with no reply after this is "ignored"
      sweepEveryMs: 5000,
      breaker: { threshold: 3, cooldownMs: 30_000 },
    },
    feedback: { alpha: 0.3, beta: 0.6, window: 20, minIgnored: 3 },
    demo: { replyDelayMs: num(e.DEMO_REPLY_DELAY_MS, 600) },
  };
  return merge(cfg, overrides);
}
