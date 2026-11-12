// STUB (planned, SDK 0.9.0): rewards. Every recorded game result passes through here, so a
// venue's reward rules ("a free drink for a bingo", points toward a prize, a Clover tie-in)
// can be added later without touching games. Today it does nothing.

import type { Logger } from "@bargames/common";
import type { ResultEntry } from "./leaderboard.js";

export function rewardsHook(log: Logger): (entry: ResultEntry) => void {
  return (entry) => {
    log.debug("rewards", "result seen (rewards not built yet)", { game: entry.gameId, players: entry.results.length });
  };
}
