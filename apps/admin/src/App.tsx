import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "./api";
import { AccessPage } from "./pages/Access";
import { DisplaysPage } from "./pages/Displays";
import { AppsPage, GamesPage } from "./pages/Games";
import { HomePage } from "./pages/Home";
import { InternetPage } from "./pages/Internet";
import { RoomsPage } from "./pages/Rooms";
import { VenuePage } from "./pages/Venue";

const TABS = [
  { id: "home", label: "Tonight" },
  { id: "rooms", label: "Rooms" },
  { id: "games", label: "Games" },
  { id: "apps", label: "Apps" },
  { id: "displays", label: "TVs" },
  { id: "venue", label: "Venue" },
  { id: "access", label: "Access" },
  { id: "internet", label: "Internet" },
] as const;
type Tab = (typeof TABS)[number]["id"];

export function App() {
  const [auth, setAuth] = useState<{ setup: boolean; loggedIn: boolean; canSetup: boolean } | null>(null);
  const [tab, setTab] = useState<Tab>(() => (localStorage.getItem("bg-tab") as Tab) || "home");

  const refreshAuth = useCallback(() => api.authStatus().then(setAuth).catch(() => setAuth({ setup: true, loggedIn: false, canSetup: false })), []);
  useEffect(() => void refreshAuth(), [refreshAuth]);
  useEffect(() => {
    try {
      localStorage.setItem("bg-tab", tab);
    } catch {
      /* private mode */
    }
  }, [tab]);

  if (!auth) return <div className="center">Loading…</div>;
  if (!auth.loggedIn && !auth.setup && !auth.canSetup)
    return (
      <div className="center card narrow">
        <h1>Bar Games</h1>
        <p>This box hasn't been set up yet. Open it from a device on the venue network (for example http://&lt;box IP&gt;/) to choose the admin password.</p>
      </div>
    );
  if (!auth.loggedIn) return <Login setup={!auth.setup} onDone={refreshAuth} />;

  return (
    <div className="shell">
      <nav className="tabs">
        <strong className="brand">Bar Games</strong>
        {TABS.map((t) => (
          <button key={t.id} className={t.id === tab ? "active" : ""} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
        <button className="ghost" onClick={() => api.logout().then(refreshAuth)}>
          Log out
        </button>
      </nav>
      <main>
        {tab === "home" && <HomePage />}
        {tab === "rooms" && <RoomsPage />}
        {tab === "games" && <GamesPage />}
        {tab === "apps" && <AppsPage />}
        {tab === "displays" && <DisplaysPage />}
        {tab === "internet" && <InternetPage />}
        {tab === "venue" && <VenuePage />}
        {tab === "access" && <AccessPage />}
      </main>
    </div>
  );
}

function Login({ setup, onDone }: { setup: boolean; onDone: () => void }) {
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
      <h1>Bar Games</h1>
      <p>{setup ? "Welcome! Choose the admin password for this box (8+ characters). Staff use it to run games from the iPad." : "Admin login"}</p>
      <input type="password" placeholder="Password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus autoComplete={setup ? "new-password" : "current-password"} />
      {setup && <input type="password" placeholder="Confirm password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" />}
      {err && <p className="error">{err}</p>}
      <button className="primary">{setup ? "Set password" : "Log in"}</button>
    </form>
  );
}
