import { useEffect, useState } from "react";
import type { FriendPresenceItem, FriendPresenceResponse } from "../../../shared";
import { apiFetch } from "../api/client";

const DAY_MS = 24 * 60 * 60 * 1_000;

export function lastActiveLabel(presence: FriendPresenceItem | undefined, now: number): string | null {
  if (!presence || presence.isOnline || !presence.lastActiveAt) return null;
  const elapsed = now - new Date(presence.lastActiveAt).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= DAY_MS) return null;
  if (elapsed < 60_000) return "1m ago";
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  return `${Math.floor(elapsed / (60 * 60_000))}h ago`;
}

export function useFriendPresence(friendIds: string[], enabled = true) {
  const [items, setItems] = useState<Record<string, FriendPresenceItem>>({});
  const [now, setNow] = useState(() => Date.now());
  const idsKey = friendIds.join(",");

  useEffect(() => {
    if (!enabled || !idsKey) {
      setItems({});
      return;
    }
    let active = true;
    let latestRequest = 0;
    const ids = idsKey.split(",");
    const refresh = () => {
      const request = ++latestRequest;
      void Promise.all(Array.from({ length: Math.ceil(ids.length / 50) }, (_, index) => {
        const chunk = ids.slice(index * 50, (index + 1) * 50);
        return apiFetch<FriendPresenceResponse>(`/api/friends/presence?ids=${chunk.join(",")}`);
      })).then((responses) => {
        if (active && request === latestRequest) {
          setItems(Object.fromEntries(responses.flatMap((result) => result.items).map((item) => [item.userId, item])));
          setNow(Date.now());
        }
      }).catch(() => {
        if (active && request === latestRequest) setItems({});
      });
    };
    refresh();
    const poll = window.setInterval(refresh, 15_000);
    const tick = window.setInterval(() => setNow(Date.now()), 30_000);
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      window.clearInterval(poll);
      window.clearInterval(tick);
      window.removeEventListener("focus", refresh);
    };
  }, [enabled, idsKey]);

  return { presenceById: items, now };
}
