import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { io, type Socket } from "socket.io-client";
import type {
  FriendListResponse,
  Message,
  MessageAckEvent,
  MessageErrorEvent,
  MessageHistoryResponse,
  MessageNewEvent,
  MessageSendRequest,
  SocketTicketResponse,
  User,
} from "../../../shared";
import { useAuth } from "../auth/AuthContext";
import { ApiError, apiFetch } from "../api/client";
import { EmptyState, LoadingState, RequestErrorState } from "../components/AsyncState";
import {
  createPendingMessage,
  failChatMessage,
  mergeChatMessage,
  mergeChatMessages,
  retryChatMessage,
  type ChatMessage,
} from "../chat/message-state";

interface ClientToServerEvents {
  "message:send": (payload: MessageSendRequest) => void;
}

interface ServerToClientEvents {
  "message:ack": (payload: MessageAckEvent) => void;
  "message:new": (payload: MessageNewEvent) => void;
  "message:error": (payload: MessageErrorEvent) => void;
}

type ChatSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
type ConnectionState = "connecting" | "connected" | "reconnecting";

const HISTORY_PAGE_SIZE = 30;
const SEND_CONFIRMATION_TIMEOUT_MS = 15_000;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

async function fetchHistory(friendId: string, cursor?: string | null): Promise<MessageHistoryResponse> {
  const params = new URLSearchParams({ limit: String(HISTORY_PAGE_SIZE) });
  if (cursor) params.set("cursor", cursor);
  return apiFetch<MessageHistoryResponse>(`/api/chats/${encodeURIComponent(friendId)}/messages?${params}`);
}

function asAcknowledged(message: Message, clientId?: string): ChatMessage {
  return {
    ...message,
    ...(clientId ? { clientId } : {}),
    deliveryState: "acknowledged",
  };
}

function ChatFriendAvatar({ user }: { user: User }) {
  const [imageFailed, setImageFailed] = useState(false);
  const initial = user.displayName.trim().charAt(0).toUpperCase() || "?";
  return (
    <span className="chat-avatar" aria-hidden="true">
      {user.avatarUrl && !imageFailed
        ? <img src={user.avatarUrl} alt="" onError={() => setImageFailed(true)} />
        : initial}
    </span>
  );
}

function messageTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
}

