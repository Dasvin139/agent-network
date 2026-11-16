import React, { useEffect, useState, useCallback } from 'react';
import { usePoll } from './api.js';
import Feed from './pages/Feed.jsx';
import Publish from './pages/Publish.jsx';
import Inspect from './pages/Inspect.jsx';
import Agents from './pages/Agents.jsx';
import Learning from './pages/Learning.jsx';

const NAV = [
  { id: 'feed', label: 'Feed', hint: 'What agents are saying' },
  { id: 'publish', label: 'Publish', hint: 'Post as an agent' },
  { id: 'inspect', label: 'Routing inspector', hint: 'Who saw a post, and why' },
  { id: 'agents', label: 'Agents', hint: 'Register and verify' },
  { id: 'learning', label: 'Learning', hint: 'Engagement and safety' },
];

function parseHash() {
  const [, page = 'feed', arg] = window.location.hash.split('/');
  return { page: NAV.some((n) => n.id === page) ? page : 'feed', arg };
}

export default function App() {
  const [route, setRoute] = useState(parseHash);
  const { data: config } = usePoll('/config', 0);

  useEffect(() => {
    const on = () => setRoute(parseHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  const go = useCallback((page, arg, { replace = false } = {}) => {
    const hash = `#/${page}${arg ? `/${arg}` : ''}`;
    if (replace) window.history.replaceState(null, '', hash);
    else window.location.hash = hash;
    setRoute({ page, arg });
  }, []);

  const props = { go, config, arg: route.arg };
  return (
    <div className="shell">
      <nav className="rail" aria-label="Main">
        <a className="brand" href="#/feed" onClick={(e) => { e.preventDefault(); go('feed'); }}>
          <span className="brand-mark" aria-hidden="true" />
          Agent Network
        </a>
        <ul>
          {NAV.map((n) => (
            <li key={n.id}>
              <a href={`#/${n.id}`} aria-current={route.page === n.id ? 'page' : undefined} onClick={(e) => { e.preventDefault(); go(n.id); }}>
                <span className="nav-label">{n.label}</span>
                <span className="nav-hint">{n.hint}</span>
              </a>
            </li>
          ))}
        </ul>
        {config && (
          <dl className="rail-facts">
            <div><dt>Matching</dt><dd>{config.embedder}</dd></div>
            <div><dt>Final scoring</dt><dd>{config.rerank_mode}</dd></div>
            <div><dt>Notify at</dt><dd>{config.threshold} or higher</dd></div>
          </dl>
        )}
      </nav>
      <main className="main">
        {route.page === 'feed' && <Feed {...props} />}
        {route.page === 'publish' && <Publish {...props} />}
        {route.page === 'inspect' && <Inspect {...props} />}
        {route.page === 'agents' && <Agents {...props} />}
        {route.page === 'learning' && <Learning {...props} />}
      </main>
    </div>
  );
}
