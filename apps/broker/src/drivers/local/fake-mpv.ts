// Box 0.28.2 tests: a stand-in for mpv (from the Venuebox desktop client's test/fake-mpv.ts).
// Takes mpv's arguments, opens --input-ipc-server and answers the JSON IPC. Appends its argv
// and each command to FAKE_MPV_LOG, so tests can check where the link went.
// Links: "...fail..." → end-file error (loading failed); "...short..." → ends (eof) after
// ~300 ms; otherwise plays a 120 s video, ticking time-pos every 50 ms.

import { createServer, type Socket } from "node:net";
import { appendFileSync } from "node:fs";

const log = (line: string) => process.env.FAKE_MPV_LOG && appendFileSync(process.env.FAKE_MPV_LOG, `${line}\n`);
log(`ARGV ${JSON.stringify(process.argv.slice(2))}`);

const pipe = process.argv.find((a) => a.startsWith("--input-ipc-server="))?.slice("--input-ipc-server=".length);
if (!pipe) process.exit(2);
const startArg = Number(process.argv.find((a) => a.startsWith("--start="))?.slice(8) ?? 0);

const observed = new Map<string, number>();
const props: Record<string, unknown> = { pause: false, "time-pos": null, duration: null, "paused-for-cache": false, "eof-reached": false, "idle-active": true };
let client: Socket | undefined;
let ticker: NodeJS.Timeout | undefined;

const send = (o: unknown) => client?.write(`${JSON.stringify(o)}\n`);
function set(name: string, value: unknown) {
  props[name] = value;
  const id = observed.get(name);
  if (id !== undefined) send({ event: "property-change", id, name, data: value });
}
function end(reason: string, fileError?: string) {
  if (ticker) clearInterval(ticker);
  send({ event: "end-file", reason, ...(fileError ? { file_error: fileError } : {}) });
  set("idle-active", true);
}

function play(url: string) {
  set("idle-active", false);
  setTimeout(() => {
    if (url.includes("fail")) return end("error", "loading failed");
    set("duration", 120);
    set("time-pos", startArg);
    send({ event: "file-loaded" });
    send({ event: "playback-restart" });
    ticker = setInterval(() => {
      if (props.pause) return;
      set("time-pos", Math.round(((props["time-pos"] as number) + 0.05) * 100) / 100);
    }, 50);
    if (url.includes("short")) setTimeout(() => end("eof"), 300);
  }, 60);
}

const server = createServer((sock) => {
  client = sock;
  sock.setEncoding("utf8");
  let buf = "";
  sock.on("data", (d: string) => {
    buf += d;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const { command, request_id } = JSON.parse(line) as { command: unknown[]; request_id: number };
      log(`CMD ${JSON.stringify(command)}`);
      const ok = (data?: unknown) => send({ request_id, error: "success", ...(data !== undefined ? { data } : {}) });
      const [name, ...args] = command as [string, ...unknown[]];
      if (name === "observe_property") {
        observed.set(args[1] as string, args[0] as number);
        ok();
        send({ event: "property-change", id: args[0], name: args[1], data: props[args[1] as string] });
      } else if (name === "set_property") {
        set(args[0] as string, args[1]);
        ok();
      } else if (name === "get_property") ok(props[args[0] as string]);
      else if (name === "loadfile") {
        ok();
        play(args[0] as string);
      } else if (name === "seek") {
        set("time-pos", args[0]);
        send({ event: "seek" });
        send({ event: "playback-restart" });
        ok();
      } else if (name === "quit") {
        ok();
        setTimeout(() => process.exit(0), 20);
      } else send({ request_id, error: "invalid parameter" });
    }
  });
});
server.listen(pipe);
setTimeout(() => process.exit(3), 60_000).unref(); // never outlive a test run
