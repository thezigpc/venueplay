# Audio: playing sound on the box's speakers

**Who this is for:** a Claude Code session building an app or game that plays sound through
the venue's speakers, such as a music request app or game sound effects. Box 0.15.0 and
SDK 0.13.0 add this.

The venue sets up the speakers once, under **Settings → Connected devices**:

- **The box's own audio jack**, wired to an amplifier or powered speakers.
- **A screen plugged into the box** (HDMI or DisplayPort), which plays the sound.
- **Bluetooth speakers.** The venue pairs them on that page.
- **TVs over AirPlay.** This includes the Rokus and the Apple TV. It stops anything the box is
  casting to that TV while the sound plays.

The venue names each one, sets its volume and picks a **default**. Your app lists those
outputs and plays its own audio on one. You never pair Bluetooth, open sound devices or ask
for host access yourself: that's the box's job.

**Don't edit anything under `C:\CodeProjects\GameBroker`.** Platform needs go in your report
as "SDK requests".

## 1. The manifest

```jsonc
{
  "kind": "app",
  "audio": { "play": true },
  "sdk": { "version": "0.13.0", "level": 1 }
}
```

`audio.play` works for apps and games, but not integrations. Without it, every audio call
gets a 403 that says what to add. The Connected devices page lists the apps that declare it.

## 2. Serve the audio from your own server

The box plays **a path on your own server**, such as `/box-audio/12.mp3`. The box fetches it
from your container over the box's internal network, so you don't need a public URL. Your
app's address never leaves the box. Each request carries:

- `Authorization: Bearer <BG_GAME_TOKEN>`, which `bg.fromBox(req)` checks;
- `x-bargames-audio: 1`;
- a `Range` header. Answer it: Express's `res.sendFile` and `express.static` do.

Keep the route for the box only:

```ts
app.use("/box-audio", (req, res, next) => (bg.fromBox(req) ? next() : res.status(403).end()), express.static(path.join(dataDir, "music")));
```

**Formats:** MP3, AAC/M4A, FLAC, Ogg Vorbis/Opus and WAV, in any sample rate. The box
converts them. Serve a file, not an endless stream.

## 3. Play it

```ts
import { createBarGames } from "@bargames/sdk/server";
const bg = createBarGames();

const outputs = await bg.audio.outputs();
// [{ id: "box:0-0", name: "Bar amp", kind: "box", available: true, default: true, volume: 60 },
//  { id: "bt:11:22:33:44:55:66", name: "Patio speaker", kind: "bluetooth", ... },
//  { id: "tv:roku:abc", name: "Bar TV", kind: "tv", ... }]

const s = await bg.audio.play({
  path: "/box-audio/12.mp3",
  output: "bt:11:22:33:44:55:66",    // leave out for the venue's default
  title: "Song", artist: "Band", durationMs: 214000,
});

await bg.audio.pause(s.id);
await bg.audio.resume(s.id);
await bg.audio.setVolume(s.output, 40); // only while you play there; otherwise the venue's setting
await bg.audio.stop(s.id);

// Follow your sessions, e.g. to start the next song:
const unwatch = bg.audio.watch((sessions) => {
  const mine = sessions.find((x) => x.id === s.id);
  if (mine?.endReason === "finished") playNext();      // SDK 0.13.1; older boxes: mine?.state === "ended"
  if (mine?.state === "error") tellStaff(mine.message);   // plain words: "The speaker disconnected."
});
```

**Without `createBarGames`:** use `import { createAudio } from "@bargames/sdk/audio"`. It
gives the same object, reading `BG_CORE_URL` and `BG_GAME_TOKEN`.

**A short sound:** use `bg.playSound("/sounds/ding.mp3", { outputId })`. It never throws and
returns `{ ok, reason, sessionId }`. `reason` is one of:

| `reason` | Meaning |
|---|---|
| `"standalone"` | Not on a box |
| `"not-allowed"` | The manifest doesn't declare `audio.play` |
| `"busy"` | Another app is playing on that output |
| `"error"` | Anything else |

### Sessions

- **One session per output.** Playing on an output replaces whatever is on it.
- **Another app's output:** if another app is playing there, `play` answers **409**, naming
  that app. Pass `replace: true` to take the output over, but only when staff asked for it.
- **States:** `starting` → `playing` ⇄ `paused` → `ended`, or `error`.
- **`endReason`** (SDK 0.13.1, box 0.15.4): why it ended, for code: `finished` (played to
  the end), `stopped` (an app or staff stopped it, or the box restarted), `replaced`
  (something else started on that output), `disconnected` (the speaker or TV went away) or
  `error`. A queue moves on after `finished`. Older boxes leave it out: fall back to `state`.
- **`message`:** an ended or failed session says why, for example "The app's audio file
  wasn't found.", "The speaker disconnected." or "Replaced by something else on Bar amp.".
  Show it to staff.
- **Finished sessions** stay listed for about a minute, so a poller doesn't miss the end.
- **`positionMs`:** it counts what has been sent to the output. Speakers play it a moment
  later: about 1 s for the box and Bluetooth, and 2 s or so over AirPlay.

### Off a box

`bg.audio.onBox` is false, and every `bg.audio` call rejects with `AudioUnavailable`.
`audioOutputs()` returns `[]`. Keep your own fallback for standalone use, for example a
browser "speaker page" on a PC wired to the sound system.

## 4. Developing without a box

```bash
npx bargames mock-box .        # with "audio": { "play": true } in bargames.json
```

The mock box has three pretend outputs: a box jack (the default), a Bluetooth speaker and an
AirPlay TV. When you play:

- **The file:** it **fetches your path the way the real box does**, with the token and the
  header, so a broken route or a refusing `fromBox` check shows up as an `error` session.
- **Timing:** it "plays" in real time, for `durationMs` or 30 s if you don't give one, so
  `watch()` sees the session end.
- **The log:** it prints every play, pause, stop and volume change.

## 5. Rules

- **Play your own audio, from your own server.** Don't hand the box URLs on the internet.
- **Respect the venue's outputs.**
  - Use the default unless staff picked another output in your app.
  - Don't take over another app's output without staff asking.
  - Don't change the volume except while you're playing there.
- **Licensing is the venue's.** Playing music in public needs the right licences. Don't claim
  your app takes care of them.
