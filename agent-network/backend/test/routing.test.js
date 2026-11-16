import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, registerAgent, receiver } from './helpers.js';

let t;
before(async () => { t = await boot(); });
after(async () => { await t.close(); });

const DIWALI = {
  title: 'Diwali Food Delivery Discount',
  content: 'Swiggy is offering flat 5% off on all delivery orders above ₹300 during Diwali week.',
  tags: ['food', 'delivery', 'diwali', 'offers'],
};

test('the example from the brief: PhonePe and HDFC are notified, Bajaj Auto is not', async () => {
  const res = await t.postAs('swiggy', DIWALI);
  assert.equal(res.status, 202);
  assert.equal(res.body.status, 'pending', 'API answers before routing happens');
  await t.settle();

  const r = await t.routing(res.body.post_id);
  const by = Object.fromEntries(r.deliveries.map((d) => [d.company_name, d]));
  assert.equal(by.PhonePe.decision, 'notified');
  assert.equal(by['HDFC Bank'].decision, 'notified');
  assert.equal(by['Bajaj Auto'].decision, 'dropped_below_threshold');
  assert.ok(by['Bajaj Auto'].final_score < 0.15);
  assert.ok(by.PhonePe.final_score >= r.run.threshold);
  assert.equal(r.run.selected, 2);
  assert.equal(r.post_status, 'routed');
});

test('stage 1 filters: recipient-blocked industry and deactivated agents never become candidates', async () => {
  const res = await t.postAs('swiggy', DIWALI);
  await t.settle();
  const by = Object.fromEntries((await t.routing(res.body.post_id)).deliveries.map((d) => [d.company_name, d]));
  assert.equal(by.Flipkart.decision, 'dropped_filter');
  assert.equal(by.Flipkart.reason, 'blocked by recipient');
  assert.equal(by['OldMart Retail'].reason, 'deactivated');
  assert.equal(by.Flipkart.vector_score, null, 'filtered agents never reach vector search');
});

test('notified agents reply through the API, which marks them engaged and notifies the author', async () => {
  const res = await t.postAs('swiggy', { ...DIWALI, title: 'Diwali delivery offer again' });
  await t.settle();
  const post = (await t.call('GET', `/posts/${res.body.post_id}`)).body;
  const who = post.comments.map((c) => c.company_name).sort();
  assert.deepEqual(who, ['HDFC Bank', 'PhonePe']);
  assert.match(post.comments.find((c) => c.company_name === 'PhonePe').content, /₹50 cashback/);
  const statuses = post.routing.deliveries.filter((d) => d.decision === 'notified').map((d) => d.status);
  assert.deepEqual(statuses, ['engaged', 'engaged']);
});

test('the author is told about replies (comment deliveries), and replying agents do not chain forever', async () => {
  const res = await t.postAs('swiggy', { ...DIWALI, title: 'Diwali offers, third batch' });
  await t.settle();
  const post = (await t.call('GET', `/posts/${res.body.post_id}`)).body;
  assert.equal(post.comments.length, 2, 'simulated agents only react to post.created, not to comment events');
});

test('unrelated posts reach the right industry instead (automotive reaches Bajaj and Ola, not PhonePe)', async () => {
  const res = await t.postAs('bajaj-auto', {
    title: 'EV charging network expansion',
    content: 'Bajaj Auto is expanding electric vehicle charging infrastructure across dealerships and is seeking battery and charging partners.',
    tags: ['ev'],
  });
  await t.settle();
  const by = Object.fromEntries((await t.routing(res.body.post_id)).deliveries.map((d) => [d.company_name, d]));
  assert.equal(by['Ola Electric'].decision, 'notified');
  assert.notEqual(by.PhonePe?.decision, 'notified');
  assert.notEqual(by.MakeMyTrip?.decision, 'notified');
});

test('explicit subscriptions add candidates that vector search alone would not rank (hybrid retrieval)', async () => {
  const hook = await receiver(() => 200);
  const nerd = await registerAgent(t, {
    name: 'Zeta Widgets', domain: 'zetawidgets.io', webhook: hook.url,
    manifesto: 'We manufacture precision brass fittings and industrial valves for plumbing contractors.',
    subscriptions: [{ name: 'diwali watcher', keywords: ['diwali'], topics: [] }],
  });
  const res = await t.postAs('swiggy', { ...DIWALI, title: 'Diwali delivery offer, subscription test' });
  await t.settle();
  const row = (await t.routing(res.body.post_id)).deliveries.find((d) => d.agent_id === nerd.id);
  assert.ok(row, 'subscriber was considered');
  assert.match(row.subscription_match, /keyword:diwali/);
  assert.ok(row.vector_score < 0.3, 'semantically unrelated');
  assert.ok(row.final_score > row.vector_score, 'subscription boost applied');
  await hook.close();
});

test('per-post notification cap: only the top N relevant agents are notified', async () => {
  const t2 = await boot({ routing: { maxNotify: 1 } });
  try {
    const res = await t2.postAs('swiggy', DIWALI);
    await t2.settle();
    const rows = (await t2.routing(res.body.post_id)).deliveries;
    assert.equal(rows.filter((d) => d.decision === 'notified').length, 1);
    assert.equal(rows.find((d) => d.company_name === 'HDFC Bank').decision, 'dropped_over_cap');
  } finally {
    await t2.close();
  }
});

test('per-recipient hourly cap protects an agent from notification spam', async () => {
  const t2 = await boot({ routing: { recipientHourlyCap: 1 } });
  try {
    const a = await t2.postAs('swiggy', DIWALI);
    await t2.settle();
    const b = await t2.postAs('swiggy', { ...DIWALI, title: 'Another Diwali delivery offer' });
    await t2.settle();
    const rows = (await t2.routing(b.body.post_id)).deliveries;
    assert.equal(rows.find((d) => d.company_name === 'PhonePe').decision, 'dropped_rate_limited');
    assert.ok(a.body.post_id);
  } finally {
    await t2.close();
  }
});

test('POST /posts validates input and the author comes from the API key, not the body', async () => {
  const keys = (await import('node:fs')).default;
  const k = JSON.parse(keys.readFileSync(t.app.cfg.demoKeysFile, 'utf8'));
  const bad = await t.call('POST', '/posts', { key: k.swiggy.api_key, body: { title: 'x', content: 'short' } });
  assert.equal(bad.status, 422);
  const spoof = await t.call('POST', '/posts', { key: k.swiggy.api_key, body: { ...DIWALI, author_agent_id: k.phonepe.id } });
  assert.equal(spoof.status, 202);
  const post = (await t.call('GET', `/posts/${spoof.body.post_id}`)).body.post;
  assert.equal(post.company_name, 'Swiggy', 'author_agent_id in the body is ignored');
});
