// Settings → Sign-in (box 0.15.1): change the admin password, or end every other session.
// Both sign everyone else out: other browsers, and staff signed in to games' admin pages.

import { useState } from "react";
import { api } from "../api";

export function SigninPage() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  const problem = next && next.length < 8 ? "At least 8 characters." : again && next !== again ? "The two new passwords don't match." : "";
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setMsg("");
    setError("");
    try {
      await fn();
      setMsg(done);
      setCurrent("");
      setNext("");
      setAgain("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack-gap">
      <section className="card stack-gap">
        <h2>Change the password</h2>
        <p className="muted">This is the password for this admin. Games and apps that accept the box password use it too. Changing it signs out every other device.</p>
        <label>
          Current password
          <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </label>
        <label>
          New password
          <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        </label>
        <label>
          New password again
          <input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
        </label>
        {problem && <p className="muted">{problem}</p>}
        <div className="buttons">
          <button className="primary" disabled={busy || !current || next.length < 8 || next !== again} onClick={() => void run(() => api.changePassword(current, next), "Password changed. Every other device was signed out.")}>
            Change password
          </button>
        </div>
      </section>

      <section className="card stack-gap">
        <h2>Sign out everywhere else</h2>
        <p className="muted">Ends every session but this one: other phones, tablets and computers, and staff signed in to a game's or app's own admin page. Use it if a device that was signed in is lost. Sessions also end by themselves after 12 hours.</p>
        <div className="buttons">
          <button type="button" disabled={busy} onClick={() => window.confirm("Sign out every other device?") && void run(() => api.logoutEverywhere(), "Every other device was signed out.")}>
            Sign out everywhere else
          </button>
        </div>
      </section>
      {msg && <p className="muted">{msg}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
