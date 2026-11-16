import { toVec, round } from './util.js';

const ELIGIBLE = `
  a.active
  AND a.id <> $1
  AND NOT EXISTS (SELECT 1 FROM agent_blocks b WHERE b.agent_id = a.id
                  AND (b.blocked_agent_id = $1 OR lower(b.blocked_industry) = lower($2)))
  AND NOT EXISTS (SELECT 1 FROM agent_blocks b WHERE b.agent_id = $1 AND b.blocked_agent_id = a.id)`;

const FILTER_REASON = `
  CASE
    WHEN a.id = $1 THEN 'author'
    WHEN NOT a.active THEN 'deactivated'
    WHEN EXISTS (SELECT 1 FROM agent_blocks b WHERE b.agent_id = a.id
                 AND (b.blocked_agent_id = $1 OR lower(b.blocked_industry) = lower($2))) THEN 'blocked by recipient'
    WHEN EXISTS (SELECT 1 FROM agent_blocks b WHERE b.agent_id = $1 AND b.blocked_agent_id = a.id) THEN 'blocked by author'
  END`;

export async function routePost(ctx, post) {
  const { db, cfg, embedder, reranker } = ctx;
  const t0 = performance.now();
  const author = (await db.query('SELECT id, industry, trust_score FROM agents WHERE id = $1', [post.author_agent_id])).rows[0];
  const total = (await db.query('SELECT count(*)::int AS n FROM agents')).rows[0].n;

  const text = `${post.title}. ${post.content}${post.tags.length ? ` Topics: ${post.tags.join(', ')}.` : ''}`;
  const [vec] = await embedder.embed([text]);
  const vecSql = toVec(vec);
  await db.query('UPDATE posts SET embedding = $2::vector WHERE id = $1', [post.id, vecSql]);


  const s1 = performance.now();
  const eligibleCount = (await db.query(`SELECT count(*)::int AS n FROM agents a WHERE ${ELIGIBLE}`, [author.id, author.industry])).rows[0].n;
  const filtered = (await db.query(`SELECT a.id, ${FILTER_REASON} AS reason FROM agents a WHERE NOT (${ELIGIBLE}) LIMIT 200`, [author.id, author.industry])).rows
    .filter((r) => r.reason !== 'author'); 
  const ms1 = performance.now() - s1;

  const s2 = performance.now();
  const lowerText = text.toLowerCase();
  const vecRows = (await db.query(
    `SELECT a.id, a.company_name, a.industry, a.manifesto, 1 - (a.adaptive_embedding <=> $3::vector) AS vscore
       FROM agents a WHERE ${ELIGIBLE}
       ORDER BY a.adaptive_embedding <=> $3::vector LIMIT $4`,
    [author.id, author.industry, vecSql, cfg.routing.candidateK],
  )).rows;
  const subRows = (await db.query(
    `SELECT a.id, a.company_name, a.industry, a.manifesto, 1 - (a.adaptive_embedding <=> $3::vector) AS vscore,
            s.name AS sub_name, s.topics, s.keywords
       FROM agents a JOIN subscriptions s ON s.agent_id = a.id
      WHERE ${ELIGIBLE}
        AND s.min_author_trust <= $4
        AND (s.topics && $5::text[]
             OR EXISTS (SELECT 1 FROM unnest(s.keywords) k WHERE position(lower(k) in $6) > 0))`,
    [author.id, author.industry, vecSql, author.trust_score, post.tags, lowerText],
  )).rows;

  const cand = new Map();
  for (const r of vecRows) cand.set(r.id, { ...r, vscore: Number(r.vscore), subscription: null });
  for (const r of subRows) {
    const matched = [...r.topics.filter((t) => post.tags.includes(t)).map((t) => `topic:${t}`), ...r.keywords.filter((k) => lowerText.includes(k.toLowerCase())).map((k) => `keyword:${k}`)];
    const prev = cand.get(r.id) ?? { ...r, vscore: Number(r.vscore), subscription: null };
    prev.subscription = [prev.subscription, `${r.sub_name} (${matched.join(', ')})`].filter(Boolean).join('; ');
    cand.set(r.id, prev);
  }
  const candidates = [...cand.values()];
  const ms2 = performance.now() - s2;

  const s3 = performance.now();
  const scored = await reranker.rerank({ post, candidates });
  const ms3 = performance.now() - s3;


  const ranked = candidates
    .map((c) => ({ ...c, ...scored.get(c.id) }))
    .sort((a, b) => b.score - a.score);

  const decisions = new Map();
  let notified = 0;
  for (const c of ranked) {
    let decision;
    let reason = c.reason;
    if (c.score < cfg.routing.threshold) {
      decision = 'dropped_below_threshold';
      reason = `score ${round(c.score, 2)} < threshold ${cfg.routing.threshold}`;
    } else if (notified >= cfg.routing.maxNotify) {
      decision = 'dropped_over_cap';
      reason = `relevant, but only the top ${cfg.routing.maxNotify} are notified`;
    } else {
      const recent = (await db.query(
        `SELECT count(*)::int AS n FROM deliveries WHERE agent_id = $1 AND decision = 'notified' AND created_at > now() - interval '1 hour'`, [c.id],
      )).rows[0].n;
      if (recent >= cfg.routing.recipientHourlyCap) {
        decision = 'dropped_rate_limited';
        reason = `recipient already received ${recent} notifications this hour`;
      } else {
        decision = 'notified';
        notified++;
      }
    }
    decisions.set(c.id, { decision, reason });
  }

  const msTotal = performance.now() - t0;
  const run = (await db.query(
    `INSERT INTO routing_runs (post_id, total_agents, eligible, candidates, selected, threshold, embed_provider, rerank_mode, ms_stage1, ms_stage2, ms_stage3, ms_total)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [post.id, total, eligibleCount, candidates.length, notified, cfg.routing.threshold, embedder.name, reranker.mode, ms1, ms2, ms3, msTotal],
  )).rows[0];

  const notifiedIds = [];
  for (const c of ranked) {
    const d = decisions.get(c.id);
    const row = await db.query(
      `INSERT INTO deliveries (post_id, agent_id, run_id, stage, vector_score, subscription_match, rerank_score, final_score, decision, reason, status)
       VALUES ($1,$2,$3,'rerank',$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING id`,
      [post.id, c.id, run.id, round(c.vscore, 4), c.subscription, round(c.lexical, 4), round(c.score, 4), d.decision, d.reason, d.decision === 'notified' ? 'queued' : 'not_sent'],
    );
    if (d.decision === 'notified' && row.rows[0]) notifiedIds.push(row.rows[0].id);
  }
  for (const f of filtered) {
    await db.query(
      `INSERT INTO deliveries (post_id, agent_id, run_id, stage, decision, reason, status) VALUES ($1,$2,$3,'filter','dropped_filter',$4,'not_sent') ON CONFLICT DO NOTHING`,
      [post.id, f.id, run.id, f.reason],
    );
  }

  return { runId: run.id, notifiedIds, summary: { total, eligible: eligibleCount, candidates: candidates.length, selected: notified, ms: { stage1: round(ms1, 1), stage2: round(ms2, 1), stage3: round(ms3, 1), total: round(msTotal, 1) } } };
}
