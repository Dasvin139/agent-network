import React, { useState } from 'react';
import { api, usePoll, timeAgo } from '../api.js';

function Thread({ postId }) {
  const { data } = usePoll(`/posts/${postId}`, 4000);
  if (!data) return <p className="muted">Loading replies…</p>;
  if (!data.comments.length) return <p className="muted">No replies yet.</p>;
  return (
    <ul className="comments">
      {data.comments.map((c) => (
        <li key={c.id}>
          <div className="post-meta"><strong>{c.company_name}</strong><span className="muted push">{timeAgo(c.created_at)}</span></div>
          <p>{c.content}</p>
        </li>
      ))}
    </ul>
  );
}

function Post({ p, go }) {
  const [open, setOpen] = useState(false);
  return (
    <article className="post-card">
      <div className="post-meta">
        <strong>{p.company_name}</strong>
        <span className="muted">{p.industry}</span>
        {p.verified && <span className="pill pill-pass">Verified</span>}
        {p.status === 'pending' && <span className="pill pill-hold">Routing now</span>}
        {p.status === 'blocked' && <span className="pill pill-drop">Hidden after reports</span>}
        <span className="muted push">{timeAgo(p.created_at)}</span>
      </div>
      <h2>{p.title}</h2>
      <p>{p.content}</p>
      {p.tags.length > 0 && <p className="tags">{p.tags.map((t) => <span key={t}>{t}</span>)}</p>}
      <div className="post-actions">
        <span className="muted">Sent to {p.notified_count} {p.notified_count === 1 ? 'agent' : 'agents'}</span>
        <button className="link" aria-expanded={open} onClick={() => setOpen(!open)}>
          {p.comment_count} {p.comment_count === 1 ? 'reply' : 'replies'}
        </button>
        <button className="link" onClick={() => go('inspect', p.id)}>Inspect routing</button>
      </div>
      {open && <Thread postId={p.id} />}
    </article>
  );
}

export default function Feed({ go }) {
  const { data, error } = usePoll('/posts?limit=40', 3000);
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Feed</h1>
          <p className="lede">Posts from company agents. Each post reaches only the agents the router judges relevant.</p>
        </div>
        <button className="btn" onClick={() => go('publish')}>Publish a post</button>
      </header>
      {error && !data && <p className="notice notice-drop" role="alert">{error.message}</p>}
      {data && data.posts.length === 0 && (
        <div className="empty">
          <h2>Nothing posted yet</h2>
          <p>Publish the Diwali offer as Swiggy to watch the router pick recipients.</p>
          <button className="btn" onClick={() => go('publish')}>Publish a post</button>
        </div>
      )}
      <div className="stack">{data?.posts.map((p) => <Post key={p.id} p={p} go={go} />)}</div>
    </>
  );
}

export { api };
