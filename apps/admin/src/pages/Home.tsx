import { useState } from "react";
import { api, type AnnouncementPreset, type StatusItem } from "../api";
import { go, useRoute } from "../nav";
import { useAction, useLoad } from "../useLoad";
import { CastFlow } from "./CastFlow";
import { readPreviews, TvTile } from "./Displays";
import { PlansCard } from "./MediaControls";
import { RoomsPage } from "./Rooms";
import { ScenesCard } from "./Scenes";
import { AttentionCard, CountdownCard, LeaderboardCard } from "./TonightExtras";

/** "Tonight": the screen staff use most. What's on the TVs, open rooms, and the quick actions. */
export function HomePage() {
  const route = useRoute();
  const games = useLoad(api.games, 10_000);
  const displays = useLoad(api.displays, 10_000);
  const media = useLoad(api.media, 10_000);
  const events = useLoad(api.events, 5_000);
  const [previews] = useState(readPreviews);
  const list = displays.data ?? [];
  const providers = media.data?.providers ?? [];
  const on = (games.data ?? []).filter((g) => g.enabled);
  const playUrl = games.data?.[0]?.context.venue.playUrl;
  const casting = route.rest[0] === "cast";

  return (
    <div>
      <div className="page-head">
        <h1>Tonight</h1>
        <span className="pill">
          {on.length} game{on.length === 1 ? "" : "s"} and apps on
        </span>
        {playUrl && (
          <a className="pill" href={playUrl} target="_blank" rel="noreferrer">
            Players' page ↗
          </a>
        )}
      </div>
      <StatusBar />
      <AttentionCard />

      <div className="tonight">
        <div className="tonight-main">
          <section className="card">
            <div className="card-head">
              <h2>On the TVs</h2>
              <button type="button" className="primary" onClick={() => go("tonight", "cast")}>
                Put something on a TV
              </button>
            </div>
            {displays.error && <p className="error">TVs: {displays.error}</p>}
            {displays.data && !list.length && (
              <p className="muted">
                No TVs yet.{" "}
                <button type="button" className="ghost link" onClick={() => go("tvs")}>
                  Add them under TVs
                </button>
              </p>
            )}
            <div className="tv-wall">
              {list.map((d) => (
                <TvTile key={d.id} d={d} media={providers} previews={previews}>
                  <span className="tile-buttons">
                    {d.health?.online === false ? (
                      <button type="button" onClick={() => go("tvs", d.id)}>
                        Check it
                      </button>
                    ) : (
                      <>
                        <button type="button" onClick={() => go("tonight", "cast", d.id)}>
                          Change
                        </button>
                        {(d.capabilities?.remoteKeys?.length ?? 0) > 0 && (
                          <button type="button" onClick={() => go("tvs", d.id, "remote")}>
                            Remote
                          </button>
                        )}
                      </>
                    )}
                  </span>
                </TvTile>
              ))}
            </div>
          </section>
          <RoomsPage />
        </div>

        <aside className="tonight-side">
          <AnnouncementCard />
          <CountdownCard games={games.data ?? []} />
          <ScenesCard games={games.data ?? []} displays={list} />
        </aside>
      </div>

      <div className="grid stack-gap-top">
        <PlansCard />
        <LeaderboardCard />
        <section className="card wide">
          <details>
            <summary>Live events{(events.data ?? []).length ? ` (${events.data!.length})` : ""}</summary>
            {(events.data ?? []).length === 0 && <p className="muted">Nothing yet. Events from games show up here (and go to Home Assistant).</p>}
            <ul className="events">
              {(events.data ?? []).map((e, i) => (
                <li key={i}>
                  <time>{new Date(e.at).toLocaleTimeString()}</time> <b>{e.type}</b> {e.gameId}
                  {e.roomCode ? ` · ${e.roomCode}` : ""}
                  {e.data ? <code>{JSON.stringify(e.data)}</code> : null}
                </li>
              ))}
            </ul>
          </details>
        </section>
      </div>

      {casting && (
        <CastFlow
          games={games.data ?? []}
          displays={list}
          media={providers}
          preselect={route.rest[1]}
          onClose={() => {
            go("tonight");
            void displays.reload();
          }}
        />
      )}
    </div>
  );
}

const DURATIONS = [
  { label: "Until I take it down", minutes: 0 },
  { label: "15 minutes", minutes: 15 },
  { label: "1 hour", minutes: 60 },
  { label: "3 hours", minutes: 180 },
];

/** A message on every game page, the players' page and idle TVs ("Last call at 1:30"). */
/** Box 0.16.0: one line on how the box is doing; each item opens the page that fixes it. */
function StatusBar() {
  const status = useLoad(api.status, 30_000);
  const items = status.data?.items ?? [];
  const open = (p: StatusItem["page"]) =>
    p === "tvs" || p === "games" || p === "tonight" ? go(p) : go("settings", p === "scenes" ? "schedules" : p);
  if (status.error) return <div className="status-bar warn" role="status">Status: {status.error}</div>;
  if (!status.data) return null;
  if (!items.length) return <div className="status-bar ok" role="status">✓ All good: TVs online, games running, nothing waiting.</div>;
  return (
    <div className="status-bar" role="status">
      {items.map((i, n) => (
        <button key={n} type="button" className={`status-item ${i.level}`} onClick={() => open(i.page)}>
          {i.level === "error" ? "⚠ " : i.level === "warn" ? "! " : ""}
          {i.text}
        </button>
      ))}
    </div>
  );
}

