import { checkTheme, type ThemeColors } from "@bargames/sdk";
import { useEffect, useState } from "react";
import { api, type Venue } from "../api";
import { useAction, useLoad } from "../useLoad";

const PATTERNS = ["{game}.{domain}", "{game}-{venue}.{domain}", "{game}.internal.{domain}", "{game}.{venue}.{domain}"];

export function VenuePage() {
  const view = useLoad(api.venue);
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
          {(Object.keys(v.theme.colors) as (keyof ThemeColors)[]).map((k) => (
            <label key={k} className="swatch">
              <input type="color" value={v.theme.colors[k]} onChange={(e) => setColor(k, e.target.value)} />
              {k}
            </label>
          ))}
        </div>
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
        <p className="muted">
          Landing page: <b>{view.data?.hosts.play}</b> · Admin: <b>{view.data?.hosts.admin}</b>
        </p>
        {(view.data?.warnings ?? []).map((w) => (
          <p key={w} className="warn">
            {w}
          </p>
        ))}
        {view.error && <p className="error">{view.error}</p>}
      </section>

      <div className="wide">
        <button className="primary big" disabled={busy} onClick={() => run(() => api.saveVenue(v))}>
          Save venue
        </button>
      </div>
    </div>
  );
}
