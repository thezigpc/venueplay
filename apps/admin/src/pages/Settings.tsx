// Settings: a hub of rows that each say where things stand, so staff open only what needs
// them. The pages behind the rows are the ones that used to be tabs.

import { api } from "../api";
import { go } from "../nav";
import { useLoad } from "../useLoad";
import { AccessPage } from "./Access";
import { DevicesPage } from "./Devices";
import { InternetPage } from "./Internet";
import { SchedulesCard } from "./Scenes";
import { SmartHomePage } from "./SmartHome";
import { SystemPage } from "./System";
import { VenuePage } from "./Venue";
import { WifiPage, wifiSummary } from "./Wifi";

const PAGES: Record<string, string> = {
  venue: "Venue",
  access: "Who can play",
  internet: "Internet address",
  wifi: "Box Wi-Fi",
  system: "Box and updates",
  schedules: "Schedules",
  "smart-home": "Smart home",
  devices: "Connected devices",
};

export function SettingsPage({ page }: { page?: string }) {
  if (page && PAGES[page]) {
    return (
      <div>
        <div className="page-head">
          <button type="button" className="back" onClick={() => go("settings")}>
            <Chevron left /> Settings
          </button>
          <h1>{PAGES[page]}</h1>
        </div>
        {page === "venue" && <VenuePage />}
        {page === "access" && <AccessPage />}
        {page === "internet" && <InternetPage />}
        {page === "wifi" && <WifiPage />}
        {page === "system" && <SystemPage />}
        {page === "schedules" && <SchedulesPage />}
        {page === "smart-home" && <SmartHomePage />}
        {page === "devices" && <DevicesPage />}
      </div>
    );
  }
  return <Hub />;
}

