import type { BarGamesEvent, GameBranding, GameManifest, VenueContext, VenueTheme, WifiInfo } from "@bargames/sdk";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

export interface Venue {
  name: string;
  theme: VenueTheme;
  wifi?: WifiInfo;
  domain: string;
  hostnamePattern: string;
  playLabel: string;
  adminLabel: string;
  slug: string;
  publicScheme: "https" | "http";
  publicPort?: number;
}
export interface VenueView {
  venue: Venue;
  hosts: { play: string; admin: string };
  warnings: string[];
}
export interface Access {
  pinEnabled: boolean;
  pin: string;
  whitelist: { cidr: string; label?: string; expiresAt?: string }[];
  autoVenueIp: boolean;
  venueCidrs: string[];
  adminRemote: boolean;
}
export interface Game {
  id: string;
  manifest: GameManifest;
  source: { kind: string; ref: string };
  verified: boolean;
  enabled: boolean;
  branding: GameBranding;
  hostnameAlias?: string;
  host: string;
  context: VenueContext;
  state: string;
}
export interface Display {
  id: string;
  driver: string;
  name: string;
  label?: string;
  group?: string;
  model?: string;
  isTv?: boolean;
  delivery?: string;
  capabilities?: { delivery: string[]; power: boolean; inputs: string[] };
  health?: { online: boolean; powerMode?: string; detail?: string };
  content?: { kind: string; url?: string };
}

export interface CfZone {
  id: string;
  name: string;
  status: string;
  account: { id: string; name: string };
}
export interface CfHost {
  host: string;
  status: "ok" | "create" | "conflict";
  detail?: string;
}
export interface CfStatus {
  hasToken: boolean;
  tokenHint?: string;
  connected: boolean;
  account?: string;
  zone?: string;
  tunnel?: { id: string; name: string; status: string; connections: number };
  connector: string;
  lastSync?: { at: string; ok: boolean; hosts: CfHost[]; removed: string[]; errors: string[] };
}

export const api = {
  authStatus: () => call<{ setup: boolean; loggedIn: boolean; canSetup: boolean }>("GET", "/auth/status"),
  setup: (password: string) => call("POST", "/auth/setup", { password }),
  login: (password: string) => call("POST", "/auth/login", { password }),
  logout: () => call("POST", "/auth/logout"),
  system: () => call<{ version: string; runtime: string; broker: boolean }>("GET", "/system"),
  venue: () => call<VenueView>("GET", "/venue"),
  saveVenue: (v: Partial<Venue>) => call<VenueView>("PUT", "/venue", v),
  access: () => call<Access>("GET", "/access"),
  saveAccess: (a: Partial<Access>) => call<Access>("PUT", "/access", a),
  games: () => call<Game[]>("GET", "/games"),
  install: (url: string) => call<{ game: Game; upgraded: boolean; warnings: string[] }>("POST", "/games/install", { url }),
  patchGame: (id: string, patch: { enabled?: boolean; branding?: GameBranding; hostnameAlias?: string | null }) => call<Game>("PATCH", `/games/${id}`, patch),
  removeGame: (id: string) => call("DELETE", `/games/${id}`),
  events: () => call<BarGamesEvent[]>("GET", "/events/recent?limit=30"),
  displays: () => call<Display[]>("GET", "/broker/displays?health=1"),
  discover: () => call<{ found: number; errors: string[] }>("POST", "/broker/discover", {}),
  addRoku: (host: string) => call<Display>("POST", "/broker/displays/roku", { host }),
  patchDisplay: (id: string, patch: { label?: string; group?: string; delivery?: string }) => call<Display>("PATCH", `/broker/displays/${encodeURIComponent(id)}`, patch),
  power: (id: string, on: boolean) => call("POST", `/broker/displays/${encodeURIComponent(id)}/power`, { on }),
  cloudflare: () => call<CfStatus>("GET", "/cloudflare"),
  cloudflareToken: (token: string) => call<{ zones: CfZone[] }>("POST", "/cloudflare/token", { token }),
  cloudflareZones: () => call<CfZone[]>("GET", "/cloudflare/zones"),
  cloudflarePlan: (zoneId: string, hostnamePattern: string) => call<{ zone: CfZone; hosts: CfHost[]; warnings: string[] }>("POST", "/cloudflare/plan", { zoneId, hostnamePattern }),
  cloudflareConnect: (zoneId: string, hostnamePattern: string, adminRemote: boolean) => call<CfStatus>("POST", "/cloudflare/connect", { zoneId, hostnamePattern, adminRemote }),
  cloudflareSync: () => call("POST", "/cloudflare/sync"),
  cloudflareDisconnect: () => call("DELETE", "/cloudflare"),
  show: (target: { displayIds?: string[]; group?: string }, content: { kind: string; url?: string }) => call<Record<string, { ok: boolean; message?: string }>>("POST", "/broker/show", { ...target, content }),
};
