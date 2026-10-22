import assert from "node:assert/strict";
import test from "node:test";
import { lastActiveLabel } from "../src/chat/use-friend-presence";

const now = Date.parse("2026-10-22T12:00:00.000Z");

test("last active labels use minutes and hours, then disappear at 24 hours", () => {
  const presence = (elapsedMinutes: number) => ({
    userId: "friend",
    isOnline: false,
    lastActiveAt: new Date(now - elapsedMinutes * 60_000).toISOString(),
  });
  assert.equal(lastActiveLabel(presence(2), now), "2m ago");
  assert.equal(lastActiveLabel(presence(61), now), "1h ago");
  assert.equal(lastActiveLabel(presence(23 * 60), now), "23h ago");
  assert.equal(lastActiveLabel(presence(24 * 60), now), null);
  assert.equal(lastActiveLabel({ ...presence(2), isOnline: true }, now), null);
});
