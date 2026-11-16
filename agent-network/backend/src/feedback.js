import { toVec, fromVec, normalize, cosine, round } from './util.js';

const SIMILAR = 0.55; 
const MAX_DRIFT = 0.6; 
export function createFeedback({ db, cfg }) {
  async function load(agentId, postId) {
    const a = (await db.query('SELECT manifesto_embedding::text AS m, adaptive_embedding::text AS a FROM agents WHERE id = $1', [agentId])).rows[0];
    const p = (await db.query('SELECT embedding::text AS e FROM posts WHERE id = $1', [postId])).rows[0];
    if (!a || !p?.e) return null;
    return { manifesto: fromVec(a.m), adaptive: fromVec(a.a), post: fromVec(p.e) };
  }

  async function save(agentId, postId, kind, detail, { manifesto, adaptive }) {
    let next = adaptive;
    if (1 - cosine(next, manifesto) > MAX_DRIFT) next = normalize(next.map((x, i) => x + 0.5 * manifesto[i])); // pull back toward what the agent declared
    await db.query('UPDATE agents SET adaptive_embedding = $2::vector WHERE id = $1', [agentId, toVec(next)]);
    const drift = round(1 - cosine(next, manifesto), 4);
    await db.query('INSERT INTO feedback_events (agent_id, post_id, kind, detail, drift) VALUES ($1,$2,$3,$4,$5)', [agentId, postId, kind, detail, drift]);
    return drift;
  }

  return {
    async onEngaged(agentId, postId) {
      const s = await load(agentId, postId);
      if (!s) return;
      const next = normalize(s.adaptive.map((x, i) => x + cfg.feedback.alpha * s.post[i]));
      await save(agentId, postId, 'boost', 'engaged: profile pulled toward this topic', { ...s, adaptive: next });
    },

    async onIgnored(agentId, postId) {
      const s = await load(agentId, postId);
      if (!s) return;
      const since = (await db.query(`SELECT coalesce(max(created_at), 'epoch'::timestamptz) AS t FROM feedback_events WHERE agent_id = $1 AND kind = 'suppress'`, [agentId])).rows[0].t;
      const recent = (await db.query(
        `SELECT d.status, 1 - (p.embedding <=> $2::vector) AS sim
           FROM deliveries d JOIN posts p ON p.id = d.post_id
          WHERE d.agent_id = $1 AND d.kind = 'post' AND d.status IN ('ignored','engaged') AND p.embedding IS NOT NULL
            AND d.created_at > $4
          ORDER BY d.created_at DESC LIMIT $3`,
        [agentId, toVec(s.post), cfg.feedback.window, since],
      )).rows.filter((r) => Number(r.sim) >= SIMILAR);
      const ignored = recent.filter((r) => r.status === 'ignored').length;
      const engaged = recent.filter((r) => r.status === 'engaged').length;
      if (ignored < cfg.feedback.minIgnored || engaged > 0) return; // not a pattern yet, or the agent does engage with this topic
      const next = normalize(s.adaptive.map((x, i) => x - cfg.feedback.beta * s.post[i]));
      await save(agentId, postId, 'suppress', `ignored ${ignored} similar posts with no engagement: profile pushed away from this topic`, { ...s, adaptive: next });
    },
  };
}
