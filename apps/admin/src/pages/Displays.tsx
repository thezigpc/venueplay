import { useEffect, useState } from "react";
import { api, type CastSettings, type Display } from "../api";
import { useAction, useLoad } from "../useLoad";

export function DisplaysPage() {
  const displays = useLoad(api.displays, 10_000);
  const { busy, run } = useAction(displays.reload, displays.setError);
  const [host, setHost] = useState("");
  const [note, setNote] = useState("");

  return (
    <div className="grid">
      <section className="card wide">
        <h2>TVs</h2>
        <div className="buttons">
          <button
            className="primary"
            disabled={busy}
            onClick={() =>
              run(async () => {
                const r = await api.discover();
                setNote(`Found ${r.found} device(s).${r.errors.length ? ` Problems: ${r.errors.join("; ")}` : ""}`);
              })
            }
          >
            Find TVs
          </button>
          <input placeholder="Add Roku by IP" value={host} onChange={(e) => setHost(e.target.value)} />
          <button disabled={!host || busy} onClick={() => run(() => api.addRoku(host).then(() => setHost("")))}>
            Add
          </button>
        </div>
        {note && <p className="muted">{note}</p>}
        {displays.error && <p className="error">{displays.error}</p>}
      </section>
      {(displays.data ?? []).map((d) => (
        <DisplayCard key={d.id} d={d} busy={busy} run={run} reload={displays.reload} />
      ))}
      <CastFromGames />
    </div>
  );
}

const STREAM_LABEL: Record<string, string> = {
  streaming: "casting",
  connecting: "connecting…",
  pin_required: "waiting for its AirPlay code",
  dropped: "lost connection, retrying",
  error: "error",
};

