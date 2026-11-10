// Development seed: sets the admin password (first run), installs hello-game pointing
// at the local dev server, and turns it on. Run after `npm run dev` is up.
//   npm run seed:dev
// Then open http://admin.localhost:7080 (admin) or http://play.localhost:7080 (landing page).

import { readFileSync } from "node:fs";

const core = process.env.CORE_URL ?? "http://127.0.0.1:7100";
const password = process.env.BG_DEV_PASSWORD ?? "devpassword";

async function call(method, path, body, cookie) {
  const res = await fetch(core + path, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return { res, data: text ? JSON.parse(text) : {} };
}

const status = (await call("GET", "/api/auth/status")).data;
const auth = await call("POST", status.setup ? "/api/auth/login" : "/api/auth/setup", { password });
const cookie = auth.res.headers.get("set-cookie").split(";")[0];

const manifest = JSON.parse(readFileSync(new URL("../examples/hello-game/bargames.json", import.meta.url), "utf8"));
await call("POST", "/api/games/install", { manifest, devTarget: "http://127.0.0.1:7300" }, cookie);
await call("PATCH", "/api/games/hello", { enabled: true, branding: { displayName: "Hello Game Night", tagline: "The reference game" } }, cookie);

console.log(`Seeded. Admin password: ${password}`);
console.log("  Admin:   http://admin.localhost:7080   (or http://localhost:5173 with Vite)");
console.log("  Landing: http://play.localhost:7080");
console.log("  Game:    http://hello.localhost:7080");
