import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { HashRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { ApiError, QueuePilotClient, defaultApiUrl, loadSession, saveSession } from './api/client';
import type { Session } from './api/client';
import { ErrorNote } from './components/common';
import { Backups } from './pages/Backups';
import { Dashboard } from './pages/Dashboard';
import { JobDetail } from './pages/JobDetail';
import { Jobs } from './pages/Jobs';
import { Recovery } from './pages/Recovery';
import { Submit } from './pages/Submit';
import { SessionContext } from './session';

export function SignIn({ onSignedIn, fetchImpl }: { onSignedIn: (s: Session) => void; fetchImpl?: typeof fetch }) {
  const [apiUrl, setApiUrl] = useState(defaultApiUrl());
  const [token, setToken] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const [checking, setChecking] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const session = { apiUrl: apiUrl.trim().replace(/\/+$/, ''), token: token.trim() };
    if (!/^https?:\/\//.test(session.apiUrl)) return setError(new Error('Enter the API URL from the deployment output (it starts with https://).'));
    if (session.token.length < 16) return setError(new Error('The demo token is at least 16 characters long.'));
    setChecking(true);
    try {
      // A real authenticated call proves both the URL and the token before we continue.
      await new QueuePilotClient(session, fetchImpl).metrics();
      saveSession(session);
      onSignedIn(session);
    } catch (err) {
      setError(err instanceof ApiError ? err : new Error(String(err)));
    } finally {
      setChecking(false);
    }
  };

  return (
    <main className="signin">
      <form onSubmit={submit} className="signin-card">
        <h1 className="wordmark">QueuePilot</h1>
        <p>Asynchronous file processing on AWS, with retries, a dead-letter queue and backups you can see working.</p>
        <label className="field">
          <span>API URL</span>
          <input value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} placeholder="https://abc123.execute-api.us-east-1.amazonaws.com" inputMode="url" />
        </label>
        <label className="field">
          <span>Demo token</span>
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="current-password" />
          <small>The token chosen when the backend was deployed. It is kept only in this browser tab.</small>
        </label>
        <ErrorNote error={error} />
        <button type="submit" className="btn btn-primary" disabled={checking}>
          {checking ? 'Checking…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}

const NAV = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/submit', label: 'Submit' },
  { to: '/jobs', label: 'Jobs' },
  { to: '/recovery', label: 'Recovery' },
  { to: '/backups', label: 'Backups' },
];

export function App() {
  const [session, setSession] = useState<Session | null>(() => loadSession());
  const value = useMemo(
    () =>
      session
        ? {
            session,
            client: new QueuePilotClient(session),
            signOut: () => {
              saveSession(null);
              setSession(null);
            },
          }
        : null,
    [session],
  );

  if (!value) return <SignIn onSignedIn={setSession} />;

  return (
    <SessionContext.Provider value={value}>
      <HashRouter>
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <header className="topbar">
          <span className="wordmark">QueuePilot</span>
          <nav aria-label="Main">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `nav-link ${isActive ? 'nav-on' : ''}`}>
                {n.label}
              </NavLink>
            ))}
          </nav>
          <button type="button" className="btn btn-quiet signout" onClick={value.signOut}>
            Sign out
          </button>
        </header>
        <main id="main">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/submit" element={<Submit />} />
            <Route path="/jobs" element={<Jobs />} />
            <Route path="/jobs/:jobId" element={<JobDetail />} />
            <Route path="/recovery" element={<Recovery />} />
            <Route path="/backups" element={<Backups />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </HashRouter>
    </SessionContext.Provider>
  );
}