function DisplayCard({ d, busy, run, reload }: { d: Display; busy: boolean; run: (fn: () => Promise<unknown>) => void; reload: () => unknown }) {
  const [label, setLabel] = useState(d.label ?? "");
  const [group, setGroup] = useState(d.group ?? "");
  const [delivery, setDelivery] = useState(d.delivery ?? "");
  const online = d.health?.online;
  const stream = d.stream;
  const canPair = d.capabilities?.delivery.includes("airplay");
  return (
    <section className="card">
      <h2>
        <span className={`dot ${online ? (stream?.state === "streaming" ? "on" : stream ? "warn" : "on") : "off"}`} /> {d.label || d.name}
      </h2>
      <p className="muted">
        {d.model} · {d.isTv ? "TV" : "player"} · {d.health?.powerMode ?? (online ? "online" : "offline")}
      </p>
      {stream ? (
        <p className="muted">
          {d.content?.title ?? "Showing"}: <b>{STREAM_LABEL[stream.state] ?? stream.state}</b>
          {stream.detail ? ` (${stream.detail})` : ""}
        </p>
      ) : (
        d.content?.kind === "url" && <p className="muted">Last shown: {d.content.title ?? d.content.url}</p>
      )}
      {canPair && <Pairing d={d} needsCode={Boolean(stream?.needsCode)} reload={reload} />}
      <label>
        Name
        <input placeholder={d.name} value={label} onChange={(e) => setLabel(e.target.value)} />
      </label>
      <label>
        Group
        <input placeholder="e.g. main, patio" value={group} onChange={(e) => setGroup(e.target.value)} />
      </label>
      <label>
        Delivery
        <select value={delivery} onChange={(e) => setDelivery(e.target.value)}>
          <option value="">Auto ({d.capabilities?.delivery[0] ?? "none"})</option>
          {(d.capabilities?.delivery ?? []).map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
      </label>
      <div className="buttons">
        <button className="primary" disabled={busy} onClick={() => run(() => api.patchDisplay(d.id, { label, group, delivery: delivery || undefined }))}>
          Save
        </button>
        {stream && (
          <button disabled={busy} onClick={() => run(() => api.show({ displayIds: [d.id] }, { kind: "off" }))}>
            Stop casting
          </button>
        )}
        {d.capabilities?.power && (
          <>
            <button disabled={busy} onClick={() => run(() => api.power(d.id, true))}>
              On
            </button>
            <button disabled={busy} onClick={() => run(() => api.power(d.id, false))}>
              Off
            </button>
          </>
        )}
      </div>
    </section>
  );
}

/** AirPlay pairing: Pair → the TV shows a code → enter it here. Needed once per TV. */
function Pairing({ d, needsCode, reload }: { d: Display; needsCode: boolean; reload: () => unknown }) {
  const [phase, setPhase] = useState<"idle" | "starting" | "code" | "sending">(needsCode ? "code" : "idle");
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState("");
  useEffect(() => {
    if (needsCode && phase === "idle") setPhase("code");
  }, [needsCode, phase]);

  const start = async () => {
    setPhase("starting");
    setMsg("Connecting to the TV…");
    try {
      const r = await api.pair(d.id);
      if (r.needsCode) {
        setPhase("code");
        setMsg("Enter the code the TV is showing.");
      } else {
        setPhase("idle");
        setMsg(r.ok ? (r.message ?? "Paired.") : (r.message ?? "Pairing failed."));
      }
    } catch (e) {
      setPhase("idle");
      setMsg((e as Error).message);
    }
    void reload();
  };
  const send = async () => {
    setPhase("sending");
    try {
      const r = await api.pair(d.id, code);
      setCode("");
      if (r.ok) {
        setPhase("idle");
        setMsg("Paired. The TV goes back to what it was showing in a few seconds.");
      } else if (r.needsCode) {
        setPhase("code");
        setMsg("That code didn't work. Check the TV for a new one.");
      } else {
        setPhase("idle");
        setMsg(r.message ?? "Pairing failed.");
      }
    } catch (e) {
      setPhase("code");
      setMsg((e as Error).message);
    }
    void reload();
  };

  return (
    <div className="pairing">
      {phase === "code" || phase === "sending" ? (
        <div className="buttons">
          <input inputMode="numeric" autoComplete="one-time-code" placeholder="Code on the TV" value={code} onChange={(e) => setCode(e.target.value.trim())} />
          <button className="primary" disabled={!code || phase === "sending"} onClick={() => void send()}>
            Pair
          </button>
          <button disabled={phase === "sending"} onClick={() => void start()}>
            New code
          </button>
        </div>
      ) : (
        <button disabled={phase === "starting"} onClick={() => void start()}>
          {phase === "starting" ? "Pairing…" : "Pair (AirPlay)"}
        </button>
      )}
      {msg && <p className="muted">{msg}</p>}
    </div>
  );
}

/** Whether game hosts may cast their rooms to these TVs from inside the game. */
function CastFromGames() {
  const settings = useLoad(api.castSettings);
  const [s, setS] = useState<CastSettings>({ fromGames: false, pin: "" });
  const [saved, setSaved] = useState("");
  const { busy, run } = useAction(settings.reload, settings.setError);
  useEffect(() => {
    if (settings.data) setS(settings.data);
  }, [settings.data]);
  return (
    <section className="card wide">
      <h2>Casting from games</h2>
      <p className="muted">
        Lets a game's host put their room on these TVs from inside the game (for games that support it). Staff can always cast from the Home tab.
      </p>
      <label className="switch">
        <input type="checkbox" checked={s.fromGames} onChange={(e) => setS({ ...s, fromGames: e.target.checked })} />
        <span>{s.fromGames ? "Allowed" : "Off"}</span>
      </label>
      <label>
        TV PIN (optional, 4-8 digits). Hosts must enter it to cast. Leave empty for no PIN.
        <input inputMode="numeric" placeholder="none" value={s.pin} onChange={(e) => setS({ ...s, pin: e.target.value.replace(/\D/g, "").slice(0, 8) })} />
      </label>
      <div className="buttons">
        <button
          className="primary"
          disabled={busy}
          onClick={() =>
            run(async () => {
              await api.saveCastSettings(s);
              setSaved("Saved.");
            })
          }
        >
          Save
        </button>
      </div>
      {saved && <p className="muted">{saved}</p>}
      {settings.error && <p className="error">{settings.error}</p>}
    </section>
  );
}
