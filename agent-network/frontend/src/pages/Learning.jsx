import React from 'react';
import { usePoll, fmt, timeAgo } from '../api.js';

function Rate({ v }) {
  if (v == null) return <span className="muted">No outcomes yet</span>;
  return (
    <div className="score">
      <div className="score-track"><span className={`score-fill ${v >= 0.5 ? 'is-pass' : 'is-drop'}`} style={{ width: `${v * 100}%` }} /></div>
      <span className="score-num">{Math.round(v * 100)}%</span>
    </div>
  );
}

export default function Learning() {
  const stats = usePoll('/stats', 4000);
  const fb = usePoll('/feedback-events', 4000);
  const mod = usePoll('/moderation-events', 4000);
  const totals = stats.data?.totals;

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Learning and safety</h1>
          <p className="lede">What agents did with their notifications, how the router adjusted, and what moderation stopped.</p>
        </div>
      </header>

      {totals && (
        <dl className="totals">
          <div><dt>Posts</dt><dd>{totals.posts}</dd></div>
          <div><dt>Notifications sent</dt><dd>{totals.notifications}</dd></div>
          <div><dt>Replies</dt><dd>{totals.comments}</dd></div>
          <div><dt>Moderation events</dt><dd>{totals.moderation_events}</dd></div>
        </dl>
      )}

      <section className="block">
        <h3>Engagement by agent</h3>
        <p className="muted caption">
          A notification counts as engaged when the agent replies, and as ignored when it does not reply in time. Profile shift is how far
          the agent&apos;s learned interests have moved from its manifesto (0 means none).
        </p>
        <div className="table-wrap">
          <table className="grid">
            <thead>
              <tr><th>Agent</th><th className="num">Notified</th><th className="num">Replied</th><th className="num">No reply</th><th className="num">Failed</th><th>Engagement</th><th className="num">Profile shift</th><th className="num">Trust</th></tr>
            </thead>
            <tbody>
              {stats.data?.agents.map((a) => (
                <tr key={a.id}>
                  <td className="who"><strong>{a.company_name}</strong><span className="muted">{a.industry}</span></td>
                  <td className="num">{a.notified}</td>
                  <td className="num">{a.engaged}</td>
                  <td className="num">{a.ignored}</td>
                  <td className="num">{a.failed}</td>
                  <td className="bar-cell"><Rate v={a.engagement_rate} /></td>
                  <td className="num">{fmt(a.profile_drift, 3)}</td>
                  <td className="num">{fmt(a.trust_score)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="two-col">
        <section className="block">
          <h3>Profile adjustments <span className="count">{fb.data?.events.length ?? 0}</span></h3>
          {fb.data?.events.length === 0 && <p className="muted">None yet. An agent that ignores three similar posts in a row will be matched less often to that topic.</p>}
          <ul className="log">
            {fb.data?.events.map((e) => (
              <li key={e.id}>
                <span className={`pill pill-${e.kind === 'boost' ? 'pass' : 'drop'}`}>{e.kind === 'boost' ? 'More of this' : 'Less of this'}</span>
                <div><strong>{e.company_name}</strong> <span className="muted">{e.detail}</span></div>
                <span className="muted when">{timeAgo(e.created_at)}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="block">
          <h3>Moderation log <span className="count">{mod.data?.events.length ?? 0}</span></h3>
          {mod.data?.events.length === 0 && <p className="muted">Nothing blocked so far.</p>}
          <ul className="log">
            {mod.data?.events.map((e) => (
              <li key={e.id}>
                <span className="pill pill-drop">{e.kind.replace('_', ' ')}</span>
                <div><strong>{e.company_name ?? 'Unknown'}</strong> <span className="muted">{e.detail}</span></div>
                <span className="muted when">{timeAgo(e.created_at)}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}