export function MessagesPage() {
  const { user } = useAuth();
  const userId = user?.id;
  const [friends, setFriends] = useState<User[]>([]);
  const [friendsCursor, setFriendsCursor] = useState<string | null>(null);
  const [friendsLoading, setFriendsLoading] = useState(true);
  const [friendsLoadingMore, setFriendsLoadingMore] = useState(false);
  const [friendsError, setFriendsError] = useState<string | null>(null);
  const [friendsMoreError, setFriendsMoreError] = useState<string | null>(null);
  const [selectedFriendId, setSelectedFriendId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Record<string, ChatMessage[]>>({});
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [composerText, setComposerText] = useState("");
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [connectionError, setConnectionError] = useState<string | null>(null);

  const conversationsRef = useRef<Record<string, ChatMessage[]>>({});
  const selectedFriendIdRef = useRef<string | null>(null);
  const nextCursorRef = useRef<string | null>(null);
  const socketRef = useRef<ChatSocket | null>(null);
  const sendTimersRef = useRef<Map<string, number>>(new Map());
  const messageScrollRef = useRef<HTMLDivElement>(null);
  const shouldStickToBottomRef = useRef(true);

  const updateConversation = useCallback((friendId: string, update: (messages: ChatMessage[]) => ChatMessage[]) => {
    const nextConversation = update(conversationsRef.current[friendId] ?? []);
    const nextConversations = { ...conversationsRef.current, [friendId]: nextConversation };
    conversationsRef.current = nextConversations;
    setConversations(nextConversations);
  }, []);

  const setActiveCursor = useCallback((friendId: string, cursor: string | null) => {
    if (selectedFriendIdRef.current !== friendId) return;
    nextCursorRef.current = cursor;
    setNextCursor(cursor);
  }, []);

  const clearSendTimer = useCallback((friendId: string, clientId: string) => {
    const key = `${friendId}:${clientId}`;
    const timer = sendTimersRef.current.get(key);
    if (timer !== undefined) window.clearTimeout(timer);
    sendTimersRef.current.delete(key);
  }, []);

  const transmitMessage = useCallback((friendId: string, message: ChatMessage) => {
    const socket = socketRef.current;
    if (!socket?.connected || !message.clientId) return;

    clearSendTimer(friendId, message.clientId);
    socket.emit("message:send", {
      friendId,
      clientId: message.clientId,
      text: message.text,
    });

    const timerKey = `${friendId}:${message.clientId}`;
    const timer = window.setTimeout(() => {
      updateConversation(friendId, (current) => failChatMessage(
        current,
        message.clientId!,
        "No confirmation arrived. You can safely retry this message.",
        true,
      ));
      sendTimersRef.current.delete(timerKey);
    }, SEND_CONFIRMATION_TIMEOUT_MS);
    sendTimersRef.current.set(timerKey, timer);
  }, [clearSendTimer, updateConversation]);

  const retryPendingMessages = useCallback(() => {
    for (const [friendId, messages] of Object.entries(conversationsRef.current)) {
      for (const message of messages) {
        if (message.clientId && (message.deliveryState === "pending" || (message.deliveryState === "failed" && message.retryable))) {
          updateConversation(friendId, (current) => retryChatMessage(current, message.clientId!));
          transmitMessage(friendId, { ...message, deliveryState: "pending" });
        }
      }
    }
  }, [transmitMessage, updateConversation]);

  const refreshConversation = useCallback(async (friendId: string, loadMissedPages: boolean) => {
    const previouslyLoaded = new Set(
      (conversationsRef.current[friendId] ?? [])
        .filter((message) => !message.id.startsWith("local:"))
        .map((message) => message.id),
    );
    let cursor: string | null = null;

    for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
      const response = await fetchHistory(friendId, cursor);
      updateConversation(friendId, (current) => mergeChatMessages(
        current,
        response.items.map((message) => asAcknowledged(message)),
      ));
      setActiveCursor(friendId, response.nextCursor);

      const foundExistingMessage = response.items.some((message) => previouslyLoaded.has(message.id));
      if (!response.nextCursor || !loadMissedPages || previouslyLoaded.size === 0 || foundExistingMessage) return;
      cursor = response.nextCursor;
    }
  }, [setActiveCursor, updateConversation]);

  useEffect(() => {
    let active = true;
    setFriendsLoading(true);
    setFriendsError(null);
    void apiFetch<FriendListResponse>("/api/friends?limit=20").then((response) => {
      if (!active) return;
      setFriends(response.items);
      setFriendsCursor(response.nextCursor);
    }).catch((error: unknown) => {
      if (active) setFriendsError(errorMessage(error, "Could not load your friends."));
    }).finally(() => {
      if (active) setFriendsLoading(false);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    selectedFriendIdRef.current = selectedFriendId;
    nextCursorRef.current = null;
    setNextCursor(null);
    setHistoryError(null);
    if (!selectedFriendId) return;

    let active = true;
    setHistoryLoading(true);
    void fetchHistory(selectedFriendId).then((response) => {
      if (!active) return;
      updateConversation(selectedFriendId, (current) => mergeChatMessages(
        current,
        response.items.map((message) => asAcknowledged(message)),
      ));
      nextCursorRef.current = response.nextCursor;
      setNextCursor(response.nextCursor);
    }).catch((error: unknown) => {
      if (active) setHistoryError(errorMessage(error, "Could not load this conversation."));
    }).finally(() => {
      if (active) setHistoryLoading(false);
    });

    return () => { active = false; };
  }, [selectedFriendId, updateConversation]);

  useEffect(() => {
    if (!userId) return;
    setConnectionState("connecting");
    setConnectionError(null);
    const socketUrl = import.meta.env.VITE_SOCKET_URL || window.location.origin;
    const socket = io(socketUrl, {
      autoConnect: false,
      withCredentials: true,
      auth: (callback) => {
        void apiFetch<SocketTicketResponse>("/api/auth/socket-ticket")
          .then(({ ticket }) => callback({ ticket }))
          .catch(() => callback({ ticket: "" }));
      },
    }) as ChatSocket;
    const currentUserId = userId;
    socketRef.current = socket;
    const activeSendTimers = sendTimersRef.current;
    let connectedOnce = false;

    socket.on("connect", () => {
      const isReconnect = connectedOnce;
      connectedOnce = true;
      setConnectionState("connected");
      setConnectionError(null);
      retryPendingMessages();
      const friendId = selectedFriendIdRef.current;
      if (isReconnect && friendId) {
        void refreshConversation(friendId, true).catch((error: unknown) => {
          if (selectedFriendIdRef.current === friendId) {
            setHistoryError(errorMessage(error, "Could not refresh missed messages."));
          }
        });
      }
    });
    socket.on("disconnect", () => setConnectionState("reconnecting"));
    socket.on("connect_error", () => {
      setConnectionState("reconnecting");
      setConnectionError("Live connection interrupted. Senderi will keep trying to reconnect.");
    });
    socket.on("message:ack", (event) => {
      clearSendTimer(event.message.recipientId, event.clientId);
      updateConversation(event.message.recipientId, (current) => mergeChatMessage(
        current,
        { ...asAcknowledged(event.message, event.clientId), deliveryState: "acknowledged" },
      ));
    });
    socket.on("message:new", (event) => {
      const friendId = event.message.senderId === currentUserId ? event.message.recipientId : event.message.senderId;
      updateConversation(friendId, (current) => mergeChatMessage(current, asAcknowledged(event.message)));
    });
    socket.on("message:error", (event) => {
      if (!event.clientId) return;
      const match = Object.entries(conversationsRef.current).find(([, messages]) =>
        messages.some((message) => message.clientId === event.clientId),
      );
      if (!match) return;
      const [friendId] = match;
      clearSendTimer(friendId, event.clientId);
      updateConversation(friendId, (current) => failChatMessage(
        current,
        event.clientId!,
        event.message,
        event.code === "message_failed",
      ));
    });

    socket.connect();
    return () => {
      for (const timer of activeSendTimers.values()) window.clearTimeout(timer);
      activeSendTimers.clear();
      socket.removeAllListeners();
      socket.disconnect();
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [clearSendTimer, refreshConversation, retryPendingMessages, updateConversation, userId]);

  async function loadMoreFriends(): Promise<void> {
    if (!friendsCursor || friendsLoadingMore) return;
    setFriendsLoadingMore(true);
    setFriendsMoreError(null);
    try {
      const params = new URLSearchParams({ limit: "20", cursor: friendsCursor });
      const response = await apiFetch<FriendListResponse>(`/api/friends?${params}`);
      setFriends((current) => {
        const knownIds = new Set(current.map((friend) => friend.id));
        return [...current, ...response.items.filter((friend) => !knownIds.has(friend.id))];
      });
      setFriendsCursor(response.nextCursor);
    } catch (error) {
      setFriendsMoreError(errorMessage(error, "Could not load more friends."));
    } finally {
      setFriendsLoadingMore(false);
    }
  }

  async function loadOlderMessages(): Promise<void> {
    const friendId = selectedFriendId;
    const cursor = nextCursorRef.current;
    if (!friendId || !cursor || historyLoadingMore) return;
    setHistoryLoadingMore(true);
    setHistoryError(null);
    try {
      const response = await fetchHistory(friendId, cursor);
      updateConversation(friendId, (current) => mergeChatMessages(
        current,
        response.items.map((message) => asAcknowledged(message)),
      ));
      setActiveCursor(friendId, response.nextCursor);
    } catch (error) {
      setHistoryError(errorMessage(error, "Could not load older messages."));
    } finally {
      setHistoryLoadingMore(false);
    }
  }

  function sendMessage(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const friend = friends.find((item) => item.id === selectedFriendId);
    const text = composerText.trim();
    if (!friend || !user || !text) return;

    const message = createPendingMessage(user.id, friend.id, text);
    updateConversation(friend.id, (current) => mergeChatMessage(current, message));
    setComposerText("");
    transmitMessage(friend.id, message);
  }

  function retryMessage(friendId: string, message: ChatMessage): void {
    if (!message.clientId) return;
    updateConversation(friendId, (current) => retryChatMessage(current, message.clientId!));
    transmitMessage(friendId, { ...message, deliveryState: "pending" });
  }

  const selectedFriend = friends.find((friend) => friend.id === selectedFriendId) ?? null;
  const selectedMessages = selectedFriendId ? conversations[selectedFriendId] ?? [] : [];

  useEffect(() => {
    shouldStickToBottomRef.current = true;
    const scrollContainer = messageScrollRef.current;
    if (scrollContainer) scrollContainer.scrollTop = scrollContainer.scrollHeight;
  }, [selectedFriendId]);

  useEffect(() => {
    const scrollContainer = messageScrollRef.current;
    if (scrollContainer && shouldStickToBottomRef.current) {
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
    }
  }, [selectedFriendId, selectedMessages.length]);

  function trackMessageScroll(): void {
    const scrollContainer = messageScrollRef.current;
    if (!scrollContainer) return;
    const distanceFromBottom = scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight;
    shouldStickToBottomRef.current = distanceFromBottom < 72;
  }

  return (
    <div className="space-y-5">
      <section className="surface-card p-6 sm:p-8">
        <span className="eyebrow">Your circle</span>
        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-[-0.04em] text-ink">Messages</h1>
            <p className="mt-2 max-w-xl text-sm leading-6 text-muted">Private conversations with your friends. Messages are saved before they are delivered.</p>
          </div>
          <span className={`chat-connection chat-connection-${connectionState}`} role="status">
            <span className="chat-connection-dot" aria-hidden="true" />
            {connectionState === "connected" ? "Connected" : connectionState === "connecting" ? "Connecting…" : "Reconnecting…"}
          </span>
        </div>
        {connectionError && <p className="friend-feedback friend-feedback-error" role="status">{connectionError}</p>}
      </section>

      <div className="chat-layout">
        <section className="surface-card chat-friends-panel" aria-labelledby="conversations-title">
          <div className="chat-panel-heading">
            <div>
              <h2 id="conversations-title" className="text-xl font-bold tracking-[-0.03em] text-ink">Conversations</h2>
              <p className="mt-1 text-sm text-muted">Choose a friend to open your chat.</p>
            </div>
            <span className="friend-count">{friends.length}{friendsCursor ? "+" : ""} friends</span>
          </div>
          {friendsLoading ? <LoadingState message="Loading your friends…" /> : friendsError ? (
            <RequestErrorState title="Conversations unavailable" message={friendsError} />
          ) : friends.length === 0 ? (
            <EmptyState title="No friends yet" message="Add a friend first, then you can start a private conversation." />
          ) : (
            <ul className="chat-friend-list" aria-label="Friend conversations">
              {friends.map((friend) => {
                const recentMessage = conversations[friend.id]?.at(-1);
                return (
                  <li key={friend.id}>
                    <button
                      className={`chat-friend-button ${selectedFriendId === friend.id ? "chat-friend-button-active" : ""}`}
                      type="button"
                      aria-pressed={selectedFriendId === friend.id}
                      onClick={() => setSelectedFriendId(friend.id)}
                    >
                      <ChatFriendAvatar user={friend} />
                      <span className="chat-friend-copy">
                        <strong>{friend.displayName}</strong>
                        <span>{recentMessage?.text ?? "Open your conversation"}</span>
                      </span>
                      {recentMessage && <time className="chat-friend-time" dateTime={recentMessage.createdAt}>{messageTime(recentMessage.createdAt)}</time>}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {friendsMoreError && <p className="friend-feedback friend-feedback-error" role="alert">{friendsMoreError}</p>}
          {friendsCursor && <button className="button-secondary chat-load-more" type="button" onClick={() => void loadMoreFriends()} disabled={friendsLoadingMore}>{friendsLoadingMore ? "Loading friends…" : "Load more friends"}</button>}
        </section>

        <section className="surface-card chat-conversation-panel" aria-label={selectedFriend ? `Conversation with ${selectedFriend.displayName}` : "Conversation"}>
          {selectedFriend ? (
            <>
              <header className="chat-conversation-header">
                <div className="friend-person">
                  <ChatFriendAvatar user={selectedFriend} />
                  <div className="friend-person-copy">
                    <h2 className="friend-person-name">{selectedFriend.displayName}</h2>
                    <p>{selectedFriend.bio || "Your conversation"}</p>
                  </div>
                </div>
                <button className="button-secondary chat-refresh" type="button" onClick={() => void refreshConversation(selectedFriend.id, true)} disabled={historyLoading}>
                  Refresh
                </button>
              </header>
              {historyError && <p className="friend-feedback friend-feedback-error" role="alert">{historyError}</p>}
              {nextCursor && <button className="button-secondary chat-load-more" type="button" onClick={() => void loadOlderMessages()} disabled={historyLoadingMore}>{historyLoadingMore ? "Loading older messages…" : "Load older messages"}</button>}
              <div ref={messageScrollRef} className="chat-message-scroll" onScroll={trackMessageScroll} aria-live="polite" aria-relevant="additions text">
                {historyLoading && selectedMessages.length === 0 ? <LoadingState message="Loading conversation…" /> : selectedMessages.length === 0 ? (
                  <EmptyState title="Start the conversation" message={`Send a message to ${selectedFriend.displayName}.`} />
                ) : (
                  <ol className="chat-message-list" aria-label="Messages">
                    {selectedMessages.map((message) => {
                      const isOwnMessage = message.senderId === user?.id;
                      return (
                        <li key={message.id} className={`chat-message-row ${isOwnMessage ? "chat-message-row-own" : ""}`}>
                          <article className={`chat-message-bubble ${isOwnMessage ? "chat-message-bubble-own" : ""}`}>
                            <p>{message.text}</p>
                            <div className="chat-message-meta">
                              <time dateTime={message.createdAt}>{messageTime(message.createdAt)}</time>
                              {isOwnMessage && message.deliveryState === "pending" && <span>{connectionState === "connected" ? "Sending…" : "Queued"}</span>}
                              {isOwnMessage && message.deliveryState === "acknowledged" && <span>Sent</span>}
                              {isOwnMessage && message.deliveryState === "failed" && <span className="chat-message-failed">Failed</span>}
                            </div>
                            {message.deliveryState === "failed" && message.failureMessage && (
                              <div className="chat-message-failure">
                                <span>{message.failureMessage}</span>
                                <button type="button" onClick={() => retryMessage(selectedFriend.id, message)} disabled={!message.retryable}>Retry</button>
                              </div>
                            )}
                          </article>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </div>
              <form className="chat-composer" onSubmit={sendMessage}>
                <label htmlFor="chat-message" className="sr-only">Message to {selectedFriend.displayName}</label>
                <textarea
                  id="chat-message"
                  className="form-input chat-message-input"
                  value={composerText}
                  onChange={(event) => setComposerText(event.target.value)}
                  maxLength={2_000}
                  rows={2}
                  placeholder={`Write a message to ${selectedFriend.displayName}…`}
                  required
                />
                <div className="chat-composer-footer">
                  <span>{composerText.length}/2,000 characters</span>
                  <button className="button-accent" type="submit" disabled={!composerText.trim()}>{connectionState === "connected" ? "Send message" : "Queue message"}</button>
                </div>
              </form>
            </>
          ) : (
            <div className="chat-empty-selection">
              {friendsLoading ? <LoadingState message="Loading your conversations…" /> : friendsError ? <RequestErrorState title="Conversations unavailable" message={friendsError} /> : (
                <EmptyState title="Choose a conversation" message="Select a friend from your conversation list to read or send messages." />
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
