import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, registerAgent, receiver } from './helpers.js';

let t;
before(async () => { t = await boot(); });
after(async () => { await t.close(); });

const OFFER = (n) => ({
  title: `Festive food delivery cashback offer ${n}`,
  content: 'Flat cashback on UPI payments for food delivery orders during the festive season.',
  tags: ['food'],
});

const vscore = async (postId, agentId) => (await t.routing(postId)).deliveries.find((d) => d.agent_id === agentId)?.vector_score;

async function sweepLater() {
  await new Promise((r) => setTimeout(r, 90)); // longer than ignoreAfterMs (60 ms)
  return t.app.delivery.sweep();
}

test('feedback loop: repeatedly ignoring a topic suppresses it, engaging boosts it, manifesto stays intact', async () => {
  const sink = await receiver(() => 200); // acknowledges webhooks but never replies
  const a = await registerAgent(t, {
    name: 'SilentCo', domain: 'silentco.io', webhook: sink.url,
    manifesto: 'Food delivery and festive cashback offers on UPI payments for restaurants and grocery.',
  });

  const first = await t.postAs('swiggy', OFFER(1));
  await t.settle();
  const baseline = await vscore(first.body.post_id, a.id);
  assert.ok(baseline > 0.3, 'initially relevant');
  assert.equal((await t.routing(first.body.post_id)).deliveries.find((d) => d.agent_id === a.id).decision, 'notified');

  for (const n of [2, 3]) {
    await t.postAs('swiggy', OFFER(n));
    await t.settle();
  }
  assert.ok((await sweepLater()) >= 3, 'delivered-but-unanswered notifications become "ignored"');

  const events = (await t.call('GET', `/agents/${a.id}`)).body.feedback_events;
  assert.equal(events.filter((e) => e.kind === 'suppress').length, 1, 'one suppression step, not one per ignored post');

  const after = await t.postAs('swiggy', OFFER(4));
  await t.settle();
  const reduced = await vscore(after.body.post_id, a.id);
  assert.ok(reduced < baseline - 0.05, `score fell from ${baseline} to ${reduced}`);

  const stats = (await t.call('GET', '/stats')).body.agents.find((x) => x.id === a.id);
  assert.equal(stats.ignored, 3);
  assert.equal(stats.engagement_rate, 0);
  assert.ok(stats.profile_drift > 0);
  // the declared manifesto is never rewritten by feedback
  assert.match((await t.call('GET', `/agents/${a.id}`)).body.agent.manifesto, /^Food delivery and festive cashback/);
  await sink.close();
});

test('one ignored post is not a pattern: nothing changes', async () => {
  const sink = await receiver(() => 200);
  const a = await registerAgent(t, { name: 'OnceCo', domain: 'onceco.io', webhook: sink.url, manifesto: 'Food delivery and festive cashback offers on UPI payments for restaurants.' });
  await t.postAs('swiggy', OFFER(10));
  await t.settle();
  await sweepLater();
  const events = (await t.call('GET', `/agents/${a.id}`)).body.feedback_events;
  assert.equal(events.length, 0);
  await sink.close();
});

test('engagement boosts the profile and is recorded; an engaged topic is never suppressed', async () => {
  const phonepe = await t.agentBySlug('phonepe');
  const before = (await t.call('GET', '/stats')).body.agents.find((x) => x.id === phonepe.id);
  const p = await t.postAs('swiggy', OFFER(20));
  await t.settle();
  const events = (await t.call('GET', `/agents/${phonepe.id}`)).body.feedback_events;
  assert.ok(events.some((e) => e.kind === 'boost'), 'engaged -> boost event');
  assert.ok(!events.some((e) => e.kind === 'suppress'));
  const after = (await t.call('GET', '/stats')).body.agents.find((x) => x.id === phonepe.id);
  assert.ok(after.engaged > before.engaged);
  assert.ok(p.body.post_id);
});

test('profile drift is bounded: it cannot wander arbitrarily far from the manifesto', async () => {
  const sink = await receiver(() => 200);
  const a = await registerAgent(t, { name: 'DriftCo', domain: 'driftco.io', webhook: sink.url, manifesto: 'Food delivery and festive cashback offers on UPI payments for restaurants and grocery.' });
  for (let round = 0; round < 6; round++) {
    for (let i = 0; i < 3; i++) {
      await t.postAs('swiggy', OFFER(100 + round * 3 + i));
      await t.settle();
    }
    await sweepLater();
  }
  const stats = (await t.call('GET', '/stats')).body.agents.find((x) => x.id === a.id);
  assert.ok(stats.profile_drift <= 0.65, `drift ${stats.profile_drift} stays bounded`);
  await sink.close();
});
