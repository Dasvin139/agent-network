import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, registerAgent, receiver } from './helpers.js';
import { sign, verifySignature } from '../src/delivery.js';

let t;
before(async () => { t = await boot(); });
after(async () => { await t.close(); });

const OFFER = { title: 'Festive payment offer', content: 'Flat cashback on UPI payments for food delivery orders during the festive season.', tags: ['payments'] };

const MANIFESTO = 'Payments and cashback partnerships for food delivery and festive offers on UPI checkout.';

async function deliveryFor(postId, agentId) {
  return (await t.routing(postId)).deliveries.find((d) => d.agent_id === agentId);
}

test('signature: valid passes; tampered body, wrong secret, stale timestamp and garbage all fail', () => {
  const now = Date.now();
  const ts = Math.floor(now / 1000);
  const body = '{"a":1}';
  const header = `t=${ts},v1=${sign('s3cret', ts, body)}`;
  assert.equal(verifySignature('s3cret', header, body, { now }), true);
  assert.equal(verifySignature('s3cret', header, '{"a":2}', { now }), false);
  assert.equal(verifySignature('other', header, body, { now }), false);
  assert.equal(verifySignature('s3cret', header, body, { now: now + 10 * 60_000 }), false, 'replay after 5 minutes is rejected');
  assert.equal(verifySignature('s3cret', 'nonsense', body, { now }), false);
  assert.equal(verifySignature('s3cret', undefined, body, { now }), false);
});

test('webhooks carry a verifiable HMAC signature and a data-only payload', async () => {
  const hook = await receiver(() => 200);
  const a = await registerAgent(t, { name: 'SigCo', domain: 'sigco.io', webhook: hook.url, manifesto: MANIFESTO });
  const res = await t.postAs('swiggy', OFFER);
  await t.settle();
  assert.equal(hook.hits.length, 1);
  const { headers, raw } = hook.hits[0];
  assert.equal(verifySignature(a.secret, headers['x-agentnet-signature'], raw), true);
  const payload = JSON.parse(raw);
  assert.equal(payload.event, 'post.created');
  assert.equal(payload.post.author.company_name, 'Swiggy');
  assert.match(payload.notice, /untrusted/);
  assert.equal(payload.reply.url.endsWith(`/posts/${res.body.post_id}/comments`), true);
  assert.equal((await deliveryFor(res.body.post_id, a.id)).status, 'delivered');
  await hook.close();
});

test('transient failures are retried with backoff until they succeed', async () => {
  const hook = await receiver((_e, n) => (n < 3 ? 503 : 200));
  const a = await registerAgent(t, { name: 'FlakyCo', domain: 'flakyco.io', webhook: hook.url, manifesto: MANIFESTO });
  const res = await t.postAs('swiggy', { ...OFFER, title: 'Festive payment offer, retry test' });
  await t.settle();
  await new Promise((r) => setTimeout(r, 300));
  await t.app.idle();
  const d = await deliveryFor(res.body.post_id, a.id);
  assert.equal(d.status, 'delivered');
  assert.equal(d.attempts, 3);
  assert.equal(hook.hits.length, 3);
  await hook.close();
});

test('a 4xx from the recipient is a permanent failure (no retry storm)', async () => {
  const hook = await receiver(() => 401);
  const a = await registerAgent(t, { name: 'StrictCo', domain: 'strictco.io', webhook: hook.url, manifesto: MANIFESTO });
  const res = await t.postAs('swiggy', { ...OFFER, title: 'Festive payment offer, 4xx test' });
  await t.settle();
  const d = await deliveryFor(res.body.post_id, a.id);
  assert.equal(d.status, 'failed');
  assert.equal(d.attempts, 1);
  assert.match(d.last_error, /permanent/);
  assert.equal(hook.hits.length, 1);
  await hook.close();
});

test('a hung endpoint times out and fails after max attempts without blocking other deliveries', async () => {
  const hook = await receiver(() => new Promise(() => {})); // never answers
  const slow = await registerAgent(t, { name: 'HungCo', domain: 'hungco.io', webhook: hook.url, manifesto: MANIFESTO });
  const res = await t.postAs('swiggy', { ...OFFER, title: 'Festive payment offer, timeout test' });
  const started = Date.now();
  await t.settle();
  // healthy agents (PhonePe) were delivered to while the hung one was still retrying
  const rows = (await t.routing(res.body.post_id)).deliveries;
  assert.ok(['delivered', 'engaged'].includes(rows.find((d) => d.company_name === 'PhonePe').status));
  await new Promise((r) => setTimeout(r, 4000));
  await t.app.idle();
  const d = await deliveryFor(res.body.post_id, slow.id);
  assert.equal(d.status, 'failed');
  assert.match(d.last_error, /timeout|attempts/);
  assert.ok(Date.now() - started < 15_000);
  await hook.close();
});

test('failed webhook deliveries are still available through the pull inbox', async () => {
  const hook = await receiver(() => 500);
  const a = await registerAgent(t, { name: 'PullCo', domain: 'pullco.io', webhook: hook.url, manifesto: MANIFESTO });
  const res = await t.postAs('swiggy', { ...OFFER, title: 'Festive payment offer, inbox test' });
  await t.settle();
  await new Promise((r) => setTimeout(r, 400));
  const inbox = await t.call('GET', '/agents/me/inbox', { key: a.key });
  assert.equal(inbox.status, 200);
  const item = inbox.body.items.find((i) => i.post_id === res.body.post_id);
  assert.ok(item, 'post is retrievable by polling');
  assert.equal(item.author, 'Swiggy');
  await hook.close();
});

test('a forged request to a demo agent is rejected by signature verification', async () => {
  const res = await fetch(`${t.app.cfg.publicUrl}/demo-agents/phonepe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agentnet-signature': `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}` },
    body: JSON.stringify({ event: 'post.created' }),
  });
  assert.equal(res.status, 401);
});

test('queued deliveries survive a restart (durable queue recovery)', async () => {
  const hook = await receiver(() => 200);
  const a = await registerAgent(t, { name: 'RecoverCo', domain: 'recoverco.io', webhook: hook.url, manifesto: MANIFESTO });
  const res = await t.postAs('swiggy', { ...OFFER, title: 'Festive payment offer, recovery test' });
  await t.settle();
  const d = await deliveryFor(res.body.post_id, a.id);
  // simulate a crash that lost the in-memory queue: put the row back to queued and recover
  await t.app.db.query(`UPDATE deliveries SET status = 'queued', attempts = 0 WHERE id = $1`, [d.id]);
  const before = hook.hits.length;
  const rec = await t.app.recover();
  assert.ok(rec.deliveries >= 1);
  await t.settle();
  assert.equal(hook.hits.length, before + 1);
  assert.equal((await deliveryFor(res.body.post_id, a.id)).status, 'delivered');
  await hook.close();
});
