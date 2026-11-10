import { createLogger, JsonStore } from "@bargames/common";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CloudflareApi, type CfDnsRecord } from "./cloudflare/api.js";
import { CloudflareService, planHosts, type CloudflareSettings } from "./cloudflare/service.js";
import { NoopRuntime } from "./runtime/types.js";

const TOKEN = "t".repeat(40);

/** In-memory Cloudflare: one account, one zone, tunnels, DNS. */
function fakeCloudflare() {
  const zone = { id: "z1", name: "kavabar.com", status: "active", account: { id: "a1", name: "Kava Bar" } };
  const tunnels: { id: string; name: string; ingress?: unknown; deleted?: boolean }[] = [];
  let records: CfDnsRecord[] = [{ id: "r0", type: "A", name: "www.kavabar.com", content: "192.0.2.1" }];
  let n = 1;
  const ok = (result: unknown, status = 200) =>
    new Response(JSON.stringify({ success: true, errors: [], result, result_info: { page: 1, total_pages: 1 } }), { status });
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const p = url.pathname.replace("/client/v4", "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if ((init?.headers as Record<string, string>).authorization !== `Bearer ${TOKEN}`)
      return new Response(JSON.stringify({ success: false, errors: [{ code: 1000, message: "Invalid API Token" }] }), { status: 401 });
    if (p === "/zones") return ok([zone]);
    if (p === "/accounts/a1/cfd_tunnel" && method === "GET") return ok(tunnels.filter((t) => !t.deleted && t.name === url.searchParams.get("name")));
    if (p === "/accounts/a1/cfd_tunnel" && method === "POST") {
      const t = { id: `tun${n++}`, name: body.name };
      tunnels.push(t);
      return ok(t);
    }
    let m = /^\/accounts\/a1\/cfd_tunnel\/([^/]+)(\/token|\/configurations)?$/.exec(p);
    if (m) {
      const t = tunnels.find((x) => x.id === m![1])!;
      if (m[2] === "/token") return ok(`tunnel-token-${t.id}`);
      if (m[2] === "/configurations") return (t.ingress = body.config.ingress), ok({});
      if (method === "DELETE") return (t.deleted = true), ok({});
      return ok({ ...t, status: "healthy", connections: [{}, {}] });
    }
    if (p === "/zones/z1/dns_records" && method === "GET") return ok(records);
    if (p === "/zones/z1/dns_records" && method === "POST") {
      const r = { id: `r${n++}`, ...body };
      records.push(r);
      return ok(r);
    }
    m = /^\/zones\/z1\/dns_records\/(.+)$/.exec(p);
    if (m && method === "DELETE") return (records = records.filter((r) => r.id !== m![1])), ok({});
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { fetchFn, tunnels, records: () => records };
}

test("cloudflare: plan flags conflicts and names outside the zone", () => {
  const records: CfDnsRecord[] = [
    { id: "1", type: "A", name: "admin.kavabar.com", content: "192.0.2.1" },
    { id: "2", type: "CNAME", name: "play.kavabar.com", content: "abc.cfargotunnel.com" },
  ];
  const plan = planHosts(["admin.kavabar.com", "play.kavabar.com", "pool.kavabar.com", "pool.other.com"], "kavabar.com", records, "abc");
  assert.deepEqual(
    plan.map((p) => p.status),
    ["conflict", "ok", "create", "conflict"],
  );
});

test("cloudflare: token check, connect, sync on host changes, disconnect", async () => {
  const cf = fakeCloudflare();
  const dir = mkdtempSync(path.join(tmpdir(), "bg-cf-"));
  const store = new JsonStore<CloudflareSettings>(path.join(dir, "cloudflare.json"), {}, 0o600);
  const connector = new NoopRuntime();
  let hosts = ["admin.kavabar.com", "play.kavabar.com", "bingo.kavabar.com"];
  const svc = new CloudflareService({
    store,
    connector,
    desiredHosts: () => hosts,
    tunnelName: () => "bargames-kava-abc123",
    origin: "http://bargames-gateway:7080",
    log: createLogger("t", "error"),
    fetch: cf.fetchFn,
  });

  await assert.rejects(svc.saveToken("x".repeat(40)), /invalid or was revoked/);
  await assert.rejects(svc.saveToken("not a token!"), /doesn't look like/);
  assert.equal((await svc.saveToken(` ${TOKEN} `)).length, 1);

  const plan = await svc.plan("z1", hosts);
  assert.ok(plan.every((p) => p.status === "create"));

  const status = await svc.connect("z1");
  assert.equal(status.connected, true);
  assert.equal(status.connector, "running");
  assert.equal(status.tunnel?.status, "healthy");
  assert.equal(status.lastSync?.ok, true);
  const ours = () => cf.records().filter((r) => r.content === "tun1.cfargotunnel.com").map((r) => r.name).sort();
  assert.deepEqual(ours(), [...hosts].sort());
  assert.equal((cf.tunnels[0].ingress as unknown[]).length, hosts.length + 1, "routes + catch-all 404");
  if (process.platform !== "win32") assert.equal(statSync(store.file).mode & 0o777, 0o600);

  // Re-running connect reuses the tunnel instead of making a second one.
  await svc.connect("z1");
  assert.equal(cf.tunnels.length, 1);

  // A game is renamed: the new name is added, the old record (ours) removed; www untouched.
  hosts = ["admin.kavabar.com", "play.kavabar.com", "kavabingo.kavabar.com"];
  const report = await svc.sync();
  assert.deepEqual(report.removed, ["bingo.kavabar.com"]);
  assert.deepEqual(ours(), [...hosts].sort());
  assert.ok(cf.records().some((r) => r.name === "www.kavabar.com"));

  const off = await svc.disconnect();
  assert.deepEqual(off.errors, []);
  assert.deepEqual(ours(), []);
  assert.ok(cf.records().some((r) => r.name === "www.kavabar.com"), "never touches records that aren't ours");
  assert.equal(cf.tunnels[0].deleted, true);
  assert.equal(await connector.tunnelState(), "missing");
  assert.equal((await svc.status()).hasToken, true, "keeps the API token for reconnecting");
});

test("cloudflare: api error hints", async () => {
  const api = new CloudflareApi(TOKEN, (async () =>
    new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }), { status: 403 })) as typeof fetch);
  await assert.rejects(api.createTunnel("a1", "x"), /Cloudflare Tunnel › Edit/);
});
