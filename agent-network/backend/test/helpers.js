import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { start } from '../src/server.js';

const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); });
});

export async function boot(extra = {}, deps = {}) {
  const port = await freePort();
  const keysFile = path.join(os.tmpdir(), `agentnet-keys-${crypto.randomUUID()}.json`);
  const app = await start({
    port,
    publicUrl: `http://localhost:${port}`,
    dataDir: 'memory',
    demoKeysFile: keysFile,
    delivery: { baseDelayMs: 20, timeoutMs: 400, ignoreAfterMs: 60, sweepEveryMs: 3_600_000, breaker: { threshold: 3, cooldownMs: 200 } },
    demo: { replyDelayMs: 10 },
    ...extra,
  }, deps);
  const base = `http://localhost:${port}/api/v1`;
  const call = async (method, url, { key, body, headers = {} } = {}) => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* empty body */ }
    return { status: res.status, body: json };
  };
  const agentBySlug = async (slug) => (await call('GET', '/agents')).body.agents.find((a) => a.slug === slug);
  const postAs = (slug, body) => agentBySlug(slug).then((a) => call('POST', '/demo/post-as', { body: { agent_id: a.id, ...body } }));
  const routing = async (postId) => (await call('GET', `/posts/${postId}/routing`)).body;
  const settle = async () => {
    // wait for routing + delivery + the simulated agents' delayed replies
    for (let i = 0; i < 4; i++) {
      await app.idle();
      await new Promise((r) => setTimeout(r, 60));
    }
    await app.idle();
  };
  return { app, base, call, agentBySlug, postAs, routing, settle, close: () => app.close() };
}

// Registers + verifies a custom agent whose webhook is a local test server.
export async function registerAgent(t, { name, domain, manifesto, webhook, subscriptions, blocks, industry = 'Testing' }) {
  const reg = await t.call('POST', '/agents/register', {
    body: { company_name: name, industry, domain, webhook_url: webhook, manifesto, subscriptions, blocks },
  });
  if (reg.status !== 201) throw new Error(`register failed: ${JSON.stringify(reg.body)}`);
  await t.call('POST', `/admin/agents/${reg.body.agent.id}/verify`, { headers: { 'x-admin-key': t.app.cfg.adminKey } });
  return { id: reg.body.agent.id, key: reg.body.api_key, secret: reg.body.webhook_secret, reg };
}

export function receiver(handler) {
  const hits = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const entry = { headers: req.headers, raw };
      hits.push(entry);
      Promise.resolve(handler(entry, hits.length, res)).then((r) => {
        if (res.writableEnded) return;
        res.statusCode = r ?? 200;
        res.end('{}');
      });
    });
  });
  server.unref(); // a leaked test server must never keep the process alive
  return new Promise((resolve) => server.listen(0, () => resolve({ url: `http://localhost:${server.address().port}/hook`, hits, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) })));
}
