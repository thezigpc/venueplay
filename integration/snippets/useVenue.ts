// client/src/useVenue.ts: venue branding for the React client.
// Call useVenue() once near the root (e.g. in App or main layout).
//
// Off a box this never changes anything: watchVenue() doesn't fire for standalone
// games and applyTheme() ignores standalone contexts, so the CSS fallbacks apply.

import { applyTheme, watchVenue, type VenueContext } from "@bargames/sdk/client";
import { useEffect, useState } from "react";
import { serverUrl } from "./socket"; // ← wherever the client already gets the server origin

let current: VenueContext | null = null;

export function useVenue(): VenueContext | null {
  const [ctx, setCtx] = useState<VenueContext | null>(current);
  useEffect(
    () =>
      watchVenue(
        (c) => {
          current = c;
          applyTheme(c); // sets --venue-* on <html>
          setCtx(c);
        },
        { base: serverUrl || undefined }, // needed when the client runs on Vite's port in dev
      ),
    [],
  );
  return ctx;
}
