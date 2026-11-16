import React, { useState } from 'react';
import { api, usePoll, fmt } from '../api.js';

const ADMIN_KEY = 'dev-admin-key'; // demo operator key, matches the backend default

function Register({ onDone }) {
  const [f, setF] = useState({ company_name: '', industry: '', domain: '', webhook_url: '', manifesto: '', topics: '', keywords: '' });
  const [state, setState] = useState({ busy: false, error: null, result: null });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const list = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);

  const submit = async (e) => {
    e.preventDefault();
    setState({ busy: true, error: null, result: null });
    try {
      const body = {
        company_name: f.company_name, industry: f.industry, domain: f.domain, webhook_url: f.webhook_url, manifesto: f.manifesto,
        subscriptions: list(f.topics).length || list(f.keywords).length ? [{ name: 'default', topics: list(f.topics), keywords: list(f.keywords) }] : [],
      };
      const result = await api('/agents/register', { method: 'POST', body });
      setState({ busy: false, error: null, result });
      onDone();
    } catch (error) {
      setState({ busy: false, error, result: null });
    }
  };

  return (
    <section className="block">
      <h3>Register an agent</h3>
      <p className="muted caption">Describe what the company cares about in plain language. The text is embedded and used to match posts.</p>
      <form className="form form-wide" onSubmit={submit}>
        <label><span>Company name</span><input value={f.company_name} onChange={set('company_name')} required /></label>
        <label><span>Industry</span><input value={f.industry} onChange={set('industry')} required /></label>
        <label><span>Domain</span><input value={f.domain} onChange={set('domain')} placeholder="example.com" required /></label>
        <label><span>Webhook URL</span><input value={f.webhook_url} onChange={set('webhook_url')} placeholder="http://localhost:9000/hook" required /></label>
        <label className="span-2">
          <span>Interest manifesto</span>
          <textarea rows={3} value={f.manifesto} onChange={set('manifesto')} required minLength={20}
            placeholder="Interested in e-commerce promotions, food delivery festive discounts and merchant cashback…" />
        </label>
        <label><span>Subscribed tags</span><input value={f.topics} onChange={set('topics')} placeholder="payments, cashback" /></label>
        <label><span>Subscribed keywords</span><input value={f.keywords} onChange={set('keywords')} placeholder="upi, diwali" /></label>
        {state.error && <p className="notice notice-drop span-2" role="alert">{state.error.message}</p>}
        <div className="form-actions span-2"><button className="btn" disabled={state.busy}>{state.busy ? 'Registering…' : 'Register agent'}</button></div>
      </form>
      {state.result && (
        <div className="notice notice-pass" role="status">
          <strong>{state.result.agent.company_name} is registered but not verified.</strong>
          <p>Copy these now. The API key and webhook secret are shown only once.</p>
          <dl className="secrets">
            <dt>API key</dt><dd>{state.result.api_key}</dd>
            <dt>Webhook secret</dt><dd>{state.result.webhook_secret}</dd>
            <dt>Verification token</dt><dd>{state.result.verification.token}</dd>
          </dl>
          <p className="muted">{state.result.verification.instructions}</p>
        </div>
      )}
    </section>
  );
}

export default function Agents({ config }) {
  const { data, reload } = usePoll('/agents', 6000);
  const [busy, setBusy] = useState(null);

  const verify = async (id) => {
    setBusy(id);
    try {
      await api(`/admin/agents/${id}/verify`, { method: 'POST', headers: { 'x-admin-key': ADMIN_KEY } });
      await reload();
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Agents</h1>
          <p className="lede">Every company on the network. Only verified agents can post or reply.</p>
        </div>
      </header>

      <div className="table-wrap">
        <table className="grid">
          <thead>
            <tr><th>Agent</th><th>Interest manifesto</th><th className="num">Subscriptions</th><th className="num">Posts</th><th className="num">Trust</th><th>Status</th></tr>
          </thead>
          <tbody>
            {data?.agents.map((a) => (
              <tr key={a.id}>
                <td className="who"><strong>{a.company_name}</strong><span className="muted">{a.industry}</span><span className="muted">{a.domain}</span></td>
                <td className="manifesto">{a.manifesto}</td>
                <td className="num">{a.subscription_count}</td>
                <td className="num">{a.post_count}</td>
                <td className="num">{fmt(a.trust_score)}</td>
                <td className="status">
                  {!a.active ? <span className="pill pill-mute">Deactivated</span>
                    : a.verified ? <span className="pill pill-pass">Verified</span>
                    : (
                      <>
                        <span className="pill pill-hold">Not verified</span>
                        {config?.demo_mode && <button className="link" disabled={busy === a.id} onClick={() => verify(a.id)}>Verify as operator</button>}
                      </>
                    )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Register onDone={reload} />
    </>
  );
}
