import { MANIFEST_FILE, validateManifest, type GameManifest } from "@bargames/sdk";

/**
 * Turns what a venue pastes into the manifest URL to fetch:
 *   https://github.com/owner/repo                → raw …/HEAD/bargames.json
 *   https://github.com/owner/repo/tree/v1.2      → raw …/v1.2/bargames.json
 *   https://example.com/games/pool/bargames.json → as is
 *   https://example.com/games/pool               → …/pool/bargames.json
 */
export function resolveManifestUrl(input: string): string {
  const url = new URL(input.trim());
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("manifest URLs must use https");
  }
  if (url.hostname === "github.com") {
    const [owner, repo, kind, ref, ...rest] = url.pathname.split("/").filter(Boolean);
    if (!owner || !repo) throw new Error("GitHub URL must include owner and repo");
    const branch = kind === "tree" || kind === "blob" ? ref : "HEAD";
    const sub = kind === "tree" ? rest.join("/") : "";
    const file = kind === "blob" ? rest.join("/") : [sub, MANIFEST_FILE].filter(Boolean).join("/");
    return `https://raw.githubusercontent.com/${owner}/${repo.replace(/\.git$/, "")}/${branch}/${file}`;
  }
  if (url.pathname.endsWith(".json")) return url.toString();
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${MANIFEST_FILE}`;
  return url.toString();
}

export async function fetchManifest(input: string, doFetch: typeof fetch = fetch): Promise<{ manifest: GameManifest; warnings: string[]; url: string }> {
  const url = resolveManifestUrl(input);
  // raw.githubusercontent.com caches files ~5 minutes per edge (query strings don't bust
  // it), so a release pushed a minute ago can still read as the old version. GitHub's API
  // serves the current file; fall back to raw when it's unavailable or rate-limited
  // (60 anonymous requests an hour per box is plenty for update checks).
  const res = (await fromGithubApi(url, doFetch)) ?? (await doFetch(url, { signal: AbortSignal.timeout(10_000), redirect: "follow" }));
  if (!res.ok) throw new Error(`could not fetch ${url}: HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > 256 * 1024) throw new Error("manifest is too large");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${url} is not valid JSON`);
  }
  const result = validateManifest(json);
  if (!result.ok) throw new Error(`invalid manifest: ${result.errors.join("; ")}`);
  return { manifest: result.manifest, warnings: result.warnings, url };
}

// TODO(phase 2b): market catalogs: fetch catalog.json + detached signature, verify with the
// pinned market public key (ed25519), then install entries with verified: true.

/** raw.githubusercontent.com/<owner>/<repo>/<ref>/<path> → the same file through GitHub's API (uncached). */
export function githubApiUrl(rawUrl: string): string | undefined {
  const u = new URL(rawUrl);
  if (u.hostname !== "raw.githubusercontent.com") return undefined;
  const [owner, repo, ref, ...rest] = u.pathname.split("/").filter(Boolean);
  if (!owner || !repo || !ref || !rest.length) return undefined;
  const api = new URL(`https://api.github.com/repos/${owner}/${repo}/contents/${rest.join("/")}`);
  if (ref !== "HEAD") api.searchParams.set("ref", ref);
  return api.toString();
}

async function fromGithubApi(rawUrl: string, doFetch: typeof fetch): Promise<Response | undefined> {
  const api = githubApiUrl(rawUrl);
  if (!api) return undefined;
  try {
    const r = await doFetch(api, { signal: AbortSignal.timeout(10_000), headers: { accept: "application/vnd.github.raw+json", "user-agent": "bargames-box" } });
    return r.ok ? r : undefined;
  } catch {
    return undefined;
  }
}