function Hub() {
  const venue = useLoad(api.venue);
  const access = useLoad(api.access);
  const cast = useLoad(api.castSettings);
  const cf = useLoad(api.cloudflare, 30_000);
  const stats = useLoad(api.systemStats, 30_000);
  const schedules = useLoad(api.schedules);
  const wifi = useLoad(api.wifi, 30_000);
  const integrations = useLoad(api.integrations, 30_000);
  const audio = useLoad(api.audio, 30_000);

  const v = venue.data;
  const a = access.data;
  const s = stats.data;
  const updateReady = Boolean(s?.box.latest && s.box.version !== "dev" && s.box.latest !== s.box.version);
  const lastFailed = s?.update?.lastExit !== undefined && s.update.lastExit !== 0;
  const cfBad = Boolean(cf.data?.connected && cf.data.lastSync && !cf.data.lastSync.ok);
  const on = (schedules.data?.schedules ?? []).filter((x) => x.enabled);
  const ints = integrations.data?.integrations ?? [];
  const intsOn = ints.filter((x) => x.enabled);
  const smartWarn = intsOn.some((x) => x.needsApproval.length || x.report?.state === "error" || x.report?.state === "warn");
  const au = audio.data;
  const defaultOut = au?.outputs.find((o) => o.default);
  const speakers = au?.outputs.filter((o) => o.kind === "bluetooth").length ?? 0;
  const playing = au?.outputs.filter((o) => o.session && ["starting", "playing", "paused"].includes(o.session.state)).length ?? 0;
  const devicesSummary = !au ? audio.error || "…" : !au.available ? "No sound outputs on this box" : [defaultOut ? `Sound to ${defaultOut.label || defaultOut.name}` : "No default output", au.bluetooth ? (speakers ? `${speakers} Bluetooth speaker${speakers === 1 ? "" : "s"}` : "no Bluetooth speakers yet") : "", playing ? `playing on ${playing}` : ""].filter(Boolean).join(" · ");
  const smartSummary = !ints.length ? "Alexa, Google Home, Apple Home, Home Assistant: not connected" : intsOn.length ? intsOn.map((x) => `${x.name}${x.report?.state === "setup" ? " (waiting for setup)" : x.report?.state === "error" ? " (not working)" : ""}`).join(" · ") : `${ints.length} added, all off`;

  return (
    <div>
      <div className="page-head">
        <h1>Settings</h1>
      </div>
      <div className="hub">
        <Row to="venue" title="Venue" detail={v ? [v.venue.name, v.venue.wifi?.ssid ? `Wi-Fi ${v.venue.wifi.ssid}` : "no Wi-Fi QR", v.venue.idleModule ? "idle TVs show an app" : "idle TVs show the box's screen"].join(" · ") : venue.error || "…"} />
        <Row
          to="access"
          title="Who can play"
          detail={a ? [a.open ? "Open to anyone" : a.autoVenueIp || a.venueCidrs.length ? "Venue Wi-Fi only" : "Local network only", a.pinEnabled ? "venue PIN on" : "venue PIN off", cast.data ? (cast.data.pin ? "TV PIN on" : "TV PIN off") : ""].filter(Boolean).join(" · ") : access.error || "…"}
        />
        <Row
          to="internet"
          title="Internet address"
          level={cfBad ? "warn" : undefined}
          dot={cf.data ? (cf.data.connected ? (cfBad ? "warn" : "on") : "off") : undefined}
          detail={cf.data ? (cf.data.connected ? `${cfBad ? "Problem syncing" : "Online"} at ${v?.hosts.play ?? cf.data.zone ?? "your domain"}` : "Not online: only this network can reach the games") : cf.error || "…"}
        />
        <Row
          to="wifi"
          title="Box Wi-Fi"
          level={wifi.data?.status?.apply && !wifi.data.status.apply.ok ? "warn" : undefined}
          detail={wifi.error || wifiSummary(wifi.data)}
        />
        <Row
          to="system"
          title="Box and updates"
          level={updateReady || lastFailed ? "warn" : undefined}
          badge={updateReady ? "1" : undefined}
          detail={s ? (s.update?.running ? "Updating…" : updateReady ? `Update ready: ${s.box.version} to ${s.box.latest}` : lastFailed ? `Last update failed (still on ${s.box.version})` : `Bar Games ${s.box.version} · up to date`) : stats.error || "…"}
        />
        <Row
          to="schedules"
          title="Schedules"
          detail={schedules.data ? (on.length ? `${on.length} on: ${on.slice(0, 2).map((x) => `${x.title ?? (x.kind === "scene" ? "a scene" : "a game")} at ${x.time}`).join(" · ")}` : "None: start a game or scene by the clock") : schedules.error || "…"}
        />
        <Row
          to="smart-home"
          title="Smart home"
          level={smartWarn ? "warn" : undefined}
          detail={integrations.data ? smartSummary : integrations.error || "…"}
        />
        <Row to="devices" title="Connected devices" level={au?.bluetooth && !au.bluetooth.available ? "warn" : undefined} detail={devicesSummary} />
        <button type="button" className="hub-logout" onClick={() => void api.logout().then(() => window.location.reload())}>
          Log out
        </button>
      </div>
    </div>
  );
}

function Row({ to, title, detail, level, badge, dot }: { to: string; title: string; detail: string; level?: "warn"; badge?: string; dot?: "on" | "off" | "warn" }) {
  return (
    <button type="button" className={`hub-row${level ? ` ${level}` : ""}`} onClick={() => go("settings", to)}>
      <span className="hub-text">
        <b>{title}</b>
        <span>
          {dot && <span className={`dot ${dot}`} />} {detail}
        </span>
      </span>
      {badge ? <span className="hub-badge">{badge}</span> : <Chevron />}
    </button>
  );
}

function SchedulesPage() {
  const games = useLoad(api.games);
  const displays = useLoad(api.displays);
  return (
    <div className="grid">
      <SchedulesCard games={games.data ?? []} displays={displays.data ?? []} />
    </div>
  );
}

export function Chevron({ left = false }: { left?: boolean }) {
  return (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d={left ? "M15 5l-7 7 7 7" : "M9 5l7 7-7 7"} />
    </svg>
  );
}
