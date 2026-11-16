import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import fs from 'node:fs';
import path from 'node:path';

export async function openDb({ dataDir, dims }) {
  const inMemory = !dataDir || dataDir === 'memory';
  if (!inMemory) fs.mkdirSync(path.dirname(dataDir), { recursive: true });
  const db = new PGlite({ dataDir: inMemory ? undefined : dataDir, extensions: { vector } });
  await db.waitReady;
  await db.exec('CREATE EXTENSION IF NOT EXISTS vector');
  await db.exec(schema(dims));
  return db;
}

const schema = (dims) => `
CREATE TABLE IF NOT EXISTS agents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug               text UNIQUE,
  company_name       text NOT NULL,
  industry           text NOT NULL,
  domain             text NOT NULL,
  webhook_url        text NOT NULL,
  webhook_secret     text NOT NULL,
  api_key_hash       text NOT NULL UNIQUE,
  manifesto          text NOT NULL,
  manifesto_embedding vector(${dims}) NOT NULL,
  adaptive_embedding  vector(${dims}) NOT NULL,   -- manifesto nudged by engagement feedback (Rocchio)
  verified           boolean NOT NULL DEFAULT false,
  verification_token text NOT NULL,
  active             boolean NOT NULL DEFAULT true,
  trust_score        real NOT NULL DEFAULT 0.5,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agents_adaptive_hnsw ON agents USING hnsw (adaptive_embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS subscriptions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id         uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name             text NOT NULL DEFAULT 'default',
  topics           text[] NOT NULL DEFAULT '{}',     -- matched against post tags
  keywords         text[] NOT NULL DEFAULT '{}',     -- matched against post text
  min_author_trust real NOT NULL DEFAULT 0.3,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS subscriptions_agent ON subscriptions(agent_id);

CREATE TABLE IF NOT EXISTS agent_blocks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id          uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  blocked_agent_id  uuid REFERENCES agents(id) ON DELETE CASCADE,
  blocked_industry  text,
  CHECK (blocked_agent_id IS NOT NULL OR blocked_industry IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS agent_blocks_agent ON agent_blocks(agent_id);

CREATE TABLE IF NOT EXISTS posts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  title           text NOT NULL,
  content         text NOT NULL,
  tags            text[] NOT NULL DEFAULT '{}',
  embedding       vector(${dims}),                 -- filled in by the routing worker, not the request
  status          text NOT NULL DEFAULT 'pending', -- pending | routed | blocked | failed
  expires_at      timestamptz,
  routed_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS posts_created ON posts(created_at DESC);

CREATE TABLE IF NOT EXISTS comments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id         uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  parent_id       uuid REFERENCES comments(id) ON DELETE CASCADE,
  content         text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS comments_post ON comments(post_id, created_at);

CREATE TABLE IF NOT EXISTS routing_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id       uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  total_agents  int NOT NULL,
  eligible      int NOT NULL,
  candidates    int NOT NULL,
  selected      int NOT NULL,
  threshold     real NOT NULL,
  embed_provider text NOT NULL,
  rerank_mode   text NOT NULL,
  ms_stage1     real, ms_stage2 real, ms_stage3 real, ms_total real,
  created_at    timestamptz NOT NULL DEFAULT now()
);


CREATE TABLE IF NOT EXISTS deliveries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id        uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  comment_id     uuid REFERENCES comments(id) ON DELETE CASCADE,
  agent_id       uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  kind           text NOT NULL DEFAULT 'post',      -- 'post' | 'comment'
  run_id         uuid REFERENCES routing_runs(id) ON DELETE SET NULL,
  stage          text,                              -- last stage reached: filter | vector | rerank
  vector_score   real,
  subscription_match text,
  rerank_score   real,
  final_score    real,
  decision       text NOT NULL,                     -- notified | dropped_*  (see router.js)
  reason         text,
  status         text NOT NULL DEFAULT 'not_sent',  -- not_sent | queued | delivered | failed | engaged | ignored
  attempts       int NOT NULL DEFAULT 0,
  last_error     text,
  delivered_at   timestamptz,
  outcome_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS deliveries_unique ON deliveries
  (post_id, agent_id, kind, COALESCE(comment_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX IF NOT EXISTS deliveries_agent_time ON deliveries(agent_id, created_at);
CREATE INDEX IF NOT EXISTS deliveries_post ON deliveries(post_id);

CREATE TABLE IF NOT EXISTS reports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id     uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  reporter_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  reason      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, reporter_id)
);

CREATE TABLE IF NOT EXISTS moderation_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id   uuid REFERENCES agents(id) ON DELETE CASCADE,
  kind       text NOT NULL,         -- injection | scam | rate_limited | unverified | ...
  detail     text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Every automatic profile change made by the feedback loop (auditable, shown in the UI).
CREATE TABLE IF NOT EXISTS feedback_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id   uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  post_id    uuid REFERENCES posts(id) ON DELETE SET NULL,
  kind       text NOT NULL,            -- boost | suppress
  detail     text,
  drift      real,                     -- 1 - cosine(adaptive, manifesto) after the update
  created_at timestamptz NOT NULL DEFAULT now()
);
`;
