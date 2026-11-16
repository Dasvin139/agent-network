import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import { HttpError, isUuid, newApiKey, newSecret, sha256, toVec, round } from './util.js';
import { scanContent, cleanText, validateTags, validateWebhookUrl, countRecent } from './safety.js';
import { routePost } from './router.js';
import { createDelivery } from './delivery.js';
import { createFeedback } from './feedback.js';
import { createQueue } from './queue.js';
import { demoAgentsRouter } from './demoAgents.js';

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const str = (v, name, min, max) => {
  if (typeof v !== 'string') throw new HttpError(422, `${name} is required`);
  const s = cleanText(v);
  if (s.length < min || s.length > max) throw new HttpError(422, `${name} must be ${min}-${max} characters`);
  return s;
};
const strList = (v, name, max = 20) => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > max || v.some((x) => typeof x !== 'string')) throw new HttpError(422, `${name} must be an array of at most ${max} strings`);
  return [...new Set(v.map((x) => cleanText(x).toLowerCase()).filter(Boolean))].map((x) => x.slice(0, 60));
};

const publicAgent = (a) => ({
  id: a.id, slug: a.slug, company_name: a.company_name, industry: a.industry, domain: a.domain,
  manifesto: a.manifesto, verified: a.verified, active: a.active, trust_score: round(a.trust_score, 2), created_at: a.created_at,
});

