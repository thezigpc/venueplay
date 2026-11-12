// client/src/VenueExtras.tsx: the venue around the game (SDK 0.4.0), as React components.
// Both render nothing standalone, so a game off a box looks exactly as before (rule 1).
// `ctx` comes from useVenue() (snippets/useVenue.ts), which re-renders on changes.
//
//   <VenueAnnouncement ctx={venue} />   once, at the root of the phone app (not the TV view)
//   <BackToGames ctx={venue} />         at the bottom of the landing page only
//
// Games on the game kit: use <BackToGames /> and <VenueAnnouncement /> from
// "@bargames/gamekit/client" instead; they're the same components.

import { activeAnnouncement, ANNOUNCEMENT_HIDE_CSS, GAMES_LINK_CSS, gamesListUrl, otherGames, type VenueContext } from "@bargames/sdk/client";
import { useEffect, useState } from "react";

/** "← All games" back to the venue's games list, with "Also playing: …" under it. */
export function BackToGames({ ctx, label = "← All games", alsoPlaying = true }: { ctx: VenueContext | null; label?: string; alsoPlaying?: boolean }) {
  const url = gamesListUrl(ctx);
  if (!url) return null;
  const also = alsoPlaying ? otherGames(ctx) : [];
  return (
    <nav className="bargames-games-link" aria-label="Venue games">
      <style>{GAMES_LINK_CSS}</style>
      <a className="bg-all" href={url}>
        {label}
      </a>
      {also.length > 0 && (
        <p className="bg-also">
          Also playing:{" "}
          {also.map((g, i) => (
            <span key={g.id}>
              {i > 0 && " · "}
              <a href={g.url}>{g.displayName}</a>
            </span>
          ))}
        </p>
      )}
    </nav>
  );
}

const DISMISSED = "bargames.dismissed";

/**
 * The staff's announcement: a sticky strip at the top with a close button. It hides itself
 * on shared screens (SDK 0.5.0: pages marked by tableMode() or markSharedScreen()); on
 * SDK 0.4.0, pass `hidden` there instead. The box shows announcements on idle TVs itself.
 */
export function VenueAnnouncement({ ctx, hidden = false }: { ctx: VenueContext | null; hidden?: boolean }) {
  const [now, setNow] = useState(Date.now());
  const [dismissed, setDismissed] = useState(() => {
    try {
      return sessionStorage.getItem(DISMISSED) ?? "";
    } catch {
      return "";
    }
  });
  const a = activeAnnouncement(ctx, now);
  // Re-render when a timed announcement comes down.
  useEffect(() => {
    const until = a?.until ? Date.parse(a.until) - Date.now() : NaN;
    if (!(until > 0)) return;
    const t = setTimeout(() => setNow(Date.now()), Math.min(until + 50, 2 ** 31 - 1));
    return () => clearTimeout(t);
  }, [a?.id, a?.until]);
  if (hidden || !a || dismissed === a.id) return null;
  const dismiss = () => {
    try {
      sessionStorage.setItem(DISMISSED, a.id);
    } catch {
      /* storage blocked: dismissed until reload */
    }
    setDismissed(a.id);
  };
  return (
    <div
      role="status"
      className="bargames-announcement"
      style={{
        position: "sticky",
        top: 0,
        zIndex: 2147483646,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "10px 48px 10px 16px",
        background: "var(--venue-primary, #f2b33d)",
        color: "var(--venue-on-primary, #111)",
        font: "600 15px/1.4 var(--venue-font, system-ui, sans-serif)",
        textAlign: "center",
        boxShadow: "0 2px 8px rgba(0,0,0,.3)",
      }}
    >
      <style>{ANNOUNCEMENT_HIDE_CSS}</style>
      {a.text}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={dismiss}
        style={{ all: "unset", position: "absolute", right: 6, width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, cursor: "pointer" }}
      >
        ×
      </button>
    </div>
  );
}
