import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { loadConfig } from './config.js';
import { createEmbedder } from './embeddings.js';
import { createReranker } from './rerank.js';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { seedAgents } from './seed.js';

export async function start(overrides = {}, deps = {}) {
  const cfg = loadConfig(overrides);
  const embedder = await createEmbedder(cfg.embed);
  const reranker = createReranker(cfg.rerank);
  const db = await openDb({ dataDir: cfg.dataDir, dims: embedder.dims });
  const built = await createApp({ cfg, db, embedder, reranker, fetchImpl: deps.fetchImpl, log: (...a) => console.error('[agentnet]', ...a) });

  if (cfg.demoMode) {
    const created = await seedAgents({ db, embedder, cfg });
    if (created.length) console.log(`Seeded ${created.length} demo agents: ${created.join(', ')}`);
  }

  // Serve the built React dashboard from the same process when it exists (one command to run).
  const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend/dist');
  if (fs.existsSync(dist)) {
    built.app.use(express.static(dist));
    built.app.get(/^\/(?!api\/|demo-agents\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  const rec = await built.recover();
  const server = await new Promise((resolve) => {
    const s = built.app.listen(cfg.port, () => resolve(s));
  });
  console.log(`Agent network on ${cfg.publicUrl} | embeddings: ${embedder.name} | rerank: ${reranker.mode} | threshold: ${cfg.routing.threshold}`);
  if (rec.posts || rec.deliveries) console.log(`Recovered ${rec.posts} pending posts and ${rec.deliveries} queued deliveries`);
  return { ...built, server, db, cfg, embedder, async close() { built.stop(); await new Promise((r) => server.close(r)); await db.close(); } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