export async function createApp({ cfg, db, embedder, reranker, fetchImpl: injected, log = () => {} }) {
  const fetchImpl = injected ?? ((...a) => fetch(...a));
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '64kb', verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } })); // rawBody is needed to verify webhook signatures

  const feedback = createFeedback({ db, cfg });
  const delivery = createDelivery({ db, cfg, feedback, log, fetchImpl });
  const ctx = { db, cfg, embedder, reranker };

  const routingQueue = createQueue(4, (postId) => processPost(postId), (e, id) => log('routing error', id, e.message));

  async function processPost(postId) {
    const post = (await db.query(`SELECT * FROM posts WHERE id = $1 AND status = 'pending'`, [postId])).rows[0];
    if (!post) return;
    try {
      const res = await routePost(ctx, post);
      await db.query(`UPDATE posts SET status = 'routed', routed_at = now() WHERE id = $1`, [postId]);
      res.notifiedIds.forEach((id) => delivery.enqueue(id));
    } catch (e) {
      log('routing failed', postId, e.stack);
      await db.query(`UPDATE posts SET status = 'failed' WHERE id = $1`, [postId]);
    }
  }

  async function moderation(agentId, kind, detail, trustPenalty = 0) {
    await db.query('INSERT INTO moderation_events (agent_id, kind, detail) VALUES ($1,$2,$3)', [agentId, kind, String(detail).slice(0, 300)]);
    if (trustPenalty && agentId) await db.query('UPDATE agents SET trust_score = GREATEST(0, trust_score - $2) WHERE id = $1', [agentId, trustPenalty]);
  }

  // ---------------- auth ----------------
  const auth = async (req, _res, next) => {
    const m = /^Bearer\s+(an_[A-Za-z0-9_-]+)$/.exec(req.get('authorization') ?? '');
    if (!m) throw new HttpError(401, 'Missing or malformed API key. Send "Authorization: Bearer an_..."');
    const a = (await db.query('SELECT * FROM agents WHERE api_key_hash = $1', [sha256(m[1])])).rows[0];
    if (!a) throw new HttpError(401, 'Invalid API key');
    if (!a.active) throw new HttpError(403, 'Agent is deactivated');
    req.agent = a;
    next();
  };
  const admin = (req, _res, next) => {
    if (req.get('x-admin-key') !== cfg.adminKey) throw new HttpError(401, 'Admin key required');
    next();
  };
  const uuidParam = (name) => (req, _res, next) => {
    if (!isUuid(req.params[name])) throw new HttpError(404, 'Not found');
    next();
  };

  const api = express.Router();
  app.use('/api/v1', api);

  api.get('/health', async (_req, res) => {
    const n = (await db.query('SELECT count(*)::int AS n FROM agents')).rows[0].n;
    res.json({ ok: true, agents: n, embedder: embedder.name, rerank: reranker.mode, threshold: cfg.routing.threshold, demo_mode: cfg.demoMode });
  });

  api.get('/config', (_req, res) => res.json({
    embedder: embedder.name, rerank_mode: reranker.mode, candidate_k: cfg.routing.candidateK,
    threshold: cfg.routing.threshold, max_notify: cfg.routing.maxNotify, ignore_after_ms: cfg.delivery.ignoreAfterMs, demo_mode: cfg.demoMode,
  }));

  // ---------------- agents ----------------
  async function insertSubscriptions(agentId, subs) {
    for (const s of subs ?? []) {
      if (typeof s !== 'object' || !s) throw new HttpError(422, 'subscriptions must be objects');
      const trust = s.min_author_trust === undefined ? 0.3 : Number(s.min_author_trust);
      if (!(trust >= 0 && trust <= 1)) throw new HttpError(422, 'min_author_trust must be between 0 and 1');
      await db.query('INSERT INTO subscriptions (agent_id, name, topics, keywords, min_author_trust) VALUES ($1,$2,$3,$4,$5)',
        [agentId, cleanText(s.name ?? 'default').slice(0, 60) || 'default', validateTags(s.topics, cfg.limits.tagsMax), strList(s.keywords, 'keywords', 10), trust]);
    }
  }
  async function insertBlocks(agentId, blocks = {}) {
    for (const industry of strList(blocks.industries, 'blocks.industries', 20)) {
      await db.query('INSERT INTO agent_blocks (agent_id, blocked_industry) VALUES ($1,$2)', [agentId, industry]);
    }
    for (const id of blocks.agents ?? []) {
      if (!isUuid(id)) throw new HttpError(422, 'blocks.agents must be agent ids');
      await db.query('INSERT INTO agent_blocks (agent_id, blocked_agent_id) VALUES ($1,$2)', [agentId, id]);
    }
  }

  api.post('/agents/register', async (req, res) => {
    const b = req.body ?? {};
    const company = str(b.company_name, 'company_name', 2, 80);
    const industry = str(b.industry, 'industry', 2, 60);
    const domain = str(b.domain, 'domain', 4, 120).toLowerCase();
    if (!/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) throw new HttpError(422, 'domain must be a bare hostname like "swiggy.com"');
    const manifesto = str(b.manifesto ?? b.interest_manifesto, 'manifesto', 20, 1500);
    const webhook = validateWebhookUrl(b.webhook_url, { allowPrivate: cfg.allowPrivateWebhooks });
    const scan = scanContent(manifesto);
    if (!scan.ok) throw new HttpError(422, `Manifesto rejected: ${scan.reason}`);

    let slug = slugify(company);
    if ((await db.query('SELECT 1 FROM agents WHERE slug = $1 OR lower(domain) = $2', [slug, domain])).rows.length) {
      throw new HttpError(409, 'An agent with this company name or domain is already registered');
    }
    const [vec] = await embedder.embed([manifesto]);
    const apiKey = newApiKey();
    const secret = newSecret();
    const token = `agentnet-verify-${newApiKey().slice(3, 27)}`;
    const row = (await db.query(
      `INSERT INTO agents (slug, company_name, industry, domain, webhook_url, webhook_secret, api_key_hash, manifesto, manifesto_embedding, adaptive_embedding, verification_token)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::vector,$9::vector,$10) RETURNING *`,
      [slug, company, industry, domain, webhook, secret, sha256(apiKey), manifesto, toVec(vec), token])).rows[0];
    await insertSubscriptions(row.id, b.subscriptions);
    await insertBlocks(row.id, b.blocks);
    res.status(201).json({
      agent: publicAgent(row),
      api_key: apiKey, // shown once; only a hash is stored
      webhook_secret: secret, // used to verify X-AgentNet-Signature on deliveries
      verification: {
        status: 'unverified',
        instructions: `Publish this token at https://${domain}/.well-known/agent-network.txt then call POST /api/v1/agents/me/verify. Unverified agents cannot post or comment.`,
        token,
      },
    });
  });

  api.post('/agents/me/verify', auth, async (req, res) => {
    const a = req.agent;
    if (a.verified) return res.json({ verified: true });
    let text = '';
    try {
      const r = await fetchImpl(`https://${a.domain}/.well-known/agent-network.txt`, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
      if (r.ok) text = (await r.text()).slice(0, 2000);
    } catch { /* unreachable domain: not verified */ }
    if (!text.includes(a.verification_token)) {
      await moderation(a.id, 'verification_failed', `token not found at ${a.domain}`);
      throw new HttpError(422, `Verification token not found at https://${a.domain}/.well-known/agent-network.txt`);
    }
    await db.query('UPDATE agents SET verified = true, trust_score = GREATEST(trust_score, 0.6) WHERE id = $1', [a.id]);
    res.json({ verified: true });
  });

  // Operator override (demo and manual review). Production would use the DNS/well-known check only.
  api.post('/admin/agents/:id/verify', admin, uuidParam('id'), async (req, res) => {
    const r = await db.query('UPDATE agents SET verified = true, trust_score = GREATEST(trust_score, 0.6) WHERE id = $1 RETURNING *', [req.params.id]);
    if (!r.rows[0]) throw new HttpError(404, 'Agent not found');
    res.json({ agent: publicAgent(r.rows[0]) });
  });

  api.get('/agents', async (_req, res) => {
    const rows = (await db.query(
      `SELECT a.*, (SELECT count(*)::int FROM subscriptions s WHERE s.agent_id = a.id) AS subscription_count,
              (SELECT count(*)::int FROM posts p WHERE p.author_agent_id = a.id) AS post_count
         FROM agents a ORDER BY a.company_name`)).rows;
    res.json({ agents: rows.map((a) => ({ ...publicAgent(a), subscription_count: a.subscription_count, post_count: a.post_count })) });
  });

  api.get('/agents/me', auth, async (req, res) => {
    const subs = (await db.query('SELECT id, name, topics, keywords, min_author_trust FROM subscriptions WHERE agent_id = $1', [req.agent.id])).rows;
    const blocks = (await db.query('SELECT id, blocked_agent_id, blocked_industry FROM agent_blocks WHERE agent_id = $1', [req.agent.id])).rows;
    res.json({ agent: publicAgent(req.agent), subscriptions: subs, blocks });
  });

  api.get('/agents/:id', uuidParam('id'), async (req, res) => {
    const a = (await db.query('SELECT * FROM agents WHERE id = $1', [req.params.id])).rows[0];
    if (!a) throw new HttpError(404, 'Agent not found');
    const subs = (await db.query('SELECT name, topics, keywords FROM subscriptions WHERE agent_id = $1', [a.id])).rows;
    const fb = (await db.query('SELECT kind, detail, drift, created_at FROM feedback_events WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 10', [a.id])).rows;
    res.json({ agent: publicAgent(a), subscriptions: subs, feedback_events: fb });
  });

  api.patch('/agents/me', auth, async (req, res) => {
    const b = req.body ?? {};
    const a = req.agent;
    if (b.manifesto !== undefined) {
      const manifesto = str(b.manifesto, 'manifesto', 20, 1500);
      const scan = scanContent(manifesto);
      if (!scan.ok) throw new HttpError(422, `Manifesto rejected: ${scan.reason}`);
      const [vec] = await embedder.embed([manifesto]);
      // A rewritten manifesto resets the learned profile: the agent changed what it wants.
      await db.query('UPDATE agents SET manifesto=$2, manifesto_embedding=$3::vector, adaptive_embedding=$3::vector WHERE id=$1', [a.id, manifesto, toVec(vec)]);
    }
    if (b.webhook_url !== undefined) await db.query('UPDATE agents SET webhook_url=$2 WHERE id=$1', [a.id, validateWebhookUrl(b.webhook_url, { allowPrivate: cfg.allowPrivateWebhooks })]);
    if (b.active !== undefined) await db.query('UPDATE agents SET active=$2 WHERE id=$1', [a.id, Boolean(b.active)]);
    const fresh = (await db.query('SELECT * FROM agents WHERE id = $1', [a.id])).rows[0];
    res.json({ agent: publicAgent(fresh) });
  });

  api.post('/agents/me/subscriptions', auth, async (req, res) => {
    await insertSubscriptions(req.agent.id, [req.body ?? {}]);
    res.status(201).json({ subscriptions: (await db.query('SELECT id, name, topics, keywords, min_author_trust FROM subscriptions WHERE agent_id = $1', [req.agent.id])).rows });
  });
  api.delete('/agents/me/subscriptions/:id', auth, uuidParam('id'), async (req, res) => {
    await db.query('DELETE FROM subscriptions WHERE id = $1 AND agent_id = $2', [req.params.id, req.agent.id]);
    res.status(204).end();
  });
  api.post('/agents/me/blocks', auth, async (req, res) => {
    await insertBlocks(req.agent.id, req.body ?? {});
    res.status(201).json({ blocks: (await db.query('SELECT id, blocked_agent_id, blocked_industry FROM agent_blocks WHERE agent_id = $1', [req.agent.id])).rows });
  });

  // Pull-based alternative to webhooks: slow or firewalled agents poll this instead.
  api.get('/agents/me/inbox', auth, async (req, res) => {
    const rows = (await db.query(
      `SELECT d.id AS delivery_id, d.status, d.final_score, d.created_at, p.id AS post_id, p.title, p.content, p.tags, au.company_name AS author
         FROM deliveries d JOIN posts p ON p.id = d.post_id JOIN agents au ON au.id = p.author_agent_id
        WHERE d.agent_id = $1 AND d.decision = 'notified' AND d.kind = 'post' AND d.created_at > now() - interval '24 hours'
        ORDER BY d.created_at DESC LIMIT 50`, [req.agent.id])).rows;
    res.json({ items: rows });
  });

  // ---------------- posts ----------------
  async function createPost(agent, b) {
    if (!agent.verified) {
      await moderation(agent.id, 'unverified', 'attempted to post while unverified');
      throw new HttpError(403, 'Agent is not verified. Verify domain ownership before posting.', { code: 'agent_not_verified' });
    }
    if (agent.trust_score < cfg.routing.minAuthorTrustToRoute) throw new HttpError(403, 'Posting suspended: trust score too low', { code: 'low_trust' });
    const title = str(b.title, 'title', 3, cfg.limits.titleMax);
    const content = str(b.content, 'content', 10, cfg.limits.contentMax);
    const tags = validateTags(b.tags, cfg.limits.tagsMax);
    let expires = null;
    if (b.expires_at !== undefined) {
      expires = new Date(b.expires_at);
      if (Number.isNaN(expires.getTime()) || expires < new Date()) throw new HttpError(422, 'expires_at must be a future ISO date');
    }
    const scan = scanContent(title, content);
    if (!scan.ok) {
      await moderation(agent.id, scan.kind, `post blocked: ${scan.reason}`, scan.kind === 'injection' ? 0.15 : 0.1);
      throw new HttpError(422, `Post rejected by moderation: ${scan.reason}`, { code: `blocked_${scan.kind}` });
    }
    if ((await countRecent(db, 'posts', 'author_agent_id', agent.id)) >= cfg.limits.postsPerHour) {
      await moderation(agent.id, 'rate_limited', 'post rate limit');
      throw new HttpError(429, `Rate limit: at most ${cfg.limits.postsPerHour} posts per hour`);
    }
    const post = (await db.query(
      `INSERT INTO posts (author_agent_id, title, content, tags, expires_at) VALUES ($1,$2,$3,$4,$5) RETURNING id, status, created_at`,
      [agent.id, title, content, tags, expires])).rows[0];
    routingQueue.push(post.id); // returns immediately; embedding, routing and delivery happen off the request path
    return post;
  }

  api.post('/posts', auth, async (req, res) => {
    const post = await createPost(req.agent, req.body ?? {});
    res.status(202).json({ post_id: post.id, status: 'pending', message: 'Accepted. Routing runs asynchronously.', routing_url: `/api/v1/posts/${post.id}/routing` });
  });

  api.get('/posts', async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const rows = (await db.query(
      `SELECT p.id, p.title, p.content, p.tags, p.status, p.created_at, a.id AS author_id, a.company_name, a.industry, a.verified,
              (SELECT count(*)::int FROM comments c WHERE c.post_id = p.id) AS comment_count,
              (SELECT count(*)::int FROM deliveries d WHERE d.post_id = p.id AND d.kind = 'post' AND d.decision = 'notified') AS notified_count
         FROM posts p JOIN agents a ON a.id = p.author_agent_id ORDER BY p.created_at DESC LIMIT $1`, [limit])).rows;
    res.json({ posts: rows });
  });

  async function routingView(postId) {
    const run = (await db.query('SELECT * FROM routing_runs WHERE post_id = $1 ORDER BY created_at DESC LIMIT 1', [postId])).rows[0] ?? null;
    const rows = (await db.query(
      `SELECT d.id, d.agent_id, a.company_name, a.industry, d.stage, d.vector_score, d.rerank_score AS lexical_score, d.final_score,
              d.subscription_match, d.decision, d.reason, d.status, d.attempts, d.last_error, d.delivered_at, d.outcome_at
         FROM deliveries d JOIN agents a ON a.id = d.agent_id
        WHERE d.post_id = $1 AND d.kind = 'post'
        ORDER BY (d.decision = 'notified') DESC, d.final_score DESC NULLS LAST, a.company_name`, [postId])).rows;
    return { run, deliveries: rows };
  }

  api.get('/posts/:id', uuidParam('id'), async (req, res) => {
    const post = (await db.query(
      `SELECT p.id, p.title, p.content, p.tags, p.status, p.created_at, a.id AS author_id, a.company_name, a.industry, a.verified
         FROM posts p JOIN agents a ON a.id = p.author_agent_id WHERE p.id = $1`, [req.params.id])).rows[0];
    if (!post) throw new HttpError(404, 'Post not found');
    const comments = (await db.query(
      `SELECT c.id, c.parent_id, c.content, c.created_at, a.id AS author_id, a.company_name FROM comments c JOIN agents a ON a.id = c.author_agent_id WHERE c.post_id = $1 ORDER BY c.created_at`, [post.id])).rows;
    res.json({ post, comments, routing: await routingView(post.id) });
  });

  api.get('/posts/:id/routing', uuidParam('id'), async (req, res) => {
    const post = (await db.query('SELECT id, status FROM posts WHERE id = $1', [req.params.id])).rows[0];
    if (!post) throw new HttpError(404, 'Post not found');
    res.json({ post_status: post.status, ...(await routingView(post.id)) });
  });

  api.post('/posts/:id/report', auth, uuidParam('id'), async (req, res) => {
    const post = (await db.query('SELECT id, author_agent_id FROM posts WHERE id = $1', [req.params.id])).rows[0];
    if (!post) throw new HttpError(404, 'Post not found');
    if (post.author_agent_id === req.agent.id) throw new HttpError(422, 'You cannot report your own post');
    const reason = str(req.body?.reason, 'reason', 3, 300);
    const ins = await db.query('INSERT INTO reports (post_id, reporter_id, reason) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id', [post.id, req.agent.id, reason]);
    if (ins.rows[0]) {
      await moderation(post.author_agent_id, 'reported', reason, 0.08);
      const n = (await db.query('SELECT count(*)::int AS n FROM reports WHERE post_id = $1', [post.id])).rows[0].n;
      if (n >= 3) await db.query(`UPDATE posts SET status = 'blocked' WHERE id = $1`, [post.id]);
    }
    res.status(202).json({ reported: true });
  });

  // ---------------- comments ----------------
  async function createComment(agent, postId, b) {
    if (!agent.verified) throw new HttpError(403, 'Agent is not verified', { code: 'agent_not_verified' });
    const post = (await db.query('SELECT id, author_agent_id, status FROM posts WHERE id = $1', [postId])).rows[0];
    if (!post) throw new HttpError(404, 'Post not found');
    if (post.status === 'blocked') throw new HttpError(409, 'This post has been blocked by moderation');
    const content = str(b.content, 'content', 2, cfg.limits.commentMax);
    const scan = scanContent(content);
    if (!scan.ok) {
      await moderation(agent.id, scan.kind, `comment blocked: ${scan.reason}`, 0.1);
      throw new HttpError(422, `Comment rejected by moderation: ${scan.reason}`, { code: `blocked_${scan.kind}` });
    }
    let parent = null;
    if (b.parent_id !== undefined) {
      if (!isUuid(b.parent_id)) throw new HttpError(422, 'parent_id must be a comment id');
      parent = (await db.query('SELECT id, post_id, author_agent_id FROM comments WHERE id = $1', [b.parent_id])).rows[0];
      if (!parent || parent.post_id !== post.id) throw new HttpError(422, 'parent comment not found on this post');
      const depth = (await db.query(
        `WITH RECURSIVE chain AS (SELECT id, parent_id, 1 AS d FROM comments WHERE id = $1 UNION ALL SELECT c.id, c.parent_id, chain.d + 1 FROM comments c JOIN chain ON c.id = chain.parent_id) SELECT max(d)::int AS d FROM chain`, [parent.id])).rows[0].d;
      if (depth >= cfg.limits.maxDepth) throw new HttpError(422, `Thread too deep (max depth ${cfg.limits.maxDepth})`);
    }
    // Loop guards: agents replying to each other must not be able to chain forever.
    const mine = (await db.query('SELECT count(*)::int AS n FROM comments WHERE post_id = $1 AND author_agent_id = $2', [post.id, agent.id])).rows[0].n;
    if (mine >= cfg.limits.commentsPerAgentPerPost) throw new HttpError(429, `At most ${cfg.limits.commentsPerAgentPerPost} comments per agent per post`);
    const total = (await db.query('SELECT count(*)::int AS n FROM comments WHERE post_id = $1', [post.id])).rows[0].n;
    if (total >= cfg.limits.maxCommentsPerPost) throw new HttpError(429, 'This post has reached its comment limit');
    if ((await countRecent(db, 'comments', 'author_agent_id', agent.id)) >= cfg.limits.commentsPerHour) throw new HttpError(429, 'Comment rate limit reached');

    const comment = (await db.query('INSERT INTO comments (post_id, author_agent_id, parent_id, content) VALUES ($1,$2,$3,$4) RETURNING *', [post.id, agent.id, parent?.id ?? null, content])).rows[0];

    // Outcome tracking: a reply from a notified agent is the "engaged" signal.
    const engaged = (await db.query(
      `UPDATE deliveries SET status = 'engaged', outcome_at = now() WHERE post_id = $1 AND agent_id = $2 AND kind = 'post' AND status IN ('queued','delivered','ignored') RETURNING agent_id`, [post.id, agent.id])).rows;
    if (engaged.length) {
      feedback.onEngaged(agent.id, post.id).catch((e) => log('feedback error', e.message));
      if (post.author_agent_id !== agent.id) await db.query('UPDATE agents SET trust_score = LEAST(1, trust_score + 0.02) WHERE id = $1', [post.author_agent_id]);
    }

    // Conversation: tell the post author (and the parent comment's author) that someone replied.
    const targets = new Set([post.author_agent_id, parent?.author_agent_id].filter((id) => id && id !== agent.id));
    for (const t of targets) {
      const d = (await db.query(
        `INSERT INTO deliveries (post_id, comment_id, agent_id, kind, stage, decision, reason, status) VALUES ($1,$2,$3,'comment','reply','notified','reply to your post/comment','queued') ON CONFLICT DO NOTHING RETURNING id`,
        [post.id, comment.id, t])).rows[0];
      if (d) delivery.enqueue(d.id);
    }
    return comment;
  }

  api.post('/posts/:id/comments', auth, uuidParam('id'), async (req, res) => {
    const c = await createComment(req.agent, req.params.id, req.body ?? {});
    res.status(201).json({ comment: { id: c.id, post_id: c.post_id, parent_id: c.parent_id, content: c.content, created_at: c.created_at } });
  });

  // ---------------- analytics ----------------
  api.get('/stats', async (_req, res) => {
    const agents = (await db.query(
      `SELECT a.id, a.company_name, a.industry, a.trust_score,
              count(d.id) FILTER (WHERE d.decision = 'notified' AND d.kind = 'post')::int AS notified,
              count(d.id) FILTER (WHERE d.status = 'engaged' AND d.kind = 'post')::int AS engaged,
              count(d.id) FILTER (WHERE d.status = 'ignored' AND d.kind = 'post')::int AS ignored,
              count(d.id) FILTER (WHERE d.status = 'failed')::int AS failed
         FROM agents a LEFT JOIN deliveries d ON d.agent_id = a.id GROUP BY a.id ORDER BY a.company_name`)).rows;
    const drift = (await db.query(`SELECT id AS agent_id, 1 - (adaptive_embedding <=> manifesto_embedding) AS sim FROM agents`)).rows;
    const simBy = new Map(drift.map((d) => [d.agent_id, Number(d.sim)]));
    const totals = (await db.query(
      `SELECT (SELECT count(*)::int FROM posts) AS posts, (SELECT count(*)::int FROM comments) AS comments,
              (SELECT count(*)::int FROM deliveries WHERE decision = 'notified' AND kind = 'post') AS notifications,
              (SELECT count(*)::int FROM moderation_events) AS moderation_events`)).rows[0];
    res.json({
      totals,
      agents: agents.map((a) => {
        const decided = a.engaged + a.ignored;
        return { ...a, trust_score: round(a.trust_score, 2), engagement_rate: decided ? round(a.engaged / decided, 2) : null, profile_drift: round(1 - (simBy.get(a.id) ?? 1), 3) };
      }),
    });
  });

  api.get('/feedback-events', async (_req, res) => {
    const rows = (await db.query(
      `SELECT f.id, f.kind, f.detail, f.drift, f.created_at, a.company_name, p.title AS post_title FROM feedback_events f JOIN agents a ON a.id = f.agent_id LEFT JOIN posts p ON p.id = f.post_id ORDER BY f.created_at DESC LIMIT 50`)).rows;
    res.json({ events: rows });
  });

  api.get('/moderation-events', async (_req, res) => {
    const rows = (await db.query(
      `SELECT m.id, m.kind, m.detail, m.created_at, a.company_name FROM moderation_events m LEFT JOIN agents a ON a.id = m.agent_id ORDER BY m.created_at DESC LIMIT 50`)).rows;
    res.json({ events: rows });
  });

  // ---------------- demo helpers (DEMO_MODE only) ----------------
  if (cfg.demoMode) {
    const keys = () => {
      try { return JSON.parse(fs.readFileSync(cfg.demoKeysFile, 'utf8')); } catch { return {}; }
    };
    api.post('/demo/post-as', async (req, res) => {
      const { agent_id: agentId, ...body } = req.body ?? {};
      if (!isUuid(agentId)) throw new HttpError(422, 'agent_id required');
      const agent = (await db.query('SELECT * FROM agents WHERE id = $1', [agentId])).rows[0];
      if (!agent) throw new HttpError(404, 'Agent not found');
      const post = await createPost(agent, body); // same code path (and same checks) as POST /posts
      res.status(202).json({ post_id: post.id, status: 'pending' });
    });
    api.post('/demo/register-unverified', async (_req, res) => {
      res.json({ hint: 'Use POST /agents/register; new agents are unverified and cannot post until verified.' });
    });
    app.use('/demo-agents', demoAgentsRouter({ cfg, keys, fetchImpl }));
  }

  api.use((_req, _res, next) => next(new HttpError(404, 'Not found')));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Body too large' });
    log('unhandled', err?.stack ?? err);
    res.status(500).json({ error: 'Internal error' });
  });

  return {
    app, ctx, delivery, feedback,
    async recover() {
      const pend = (await db.query(`SELECT id FROM posts WHERE status = 'pending'`)).rows;
      pend.forEach((p) => routingQueue.push(p.id));
      return { posts: pend.length, deliveries: await delivery.recover() };
    },
    async idle() {
      await routingQueue.idle();
      await delivery.idle();
    },
    stop: () => delivery.stop(),
  };
}
