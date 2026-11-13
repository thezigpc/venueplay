import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "./api";
import { go, useRoute, type Section } from "./nav";
import { DisplaysPage } from "./pages/Displays";
import { GamesPage } from "./pages/Games";
import { HomePage } from "./pages/Home";
import { SettingsPage } from "./pages/Settings";

const NAV: { id: Section; label: string; icon: JSX.Element }[] = [
  { id: "tonight", label: "Tonight", icon: <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0z" /> },
  { id: "tvs", label: "TVs", icon: <path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM8 21h8M12 17v4" /> },
  { id: "games", label: "Games & apps", icon: <path d="M4 3h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM15 3h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM4 14h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1zM15 14h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1z" /> },
  { id: "settings", label: "Settings", icon: <path d="M4 6h8M18 6h2M4 12h2M12 12h8M4 18h10M20 18h0M16 6a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM10 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM18 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0z" /> },
];

export function App() {
  const [auth, setAuth] = useState<{ setup: boolean; loggedIn: boolean; canSetup: boolean; title?: string } | null>(null);
  const route = useRoute();

  const refreshAuth = useCallback(() => api.authStatus().then(setAuth).catch(() => setAuth({ setup: true, loggedIn: false, canSetup: false })), []);
  useEffect(() => void refreshAuth(), [refreshAuth]);
  // The venue can rename this admin (Settings → Venue); saving there refreshes it here.
  const title = auth?.title || "Bar Games";
  useEffect(() => {
    document.title = title;
  }, [title]);
  useEffect(() => {
    window.addEventListener("bg-venue-saved", refreshAuth);
    return () => window.removeEventListener("bg-venue-saved", refreshAuth);
  }, [refreshAuth]);

  if (!auth) return <div className="center">Loading…</div>;
  if (!auth.loggedIn && !auth.setup && !auth.canSetup)
    return (
      <div className="center card narrow">
        <h1>{title}</h1>
        <p>This box hasn't been set up yet. Open it from a device on the venue network (for example http://&lt;box IP&gt;/) to choose the admin password.</p>
      </div>
    );
  if (!auth.loggedIn) return <Login setup={!auth.setup} onDone={refreshAuth} title={title} />;

  return (
    <div className="shell">
      <nav className="rail" aria-label="Sections">
        <button type="button" className="brand" onClick={() => go("tonight")} title="Tonight">
          {title}
        </button>
        {NAV.map((n) => (
          <button key={n.id} type="button" className={`rail-item${n.id === route.section ? " active" : ""}`} aria-current={n.id === route.section ? "page" : undefined} onClick={() => go(n.id)}>
            <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {n.icon}
            </svg>
            {n.label}
          </button>
        ))}
        <span className="rail-gap" />
        <button type="button" className="ghost rail-logout" onClick={() => api.logout().then(refreshAuth)}>
          Log out
        </button>
      </nav>
      <main>
        {route.section === "tonight" && <HomePage />}
        {route.section === "tvs" && <DisplaysPage selected={route.rest[0]} tab={route.rest[1]} />}
        {route.section === "games" && <GamesPage />}
        {route.section === "settings" && <SettingsPage page={route.rest[0]} />}
      </main>
    </div>
  );
}

function Login({ setup, onDone, title }: { setup: boolean; onDone: () => void; title: string }) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [err, setErr] = useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    if (setup && pw.length < 8) return setErr("Use at least 8 characters.");
    if (setup && pw !== pw2) return setErr("The passwords don't match.");
    try {
      await (setup ? api.setup(pw) : api.login(pw));
      onDone();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Something went wrong");
    }
  };
  return (
    <form className="center card narrow" onSubmit={submit}>
      <h1>{title}</h1>
      <p>{setup ? "Welcome! Choose the admin password for this box (8+ characters). Staff use it to run games from the iPad." : "Admin login"}</p>
      <input type="password" placeholder="Password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus autoComplete={setup ? "new-password" : "current-password"} />
      {setup && <input type="password" placeholder="Confirm password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" />}
      {err && <p className="error">{err}</p>}
      <button className="primary">{setup ? "Set password" : "Log in"}</button>
    </form>
  );
}
