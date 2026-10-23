import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { io, type Socket } from "socket.io-client";
import { Link, useSearchParams } from "react-router-dom";
import { SupporterBadge } from "../components/SupporterBadge";
import type {
  ChatUnreadResponse,
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
import { notifyChatUnreadChanged } from "../chat/unread-events";
import { lastActiveLabel, useFriendPresence } from "../chat/use-friend-presence";
import { EmptyState, RequestErrorState } from "../components/AsyncState";
import { ChatListSkeleton, MessageBubblesSkeleton, SkeletonBlock, SkeletonRegion } from "../components/Skeletons";
import {
  createPendingMessage,
  failChatMessage,
  mergeChatMessage,
  mergeChatMessages,
  retryChatMessage,
  sortFriendsByLatestMessage,
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
  const [searchParams, setSearchParams] = useSearchParams();
  const userId = user?.id;
  const [friends, setFriends] = useState<User[]>([]);
  const [friendsCursor, setFriendsCursor] = useState<string | null>(null);
  const [friendsLoading, setFriendsLoading] = useState(true);
  const [friendsLoadingMore, setFriendsLoadingMore] = useState(false);
  const [friendsError, setFriendsError] = useState<string | null>(null);
  const [friendsMoreError, setFriendsMoreError] = useState<string | null>(null);
  const [selectedFriendId, setSelectedFriendId] = useState<string | null>(() => searchParams.get("friend"));
  const [mobileConversationOpen, setMobileConversationOpen] = useState(() => Boolean(searchParams.get("friend")));
  const [conversationSearch, setConversationSearch] = useState("");
  const [chatFilter, setChatFilter] = useState<"all" | "unread">("all");
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
  const [conversations, setConversations] = useState<Record<string, ChatMessage[]>>({});
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [composerText, setComposerText] = useState("");
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [connectionError, setConnectionError] = useState<string | null>(null);

  const conversationsRef = useRef<Record<string, ChatMessage[]>>({});
  const initialFriendIdRef = useRef<string | null>(searchParams.get("friend"));
  const selectedFriendIdRef = useRef<string | null>(null);
  const nextCursorRef = useRef<string | null>(null);
  const socketRef = useRef<ChatSocket | null>(null);
  const sendTimersRef = useRef<Map<string, number>>(new Map());
  const messageScrollRef = useRef<HTMLDivElement>(null);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
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

  const markConversationRead = useCallback(async (friendId: string) => {
    try {
      await apiFetch<void>(`/api/chats/${encodeURIComponent(friendId)}/read`, { method: "PATCH" });
      setUnreadCounts((current) => {
        if (!(friendId in current)) return current;
        const next = { ...current };
        delete next[friendId];
        return next;
      });
      notifyChatUnreadChanged();
    } catch {
      // Keep the unread marker until the server confirms it was cleared.
    }
  }, []);

  useEffect(() => {
    let active = true;
    setFriendsLoading(true);
    setFriendsError(null);
    void apiFetch<FriendListResponse>("/api/friends?limit=20").then((response) => {
      if (!active) return;
      setFriends(response.items);
      setFriendsCursor(response.nextCursor);
      setSelectedFriendId((current) => {
        const requested = initialFriendIdRef.current;
        if (requested && response.items.some((friend) => friend.id === requested)) return requested;
        if (current && response.items.some((friend) => friend.id === current)) return current;
        if (window.matchMedia("(max-width: 680px)").matches) return null;
        return response.items[0]?.id ?? null;
      });
      void Promise.all(response.items.map(async (friend) => {
        try {
          const latest = await apiFetch<MessageHistoryResponse>(`/api/chats/${encodeURIComponent(friend.id)}/messages?limit=1`);
          return [friend.id, latest.items[0] ? asAcknowledged(latest.items[0]) : null] as const;
        } catch {
          return [friend.id, null] as const;
        }
      })).then((summaries) => {
        if (!active) return;
        const next = { ...conversationsRef.current };
        for (const [friendId, latestMessage] of summaries) {
          if (latestMessage) next[friendId] = mergeChatMessages(next[friendId] ?? [], [latestMessage]);
        }
        conversationsRef.current = next;
        setConversations(next);
      });
    }).catch((error: unknown) => {
      if (active) setFriendsError(errorMessage(error, "Could not load your friends."));
    }).finally(() => {
      if (active) setFriendsLoading(false);
    });
    return () => { active = false; };
  }, [updateConversation]);

  useEffect(() => {
    if (!userId) {
      setUnreadCounts({});
      return;
    }
    let active = true;
    void apiFetch<ChatUnreadResponse>("/api/chats/unread").then((response) => {
      if (!active) return;
      setUnreadCounts(Object.fromEntries(response.items.map((item) => [item.friendId, item.unreadCount])));
    }).catch(() => {
      if (active) setUnreadCounts({});
    });
    return () => { active = false; };
  }, [userId]);

  useEffect(() => {
    selectedFriendIdRef.current = selectedFriendId;
    nextCursorRef.current = null;
    setNextCursor(null);
    setHistoryError(null);
    if (!selectedFriendId) return;

    void markConversationRead(selectedFriendId);
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
  }, [markConversationRead, selectedFriendId, updateConversation]);

  useEffect(() => {
    if (!userId) return;
    setConnectionState("connecting");
    setConnectionError(null);
    const socketUrl = import.meta.env.VITE_SOCKET_URL || window.location.origin;
    const socket = io(socketUrl, {
      autoConnect: false,
      withCredentials: true,
      auth: (callback) => {
        void apiFetch<SocketTicketResponse>("/api/auth/socket-ticket", { method: "POST", body: {} })
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
      if (event.message.recipientId === currentUserId) {
        notifyChatUnreadChanged();
        if (selectedFriendIdRef.current === friendId) {
          void markConversationRead(friendId);
        } else {
          setUnreadCounts((current) => ({ ...current, [friendId]: (current[friendId] ?? 0) + 1 }));
        }
      }
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
  }, [clearSendTimer, markConversationRead, refreshConversation, retryPendingMessages, updateConversation, userId]);

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
      const summaries = await Promise.all(response.items.map(async (friend) => {
        try {
          const latest = await apiFetch<MessageHistoryResponse>(`/api/chats/${encodeURIComponent(friend.id)}/messages?limit=1`);
          return [friend.id, latest.items[0] ? asAcknowledged(latest.items[0]) : null] as const;
        } catch {
          return [friend.id, null] as const;
        }
      }));
      setConversations((current) => {
        const next = { ...current };
        for (const [friendId, latestMessage] of summaries) {
          if (latestMessage) next[friendId] = mergeChatMessages(next[friendId] ?? [], [latestMessage]);
        }
        conversationsRef.current = next;
        return next;
      });
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

  function openConversation(friendId: string): void {
    setSelectedFriendId(friendId);
    setMobileConversationOpen(true);
    setSearchParams({ friend: friendId }, { replace: true });
  }

  function closeConversation(): void {
    setSelectedFriendId(null);
    setMobileConversationOpen(false);
    setSearchParams({}, { replace: true });
  }

  const selectedFriend = friends.find((friend) => friend.id === selectedFriendId) ?? null;
  const { presenceById, now: presenceNow } = useFriendPresence(friends.map((friend) => friend.id));
  const selectedPresence = selectedFriend ? presenceById[selectedFriend.id] : undefined;
  const selectedLastActive = lastActiveLabel(selectedPresence, presenceNow);
  const selectedMessages = selectedFriendId ? conversations[selectedFriendId] ?? [] : [];
  const visibleFriends = sortFriendsByLatestMessage(friends.filter((friend) => {
    const latestMessage = conversations[friend.id]?.at(-1);
    return (chatFilter === "all" || (unreadCounts[friend.id] ?? 0) > 0) && `${friend.displayName} ${latestMessage?.text ?? ""}`
      .toLocaleLowerCase()
      .includes(conversationSearch.trim().toLocaleLowerCase());
  }), conversations);

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

  useEffect(() => {
    const input = composerInputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
  }, [composerText]);

  return (
    <main className={`messages-shell${mobileConversationOpen ? " messages-shell-conversation-open" : ""}`}>
      <aside className="messages-sidebar" aria-label="Chats">
        <header className="messages-sidebar-heading">
          <h1>Chats</h1>
          <Link to="/friends" aria-label="Find someone to message" title="New message">+</Link>
        </header>
        <label className="messages-page-search">
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 5 5" /></svg>
          <span className="sr-only">Search messages</span>
          <input value={conversationSearch} onChange={(event) => setConversationSearch(event.target.value)} placeholder="Search Messenges" />
        </label>
        <div className="messages-page-tabs" role="tablist" aria-label="Chat filters">
          <button className={chatFilter === "all" ? "messages-page-tab-active" : ""} type="button" role="tab" aria-selected={chatFilter === "all"} onClick={() => setChatFilter("all")}>All</button>
          <button className={chatFilter === "unread" ? "messages-page-tab-active" : ""} type="button" role="tab" aria-selected={chatFilter === "unread"} onClick={() => setChatFilter("unread")}>Unread</button>
        </div>
        <div className="messages-page-list">
          {friendsLoading ? <ChatListSkeleton /> : friendsError ? (
            <RequestErrorState title="Conversations unavailable" message={friendsError} />
          ) : friends.length === 0 ? (
            <EmptyState title="No friends yet" message="Add a friend first, then you can start a private conversation." />
          ) : visibleFriends.length === 0 ? (
            <p className="messages-list-empty">{chatFilter === "unread" ? "No unread messages." : "No chats match your search."}</p>
          ) : (
            <ul className="chat-friend-list" aria-label="Friend conversations">
              {visibleFriends.map((friend) => {
                const recentMessage = conversations[friend.id]?.at(-1);
                const presence = presenceById[friend.id];
                const lastActive = lastActiveLabel(presence, presenceNow);
                return (
                  <li key={friend.id}>
                    <button
                      className={`chat-friend-button ${selectedFriendId === friend.id ? "chat-friend-button-active" : ""}`}
                      type="button"
                      aria-pressed={selectedFriendId === friend.id}
                      onClick={() => openConversation(friend.id)}
                    >
                      <span className="chat-presence-avatar"><ChatFriendAvatar user={friend} />{presence?.isOnline && <span className="chat-online-dot" role="img" aria-label="Online" />}</span>
                      <span className="chat-friend-copy">
                        <strong>{friend.displayName} <SupporterBadge user={friend} /></strong>
                        <span>{recentMessage ? `${recentMessage.senderId === userId ? "You: " : ""}${recentMessage.text}` : "Start a conversation"}</span>
                      </span>
                      {lastActive && <time className="chat-friend-time chat-presence-time" dateTime={presence?.lastActiveAt} title="Last active">{lastActive}</time>}
                      {(unreadCounts[friend.id] ?? 0) > 0 && <span className="chat-unread-dot" role="img" aria-label={`${unreadCounts[friend.id]} unread messages`} />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {friendsLoadingMore && <ChatListSkeleton count={2} />}
          {friendsMoreError && <p className="friend-feedback friend-feedback-error" role="alert">{friendsMoreError}</p>}
          {friendsCursor && <button className="button-secondary chat-load-more" type="button" onClick={() => void loadMoreFriends()} disabled={friendsLoadingMore}>{friendsLoadingMore ? "Loading friends…" : "Load more friends"}</button>}
        </div>
      </aside>

        <section className="chat-conversation-panel messages-conversation" aria-label={selectedFriend ? `Conversation with ${selectedFriend.displayName}` : "Conversation"}>
          {selectedFriend ? (
            <>
              <header className="chat-conversation-header">
                <div className="messages-conversation-identity">
                  <button className="messages-mobile-back" type="button" onClick={closeConversation} aria-label="Back to chats" title="Back to chats">
                    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /><path d="M9 12h12" /></svg>
                  </button>
                  <div className="friend-person">
                    <span className="chat-presence-avatar"><ChatFriendAvatar user={selectedFriend} />{selectedPresence?.isOnline && <span className="chat-online-dot" role="img" aria-label="Online" />}</span>
                    <div className="friend-person-copy">
                      <h2 className="friend-person-name">{selectedFriend.displayName} <SupporterBadge user={selectedFriend} /></h2>
                      {(connectionError || selectedPresence?.isOnline || selectedLastActive) && <p>{connectionError ? "Connection interrupted" : selectedPresence?.isOnline ? "Online" : `Active ${selectedLastActive}`}</p>}
                    </div>
                  </div>
                </div>
                <div className="messages-chat-actions">
                  <span className={`chat-connection chat-connection-${connectionState}`} role="status"><span className="chat-connection-dot" aria-hidden="true" />{connectionState === "connected" ? "Connected" : connectionState === "connecting" ? "Connecting…" : "Reconnecting…"}</span>
                  <Link className="messages-profile-link" to={`/profile/${encodeURIComponent(selectedFriend.id)}`} aria-label={`View ${selectedFriend.displayName}'s profile`} title="View profile">↗</Link>
                </div>
              </header>
              {connectionError && <p className="friend-feedback friend-feedback-error" role="status">{connectionError}</p>}
              {historyError && <p className="friend-feedback friend-feedback-error" role="alert">{historyError}</p>}
              {nextCursor && <button className="button-secondary chat-load-more" type="button" onClick={() => void loadOlderMessages()} disabled={historyLoadingMore}>{historyLoadingMore ? "Loading older messages…" : "Load older messages"}</button>}
              <div ref={messageScrollRef} className="chat-message-scroll" onScroll={trackMessageScroll} aria-live="polite" aria-relevant="additions text">
                {historyLoading && selectedMessages.length === 0 ? <MessageBubblesSkeleton /> : selectedMessages.length === 0 ? (
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
                <div className="chat-composer-row">
                  <textarea
                    ref={composerInputRef}
                    id="chat-message"
                    className="form-input chat-message-input"
                    value={composerText}
                    onChange={(event) => setComposerText(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                        event.preventDefault();
                        event.currentTarget.form?.requestSubmit();
                      }
                    }}
                    maxLength={2_000}
                    rows={1}
                    placeholder={`Write a message to ${selectedFriend.displayName}…`}
                  />
                  {composerText.trim() && (
                    <button className="chat-composer-send" type="submit" aria-label="Send message" title="Send message">
                      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h13" /><path d="m13 6 6 6-6 6" /></svg>
                    </button>
                  )}
                </div>
              </form>
            </>
          ) : (
            <div className={`chat-empty-selection${friendsLoading ? " chat-empty-selection-loading" : ""}`}>
              {friendsLoading ? <MessageBubblesSkeleton /> : friendsError ? <RequestErrorState title="Conversations unavailable" message={friendsError} /> : (
                <EmptyState title="Choose a conversation" message="Select a friend from your conversation list to read or send messages." />
              )}
            </div>
          )}
        </section>
      <aside className="messages-info-panel" aria-label="Chat information">
        {selectedFriend ? (
          <>
            <div className="messages-info-profile">
              <ChatFriendAvatar user={selectedFriend} />
              <h2>{selectedFriend.displayName} <SupporterBadge user={selectedFriend} /></h2>
              <p>{selectedFriend.bio || "Senderi member"}</p>
              <Link className="messages-info-profile-link" to={`/profile/${encodeURIComponent(selectedFriend.id)}`}>View profile</Link>
            </div>

          </>
        ) : friendsLoading ? (
          <SkeletonRegion message="Loading chat information" className="skeleton-info-panel"><SkeletonBlock className="skeleton-avatar skeleton-profile-avatar" /><SkeletonBlock className="skeleton-line skeleton-w-65" /></SkeletonRegion>
        ) : <p className="messages-info-placeholder">Choose a chat to see its details.</p>}
      </aside>
    </main>
  );
}