/** Box 0.16.0: one-tap announcements, editable here. */
function PresetButtons({ busy, post }: { busy: boolean; post: (p: AnnouncementPreset) => void }) {
  const presets = useLoad(api.announcementPresets, 0);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<AnnouncementPreset[]>([]);
  const [msg, setMsg] = useState("");
  const list = presets.data?.presets ?? [];
  if (editing)
    return (
      <div className="presets-edit">
        {draft.map((p, i) => (
          <div key={i} className="inline">
            <input value={p.text} maxLength={200} aria-label={`Preset ${i + 1}`} onChange={(e) => setDraft(draft.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
            <select value={p.minutes ?? 0} aria-label="How long" onChange={(e) => setDraft(draft.map((x, j) => (j === i ? { ...x, minutes: Number(e.target.value) || undefined } : x)))}>
              {DURATIONS.map((d) => (
                <option key={d.minutes} value={d.minutes}>
                  {d.label}
                </option>
              ))}
            </select>
            <button type="button" className="ghost" aria-label="Remove" onClick={() => setDraft(draft.filter((_, j) => j !== i))}>
              ✕
            </button>
          </div>
        ))}
        <div className="buttons">
          {draft.length < 12 && (
            <button type="button" onClick={() => setDraft([...draft, { id: "", text: "" }])}>
              Add one
            </button>
          )}
          <button
            type="button"
            className="primary"
            onClick={() =>
              void api
                .saveAnnouncementPresets(draft.filter((p) => p.text.trim()))
                .then(() => (setEditing(false), setMsg(""), presets.reload()))
                .catch((e: Error) => setMsg(e.message))
            }
          >
            Save
          </button>
          <button type="button" className="ghost" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
        {msg && <p className="error">{msg}</p>}
      </div>
    );
  return (
    <div className="presets">
      {list.map((p) => (
        <button key={p.id} type="button" disabled={busy} onClick={() => post(p)} title={p.minutes ? `Up for ${p.minutes} min` : "Up until you take it down"}>
          {p.text}
        </button>
      ))}
      <button type="button" className="ghost" onClick={() => (setDraft(list.map((p) => ({ ...p }))), setEditing(true))}>
        Edit quick ones
      </button>
    </div>
  );
}

function AnnouncementCard() {
  const current = useLoad(api.announcement, 30_000);
  const { busy, run } = useAction(current.reload, current.setError);
  const [text, setText] = useState("");
  const [minutes, setMinutes] = useState(0);
  const [show, setShow] = useState<"everywhere" | "phones" | "tvs">("everywhere");
  const [position, setPosition] = useState<"top" | "bottom">("top");
  const a = current.data;
  const WHERE = { everywhere: "Phones and TVs", phones: "Phones only", tvs: "TVs only" } as const;
  return (
    <section className="card">
      <h2>Announcement</h2>
      {current.error && <p className="error">{current.error}</p>}
      {a ? (
        <div className="announce-live">
          <p>
            <b>{a.text}</b>
          </p>
          <small className="muted">
            {WHERE[a.show ?? "everywhere"]} · {a.position === "bottom" ? "bottom" : "top"} ·{" "}
            {a.until ? `comes down at ${new Date(a.until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "up until you take it down"}
          </small>
          <div className="buttons">
            <button disabled={busy} onClick={() => run(() => api.clearAnnouncement())}>
              Take it down
            </button>
          </div>
        </div>
      ) : (
        <p className="muted">Shown on every game's pages and on idle TVs: pick phones, TVs or both, and the top or bottom of the screen. Taking it down clears it within a few seconds.</p>
      )}
      <PresetButtons busy={busy} post={(p) => void run(() => api.announce(p.text, p.minutes, { show: p.show, position: p.position }))} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim()) return;
          void run(async () => {
            await api.announce(text, minutes || undefined, { show, position });
            setText("");
          });
        }}
      >
        <input value={text} maxLength={200} placeholder="Last call at 1:30" onChange={(e) => setText(e.target.value)} aria-label="Announcement text" />
        <div className="inline">
          <select value={show} onChange={(e) => setShow(e.target.value as typeof show)} aria-label="Where it shows">
            {Object.entries(WHERE).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
          <select value={position} onChange={(e) => setPosition(e.target.value as typeof position)} aria-label="Top or bottom">
            <option value="top">Top of the screen</option>
            <option value="bottom">Bottom of the screen</option>
          </select>
        </div>
        <div className="inline">
          <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} aria-label="How long">
            {DURATIONS.map((d) => (
              <option key={d.minutes} value={d.minutes}>
                {d.label}
              </option>
            ))}
          </select>
          <button className="primary" disabled={busy || !text.trim()}>{a ? "Replace" : "Post"}</button>
        </div>
      </form>
    </section>
  );
}
