import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "../../shared";
import {
  createPendingMessage,
  failChatMessage,
  mergeChatMessage,
  mergeChatMessages,
  retryChatMessage,
  type ChatMessage,
} from "../src/chat/message-state";

const serverMessage: Message = {
  id: "server-message-1",
  senderId: "sender-id",
  recipientId: "friend-id",
  text: "Hello there",
  createdAt: "2026-10-21T10:00:00.000Z",
};

test("a retry keeps the same client ID and restores pending status", () => {
  const pending = createPendingMessage("sender-id", "friend-id", "Hello there", "retry-id");
  const failed = failChatMessage([pending], "retry-id", "Connection interrupted.", true);
  const retried = retryChatMessage(failed, "retry-id");

  assert.equal(retried[0]?.clientId, "retry-id");
  assert.equal(retried[0]?.deliveryState, "pending");
  assert.equal(retried[0]?.failureMessage, undefined);
});

test("an acknowledgement replaces the optimistic entry instead of duplicating it", () => {
  const pending = createPendingMessage("sender-id", "friend-id", "Hello there", "stable-id");
  const acknowledged: ChatMessage = { ...serverMessage, clientId: "stable-id", deliveryState: "acknowledged" };

  const result = mergeChatMessage([pending], acknowledged);

  assert.equal(result.length, 1);
  assert.equal(result[0]?.id, serverMessage.id);
  assert.equal(result[0]?.deliveryState, "acknowledged");
});

test("history and a late acknowledgement converge to one message after reconnect", () => {
  const pending = createPendingMessage("sender-id", "friend-id", "Hello there", "reconnect-id");
  const historyCopy: ChatMessage = { ...serverMessage, clientId: "reconnect-id", deliveryState: "acknowledged" };
  const acknowledged: ChatMessage = { ...serverMessage, clientId: "reconnect-id", deliveryState: "acknowledged" };
  const afterHistory = mergeChatMessage([pending], historyCopy);
  assert.equal(afterHistory.length, 1, "history correlates a saved send even when its ack was lost");
  assert.equal(afterHistory[0]?.id, serverMessage.id);
  const afterAck = mergeChatMessage(afterHistory, acknowledged);
  const afterDuplicateHistory = mergeChatMessages(afterAck, [historyCopy]);

  assert.equal(afterDuplicateHistory.length, 1);
  assert.equal(afterDuplicateHistory[0]?.id, serverMessage.id);
  assert.equal(afterDuplicateHistory[0]?.clientId, "reconnect-id");
});

test("duplicate realtime deliveries and overlapping history pages are deduplicated", () => {
  const event: ChatMessage = { ...serverMessage, deliveryState: "acknowledged" };
  const merged = mergeChatMessages([event], [event, event]);

  assert.equal(merged.length, 1);
});
