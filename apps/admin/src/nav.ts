// Where you are in the admin lives in the address (#tvs/roku%3AX1/remote), so the browser's
// Back button works and a page can be bookmarked. Four sections; Settings has sub-pages.

import { useEffect, useState } from "react";

export const SECTIONS = ["tonight", "tvs", "games", "settings"] as const;
export type Section = (typeof SECTIONS)[number];
export interface Route {
  section: Section;
  /** The parts after the section, decoded: ["venue"], [displayId, "remote"], ["cast", displayId]. */
  rest: string[];
}

/** Addresses from before the four sections (box ≤ 0.12): keep old bookmarks working. */
const OLD: Record<string, string> = {
  home: "tonight",
  rooms: "tonight",
  apps: "games",
  displays: "tvs",
  venue: "settings/venue",
  access: "settings/access",
  internet: "settings/internet",
  system: "settings/system",
};

const LAST = "bg-tab";

export function parseRoute(hash: string): Route | undefined {
  const raw = hash.replace(/^#\/?/, "");
  const path = OLD[raw] ?? raw;
  const [head, ...rest] = path.split("/").filter(Boolean);
  if (!SECTIONS.includes(head as Section)) return undefined;
  return {
    section: head as Section,
    rest: rest.map((p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        return p;
      }
    }),
  };
}

/** go("tvs", displayId, "remote") → #tvs/roku%3AX1/remote */
export function go(section: Section, ...rest: string[]): void {
  const next = [section, ...rest.map(encodeURIComponent)].join("/");
  if (window.location.hash !== `#${next}`) window.location.hash = next;
}

function current(): Route {
  const fromHash = parseRoute(window.location.hash);
  if (fromHash) return fromHash;
  try {
    const last = parseRoute(`#${localStorage.getItem(LAST) ?? ""}`);
    if (last) return { section: last.section, rest: [] };
  } catch {
    /* private mode */
  }
  return { section: "tonight", rest: [] };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(current);
  useEffect(() => {
    const onHash = () => setRoute(current());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(LAST, route.section);
    } catch {
      /* private mode */
    }
  }, [route.section]);
  return route;
}
