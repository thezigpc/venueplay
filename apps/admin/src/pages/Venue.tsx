import { checkTheme, isApp, onPrimary, type ThemeColors } from "@bargames/sdk";
import { useEffect, useState } from "react";
import { api, type Venue } from "../api";

const BASE_COLORS = ["background", "surface", "text", "primary", "accent"] as const;

interface Place {
  name: string;
  admin1?: string;
  country_code?: string;
  latitude: number;
  longitude: number;
  timezone?: string;
}

/** Look a place up by name (Open-Meteo's free geocoder, from this browser; nothing is stored there). */
async function findPlaces(q: string): Promise<Place[]> {
  const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=5&language=en&format=json&name=${encodeURIComponent(q)}`);
  if (!r.ok) throw new Error(`lookup failed (HTTP ${r.status})`);
  return ((await r.json()) as { results?: Place[] }).results ?? [];
}
import { useAction, useLoad } from "../useLoad";

const PATTERNS = ["{game}.{domain}", "{game}-{venue}.{domain}", "{game}.internal.{domain}", "{game}.{venue}.{domain}"];

export function VenuePage() {
  const view = useLoad(api.venue);
  const games = useLoad(api.games);
  const [query, setQuery] = useState("");
  const [places, setPlaces] = useState<Place[] | undefined>();
  const [placeError, setPlaceError] = useState("");
  const { busy, run } = useAction(view.reload, view.setError);
  const [v, setV] = useState<Venue | undefined>();
  useEffect(() => setV(view.data?.venue), [view.data]);
  if (!v) return <div className="card">{view.error || "Loading…"}</div>;

  const set = <K extends keyof Venue>(k: K, val: Venue[K]) => setV({ ...v, [k]: val });
  const setColor = (k: keyof ThemeColors, val: string) => setV({ ...v, theme: { ...v.theme, colors: { ...v.theme.colors, [k]: val } } });
  const liveWarnings = checkTheme(v.theme);

  return (
    <div className="grid">
      <section className="card">
        <h2>Venue</h2>
        <label>
          Name
          <input value={v.name} onChange={(e) => set("name", e.target.value)} />
        </label>
        <label>
          Name shown in this admin (top-left, sign-in screen, browser tab)
          <input value={v.adminTitle ?? ""} maxLength={24} placeholder="Bar Games" onChange={(e) => set("adminTitle", e.target.value)} />
        </label>
        <label>
          Short name (for {"{venue}"} in hostnames)
          <input value={v.slug} onChange={(e) => set("slug", e.target.value.toLowerCase())} />
        </label>
        <label>
          Logo URL
          <input value={v.theme.logoUrl ?? ""} onChange={(e) => setV({ ...v, theme: { ...v.theme, logoUrl: e.target.value || undefined } })} />
        </label>
        <label>
          Wi-Fi name (shown on the "join the Wi-Fi" page and placards)
          <input value={v.wifi?.ssid ?? ""} onChange={(e) => set("wifi", e.target.value ? { ...v.wifi, ssid: e.target.value } : undefined)} />
        </label>
        <label>
          Wi-Fi password (for the placard QR)
          <input value={v.wifi?.password ?? ""} onChange={(e) => v.wifi && set("wifi", { ...v.wifi, password: e.target.value || undefined })} />
        </label>
      </section>

      <section className="card">
        <h2>Colors</h2>
        <div className="swatches">
          {BASE_COLORS.map((k) => (
            <label key={k} className="swatch">
              <input type="color" value={v.theme.colors[k]} onChange={(e) => setColor(k, e.target.value)} />
              {k}
            </label>
          ))}
          <label className="swatch">
            <input type="color" value={onPrimary(v.theme.colors)} onChange={(e) => setColor("onPrimary", e.target.value)} />
            text on primary
          </label>
        </div>
        <p className="muted">
          Text on primary: {v.theme.colors.onPrimary ? "your pick" : "automatic (dark or light, whichever reads better)"}
          {v.theme.colors.onPrimary && (
            <>
              {" "}
              <button
                className="ghost"
                onClick={() => {
                  const { onPrimary: _drop, ...rest } = v.theme.colors;
                  setV({ ...v, theme: { ...v.theme, colors: rest as ThemeColors } });
                }}
              >
                Back to automatic
              </button>
            </>
          )}
        </p>
        <div style={{ background: v.theme.colors.primary, color: onPrimary(v.theme.colors), padding: "8px 12px", borderRadius: 8, fontWeight: 700 }}>Last call at 1:30</div>
        <div className="preview" style={{ background: v.theme.colors.background, color: v.theme.colors.text }}>
          <div style={{ background: v.theme.colors.surface, padding: 12, borderRadius: 8 }}>
            <b style={{ color: v.theme.colors.primary }}>{v.name}</b> <span style={{ color: v.theme.colors.accent }}>Bingo tonight</span>
            <p>How text looks on the TVs.</p>
          </div>
        </div>
        {liveWarnings.map((w) => (
          <p key={w} className="warn">
            {w}
          </p>
        ))}
      </section>

      <section className="card">
        <h2>Location and TVs</h2>
        <p className="muted">Menus use this for the weather and the time. Games get it too.</p>
        <label>
          Find a place
          <span className="inline">
            <input value={query} placeholder="City or ZIP code" onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.currentTarget.nextElementSibling as HTMLButtonElement | null)?.click()} />
            <button
              disabled={!query.trim()}
              onClick={() => {
                setPlaceError("");
                findPlaces(query.trim()).then(setPlaces, (e: Error) => setPlaceError(e.message));
              }}
            >
              Search
            </button>
          </span>
        </label>
        {placeError && <p className="error">{placeError}</p>}
        {places && !places.length && <p className="muted">Nothing found.</p>}
        {places?.map((p) => (
          <button
            key={`${p.latitude},${p.longitude}`}
            className="ghost"
            style={{ display: "block" }}
            onClick={() => {
              const label = [p.name, p.admin1].filter(Boolean).join(", ");
              setV({ ...v, location: { latitude: p.latitude, longitude: p.longitude, label }, timezone: p.timezone ?? v.timezone });
              setPlaces(undefined);
            }}
          >
            {[p.name, p.admin1, p.country_code].filter(Boolean).join(", ")}
          </button>
        ))}
        <p className="muted">
          {v.location ? (
            <>
              Venue location: <b>{v.location.label || `${v.location.latitude.toFixed(3)}, ${v.location.longitude.toFixed(3)}`}</b>{" "}
              <button className="ghost" onClick={() => set("location", null)}>
                Clear
              </button>
            </>
          ) : (
            "No location set."
          )}
        </p>
        <label>
          Time zone
          <span className="inline">
            <input value={v.timezone ?? ""} placeholder="America/New_York" onChange={(e) => set("timezone", e.target.value.trim() || null)} />
            <button onClick={() => set("timezone", Intl.DateTimeFormat().resolvedOptions().timeZone)}>Use this iPad's</button>
          </span>
        </label>
        <label>
          Units
          <select value={v.units ?? "imperial"} onChange={(e) => set("units", e.target.value as "imperial" | "metric")}>
            <option value="imperial">°F, miles</option>
            <option value="metric">°C, km</option>
          </select>
        </label>
        <label>
          Idle TVs show
          <select value={v.idleModule ?? ""} onChange={(e) => set("idleModule", e.target.value || null)}>
            <option value="">The box's idle screen (games, Wi-Fi, join QR)</option>
            {(games.data ?? [])
              .filter((g) => isApp(g.manifest))
              .map((g) => (
                <option key={g.id} value={g.id} disabled={!g.enabled}>
                  {g.context.game.displayName}
                  {g.enabled ? "" : " (turned off)"}
                </option>
              ))}
          </select>
        </label>
        <p className="muted">A TV goes back to this when its game room closes.</p>
      </section>

      <section className="card">
        <h2>Addresses</h2>
        <label>
          Domain (your Cloudflare zone)
          <input value={v.domain} onChange={(e) => set("domain", e.target.value.toLowerCase())} />
        </label>
        <label>
          Hostname pattern
          <select value={PATTERNS.includes(v.hostnamePattern) ? v.hostnamePattern : "custom"} onChange={(e) => e.target.value !== "custom" && set("hostnamePattern", e.target.value)}>
            {PATTERNS.map((p) => (
              <option key={p}>{p}</option>
            ))}
            <option value="custom">Custom…</option>
          </select>
        </label>
        <input value={v.hostnamePattern} onChange={(e) => set("hostnamePattern", e.target.value)} />
        <label className="check">
          <input
            type="checkbox"
            checked={Boolean(v.adminOwnHost)}
            onChange={(e) => {
              const on = e.target.checked;
              // Suggest "<games list name>-admin": one level deep, so the free certificate covers it.
              const label = on && v.adminLabel === "admin" && v.playLabel !== "play" ? `${v.playLabel}-admin` : v.adminLabel;
              setV({ ...v, adminOwnHost: on, adminLabel: label });
            }}
          />
          Give the admin its own hostname (recommended)
          <small className="muted">
            Off: the admin is at /admin on the games list's address, with no extra DNS record. On: it gets its own hostname, so no game page can act as signed-in staff (browsers keep hostnames apart, not paths).
          </small>
        </label>
        {v.adminOwnHost && (
          <label>
            Admin hostname name
            <input value={v.adminLabel} onChange={(e) => set("adminLabel", e.target.value.toLowerCase())} autoCapitalize="none" placeholder={`${v.playLabel}-admin`} />
          </label>
        )}
        <p className="muted">
          Landing page: <b>{view.data?.hosts.play}</b> · Admin: <b>{view.data?.hosts.admin}</b>
        </p>
        <p className="muted">
          <small>Moving the admin signs you out here: sign in again at its new address.</small>
        </p>
        {(view.data?.warnings ?? []).map((w) => (
          <p key={w} className="warn">
            {w}
          </p>
        ))}
        {view.error && <p className="error">{view.error}</p>}
      </section>

      <div className="wide">
        <button className="primary big" disabled={busy} onClick={() => run(() => api.saveVenue(v).then(() => void window.dispatchEvent(new Event("bg-venue-saved"))))}>
          Save venue
        </button>
      </div>
    </div>
  );
}
