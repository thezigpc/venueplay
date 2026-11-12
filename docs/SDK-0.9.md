# SDK 0.9.0 + box: plan (decided 2026-11-12)

Everything is optional and additive; games on older SDKs keep working (rule: off a box the
SDK changes nothing). Built in this order; each step tested before the next.

| # | Feature | Depth | SDK | Box |
|---|---|---|---|---|
| A | Needs attention | built | `bg.setAttention(items)` | Tonight page lists them (games + box), link into the game's admin |
| B | TV health alerts | built | — | a TV offline > 10 min becomes a box attention item |
| C | Lobby countdown | built | `bg.startCountdown({ label, minutes, roomCode? })`, `bg.clearCountdown()`; client `countdownBanner(ctx)`, `activeCountdown(ctx)`; `VenueInfo.countdown` | idle screen + games list + phones show it; staff can start one |
| D | Results & leaderboards | built | `bg.reportResults({ roomCode, results: [{ player: { name, profileId? }, place?, score? }] })` (emits standard event `game_result`); `VenueInfo.leaderboards?` | core keeps tonight / all-time boards per game; games list + idle screen show "Tonight's winners"; admin Leaderboards card (reset) |
| E | Rewards hook | stub | — (fed by results) | `rewards.ts` no-op hook called on every result; admin "Rewards (coming soon)" |
| F | Player profiles | stub | types `PlayerProfile`; `bg.profile(req)` → undefined; client `venueProfile()` → null | `/internal/profiles/*` answers 501 "not built" |
| G | Audio outputs | stub | types `AudioOutput`; `bg.audioOutputs()` → []; `bg.playSound()` → `{ ok: false, reason: "not-built" }` | — |
| H | Media providers | built | manifest `media: { launch: [...] }`; commands `media_list` / `media_play` / `media_stop`; `status.media.targets`; `bg.tvs()` (incl. `youtubeScreenId` for apps launching "youtube"); `bg.launchApp(displayId, app)`; helpers `onMediaList/onMediaPlay/onMediaStop` | TVs page "YouTube list" picker on mapped TVs; Tonight "Start plan"; display content `external`; fast status polling while pending; Roku ECP launch (837), DIAL screenId (GET only, memory only) |
| I | Scenes + "Closing time" | built | — | saved per-TV actions (game room / app / media list / idle / off) + optional announcement + "end all rooms"; Apply on Tonight; built-in "Closing time" preset |
| J | Scheduled sessions | built | — | weekly schedule: game + TVs/group + time → creates the room, casts it, optional countdown/announcement |
| K | Mock box + check | built | mock answers attention, countdown, results, tvs/launchApp, profiles stub; `bargames check` warns before creating rooms on a non-mock target | — |

Media contract details (agreed with the YouTube session): `media_play { displayId?, itemId, takeBack }`
answers within ~3 s, `{ ok, launched?, pending? }`; displayId required for lists, ignored for plans;
target states `linked | starting | playing | paused | local | unlinked | error`; the box polls a
pending provider's status every 3 s for up to 60 s; `media_stop` = pause + clear, then the box
shows its idle screen (never on `local`); `launchApp` returns once the launch is accepted.
Startup choices: per-TV `{ mode: "media", gameId, itemId }`, box-wide "start plan X".

Deferred by the user: Tonight timeline (#9), staff roles (#14), "Play on this TV" movie search
(#12), content flags (#7), remote support / backups / fleet (#15-17).
