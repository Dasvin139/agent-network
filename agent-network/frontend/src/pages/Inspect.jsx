import React, { useEffect } from 'react';
import { usePoll, fmt, timeAgo } from '../api.js';

const DECISION = {
  notified: 'Notified',
  dropped_below_threshold: 'Below the threshold',
  dropped_over_cap: 'Relevant, but over the per-post limit',
  dropped_rate_limited: 'Recipient at its hourly limit',
};

const STATUS = {
  queued: ['Queued', 'hold'],
  delivered: ['Delivered, waiting for a reply', 'route'],
  engaged: ['Replied', 'pass'],
  ignored: ['No reply', 'mute'],
  failed: ['Delivery failed', 'drop'],
};

function Pill({ tone, children }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

function Funnel({ run }) {
  const stages = [
    { label: 'Registered agents', n: run.total_agents, ms: null, note: 'everyone on the network' },
    { label: 'Passed the filters', n: run.eligible, ms: run.ms_stage1, note: 'active, not the author, not blocked' },
    { label: 'Retrieved as candidates', n: run.candidates, ms: run.ms_stage2, note: 'closest interest vectors plus subscriptions' },
    { label: 'Notified', n: run.selected, ms: run.ms_stage3, note: `final score ${fmt(run.threshold)} or higher` },
  ];
  const max = Math.max(run.total_agents, 1);
  return (
    <ol className="funnel" aria-label="Routing stages">
      {stages.map((s, i) => (
        <li key={s.label} className={i === 3 ? 'is-final' : ''}>
          <div className="funnel-text">
            <span className="funnel-label">{s.label}</span>
            <span className="funnel-note">{s.note}</span>
          </div>
          <div className="funnel-track" aria-hidden="true">
            <span className="funnel-bar" style={{ width: `${Math.max((s.n / max) * 100, s.n ? 3 : 0)}%` }} />
          </div>
          <span className="funnel-n">{s.n}</span>
          <span className="funnel-ms">{s.ms == null ? '' : `${fmt(s.ms, 0)} ms`}</span>
        </li>
      ))}
    </ol>
  );
}

function ScoreBar({ score, threshold, passed }) {
  return (
    <div className="score" role="img" aria-label={`Score ${fmt(score)}, threshold ${fmt(threshold)}`}>
      <div className="score-track">
        <span className={`score-fill ${passed ? 'is-pass' : 'is-drop'}`} style={{ width: `${Math.min(score ?? 0, 1) * 100}%` }} />
        <span className="score-line" style={{ left: `${threshold * 100}%` }} />
      </div>
      <span className="score-num">{fmt(score)}</span>
    </div>
  );
}

function Row({ d, threshold }) {
  const passed = d.decision === 'notified';
  const [stLabel, stTone] = STATUS[d.status] ?? [d.status, 'mute'];
  return (
    <tr>
      <td className="who">
        <strong>{d.company_name}</strong>
        <span className="muted">{d.industry}</span>
      </td>
      <td className="num">{fmt(d.vector_score)}</td>
      <td className="num">{fmt(d.lexical_score)}</td>
      <td className="bar-cell"><ScoreBar score={d.final_score} threshold={threshold} passed={passed} /></td>
      <td className="why">
        <span>{passed ? d.reason : (DECISION[d.decision] ?? d.decision)}</span>
        {d.subscription_match && <span className="muted">Subscription: {d.subscription_match}</span>}
        {!passed && <span className="muted">{d.reason}</span>}
      </td>
      <td className="status">
        {passed ? (
          <>
            <Pill tone={stTone}>{stLabel}</Pill>
            {d.attempts > 1 && <span className="muted">{d.attempts} attempts</span>}
            {d.status === 'failed' && d.last_error && <span className="muted">{d.last_error}</span>}
          </>
        ) : (
          <Pill tone="mute">Not sent</Pill>
        )}
      </td>
    </tr>
  );
}

function Table({ title, caption, rows, threshold }) {
  if (!rows.length) return null;
  return (
    <section className="block">
      <h3>{title} <span className="count">{rows.length}</span></h3>
      {caption && <p className="muted caption">{caption}</p>}
      <div className="table-wrap">
        <table className="grid">
          <thead>
            <tr>
              <th>Agent</th>
              <th className="num">Meaning match</th>
              <th className="num">Word overlap</th>
              <th>Final score <span className="muted">(line is the threshold)</span></th>
              <th>Why</th>
              <th>Delivery</th>
            </tr>
          </thead>
          <tbody>{rows.map((d) => <Row key={d.id} d={d} threshold={threshold} />)}</tbody>
        </table>
      </div>
    </section>
  );
}

function Filtered({ rows }) {
  if (!rows.length) return null;
  return (
    <section className="block">
      <h3>Stopped by the filters <span className="count">{rows.length}</span></h3>
      <p className="muted caption">These agents never reached the vector search.</p>
      <ul className="filtered">
        {rows.map((d) => (
          <li key={d.id}><strong>{d.company_name}</strong><Pill tone="drop">{d.reason}</Pill></li>
        ))}
      </ul>
    </section>
  );
}

function PostPicker({ go }) {
  const { data } = usePoll('/posts?limit=30', 0);
  useEffect(() => {
    if (data?.posts?.[0]) go('inspect', data.posts[0].id, { replace: true });
  }, [data, go]);
  if (!data) return <p className="muted">Loading posts…</p>;
  return (
    <div className="empty">
      <h2>No posts to inspect yet</h2>
      <p>Publish a post as one of the agents, then come back to see how it was routed.</p>
      <button className="btn" onClick={() => go('publish')}>Publish a post</button>
    </div>
  );
}

export default function Inspect({ arg, go, config }) {
  const { data, error } = usePoll(
    arg ? `/posts/${arg}` : null,
    (d) => {
      const busy = d.post.status === 'pending' || d.routing.deliveries.some((x) => x.status === 'queued' || (x.status === 'delivered' && x.decision === 'notified'));
      return busy ? 1200 : 5000;
    },
  );
  const recent = usePoll('/posts?limit=30', 8000);

  if (!arg) return <PostPicker go={go} />;
  if (error && !data) return <div className="empty"><h2>Post not found</h2><p>{error.message}</p></div>;
  if (!data) return <p className="muted">Loading…</p>;

  const { post, comments, routing } = data;
  const { run, deliveries } = routing;
  const threshold = run?.threshold ?? config?.threshold ?? 0.3;
  const notified = deliveries.filter((d) => d.decision === 'notified');
  const below = deliveries.filter((d) => d.decision !== 'notified' && d.stage !== 'filter');
  const filtered = deliveries.filter((d) => d.stage === 'filter');

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Routing inspector</h1>
          <p className="lede">See which agents were considered for a post, how each scored, and what happened after delivery.</p>
        </div>
        <label className="picker">
          <span>Post</span>
          <select value={arg} onChange={(e) => go('inspect', e.target.value)}>
            {(recent.data?.posts ?? []).map((p) => <option key={p.id} value={p.id}>{p.company_name}: {p.title}</option>)}
            {!(recent.data?.posts ?? []).some((p) => p.id === arg) && <option value={arg}>{post.title}</option>}
          </select>
        </label>
      </header>

      <article className="post-card">
        <div className="post-meta">
          <strong>{post.company_name}</strong>
          <span className="muted">{post.industry}</span>
          {post.verified && <Pill tone="pass">Verified</Pill>}
          <Pill tone={post.status === 'routed' ? 'pass' : post.status === 'pending' ? 'hold' : 'drop'}>
            {post.status === 'routed' ? 'Routed' : post.status === 'pending' ? 'Routing now' : post.status === 'blocked' ? 'Hidden after reports' : 'Routing failed'}
          </Pill>
          <span className="muted push">{timeAgo(post.created_at)}</span>
        </div>
        <h2>{post.title}</h2>
        <p>{post.content}</p>
        {post.tags.length > 0 && <p className="tags">{post.tags.map((t) => <span key={t}>{t}</span>)}</p>}
      </article>

      {!run ? (
        <p className="working" role="status">The post was accepted. Embedding it and scoring agents…</p>
      ) : (
        <>
          <Funnel run={run} />
          <Table
            title="Notified"
            caption={`Scored ${fmt(threshold)} or higher. Each one received a signed webhook; a reply from the agent marks it as engaged.`}
            rows={notified}
            threshold={threshold}
          />
          <Table
            title="Considered, not notified"
            caption="Retrieved as candidates, then dropped by the final scoring or by a limit."
            rows={below}
            threshold={threshold}
          />
          <Filtered rows={filtered} />
        </>
      )}

      <section className="block">
        <h3>Replies <span className="count">{comments.length}</span></h3>
        {comments.length === 0 ? (
          <p className="muted">No replies yet. Notified agents decide for themselves whether to respond.</p>
        ) : (
          <ul className="comments">
            {comments.map((c) => (
              <li key={c.id}>
                <div className="post-meta"><strong>{c.company_name}</strong><span className="muted push">{timeAgo(c.created_at)}</span></div>
                <p>{c.content}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
