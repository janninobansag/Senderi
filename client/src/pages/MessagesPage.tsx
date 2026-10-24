import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { io } from "socket.io-client";
import { Link, useSearchParams } from "react-router-dom";
import { SupporterBadge } from "../components/SupporterBadge";
import { ReportDialog } from "../components/ReportDialog";
import type {
  ChatUnreadResponse,
  CreateGroupConversationRequest,
  FriendListResponse,
  GroupConversation,
  GroupConversationsResponse,
  GroupMemberRole,
  Message,
  MessageHistoryResponse,
  SocketTicketResponse,
  User,
} from "../../../shared";
import { useAuth } from "../auth/AuthContext";
import { ApiError, apiFetch } from "../api/client";
import { notifyChatUnreadChanged } from "../chat/unread-events";
import { lastActiveLabel, useFriendPresence } from "../chat/use-friend-presence";
import { ChatFriendAvatar, GroupChatAvatar } from "../chat/chat-avatars";
import { MessageMeta } from "../chat/message-meta";
import type { ChatSocket } from "../chat/socket-events";
import { EmptyState, RequestErrorState } from "../components/AsyncState";
import { ChatListSkeleton, MessageBubblesSkeleton, SkeletonBlock, SkeletonRegion } from "../components/Skeletons";
import {
  createClientMessageId,
  createPendingMessage,
  failChatMessage,
  mergeChatMessage,
  mergeChatMessages,
  retryChatMessage,
  sortFriendsByLatestMessage,
  type ChatMessage,
} from "../chat/message-state";

type ConnectionState = "connecting" | "connected" | "reconnecting";

const HISTORY_PAGE_SIZE = 30;
const SEND_CONFIRMATION_TIMEOUT_MS = 15_000;
const CHAT_PHOTO_MAX_BYTES = 5 * 1024 * 1024;
const CHAT_PHOTO_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

async function fetchHistory(conversationKey: string, cursor?: string | null): Promise<MessageHistoryResponse> {
  const params = new URLSearchParams({ limit: String(HISTORY_PAGE_SIZE) });
  if (cursor) params.set("cursor", cursor);
  const isGroup = conversationKey.startsWith("group:");
  const id = isGroup ? conversationKey.slice("group:".length) : conversationKey;
  const path = isGroup ? `/api/chats/groups/${encodeURIComponent(id)}/messages` : `/api/chats/${encodeURIComponent(id)}/messages`;
  return apiFetch<MessageHistoryResponse>(`${path}?${params}`);
}

function asAcknowledged(message: Message, clientId?: string): ChatMessage {
  return {
    ...message,
    ...(clientId ? { clientId } : {}),
    deliveryState: "acknowledged",
  };
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
  const [selectedFriendId, setSelectedFriendId] = useState<string | null>(() => searchParams.get("group") ? `group:${searchParams.get("group")}` : searchParams.get("friend"));
  const [mobileConversationOpen, setMobileConversationOpen] = useState(() => Boolean(searchParams.get("friend") || searchParams.get("group")));
  const [groups, setGroups] = useState<GroupConversation[]>([]);
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [groupMemberIds, setGroupMemberIds] = useState<string[]>([]);
  const [groupCreateError, setGroupCreateError] = useState<string | null>(null);
  const [groupCreating, setGroupCreating] = useState(false);
  const [groupActionsOpen, setGroupActionsOpen] = useState(false);
  const [mobileGroupMembersOpen, setMobileGroupMembersOpen] = useState(false);
  const [groupActionDialog, setGroupActionDialog] = useState<"rename" | "add" | "remove" | null>(null);
  const [groupActionName, setGroupActionName] = useState("");
  const [groupActionMemberIds, setGroupActionMemberIds] = useState<string[]>([]);
  const [groupActionBusy, setGroupActionBusy] = useState(false);
  const [groupRoleBusyId, setGroupRoleBusyId] = useState<string | null>(null);
  const [groupMemberRemovingId, setGroupMemberRemovingId] = useState<string | null>(null);
  const [groupActionError, setGroupActionError] = useState<string | null>(null);
  const [groupActionStatus, setGroupActionStatus] = useState<string | null>(null);
  const [conversationSearch, setConversationSearch] = useState("");
  const [chatFilter, setChatFilter] = useState<"all" | "unread">("all");
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
  const [conversations, setConversations] = useState<Record<string, ChatMessage[]>>({});
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [composerText, setComposerText] = useState("");
  const [photoAttachment, setPhotoAttachment] = useState<File | null>(null);
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState<string | null>(null);
  const [photoAttachmentError, setPhotoAttachmentError] = useState<string | null>(null);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [openMessageMenuId, setOpenMessageMenuId] = useState<string | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [messageDraft, setMessageDraft] = useState("");
  const [messageActionBusyId, setMessageActionBusyId] = useState<string | null>(null);
  const [messageActionError, setMessageActionError] = useState<{ messageId: string; text: string } | null>(null);
  const [reportingMessageId, setReportingMessageId] = useState<string | null>(null);
  const [reportStatus, setReportStatus] = useState<string | null>(null);
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
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const attachmentMenuRef = useRef<HTMLDivElement>(null);
  const attachmentToggleRef = useRef<HTMLButtonElement>(null);
  const messageMenuRef = useRef<HTMLDivElement>(null);
  const messageMenuButtonRef = useRef<HTMLButtonElement>(null);
  const messageEditInputRef = useRef<HTMLTextAreaElement>(null);
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
    if (friendId.startsWith("group:")) {
      socket.emit("group-message:send", {
        groupId: friendId.slice("group:".length),
        clientId: message.clientId,
        text: message.text,
      });
    } else {
      socket.emit("message:send", {
        friendId,
        clientId: message.clientId,
        text: message.text,
      });
    }

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
      const isGroup = friendId.startsWith("group:");
      const id = isGroup ? friendId.slice("group:".length) : friendId;
      const path = isGroup ? `/api/chats/groups/${encodeURIComponent(id)}/read` : `/api/chats/${encodeURIComponent(id)}/read`;
      await apiFetch<void>(path, { method: "PATCH" });
      setUnreadCounts((current) => {
        if (!(friendId in current)) return current;
        const next = { ...current };
        delete next[friendId];
        return next;
      });
      if (isGroup) setGroups((current) => current.map((group) => group.id === id ? { ...group, unreadCount: 0 } : group));
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
        if (current?.startsWith("group:")) return current;
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
      setGroups([]);
      return;
    }
    let active = true;
    void apiFetch<GroupConversationsResponse>("/api/chats/groups").then((response) => {
      if (!active) return;
      setGroups(response.items);
      setConversations((current) => {
        const next = { ...current };
        for (const group of response.items) {
          if (group.latestMessage) {
            const key = `group:${group.id}`;
            next[key] = mergeChatMessages(next[key] ?? [], [asAcknowledged(group.latestMessage)]);
          }
        }
        conversationsRef.current = next;
        return next;
      });
    }).catch(() => {
      if (active) setGroups([]);
    });
    return () => { active = false; };
  }, [userId]);

  useEffect(() => {
    if (!userId) {
      setUnreadCounts({});
      return;
    }
    let active = true;
    void apiFetch<ChatUnreadResponse>("/api/chats/unread").then((response) => {
      if (!active) return;
      setUnreadCounts(Object.fromEntries(response.items.map((item) => [
        "groupId" in item ? `group:${item.groupId}` : item.friendId,
        item.unreadCount,
      ])));
    }).catch(() => {
      if (active) setUnreadCounts({});
    });
    return () => { active = false; };
  }, [userId]);

  useEffect(() => {
    const previousFriendId = selectedFriendIdRef.current;
    selectedFriendIdRef.current = selectedFriendId;
    nextCursorRef.current = null;
    setNextCursor(null);
    setHistoryError(null);
    if (previousFriendId !== selectedFriendId) {
      setPhotoAttachment(null);
      setPhotoAttachmentError(null);
      setAttachmentMenuOpen(false);
      setOpenMessageMenuId(null);
      setEditingMessageId(null);
      setMessageActionError(null);
      setGroupActionsOpen(false);
      setGroupActionError(null);
      setGroupActionStatus(null);
    }
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
      const conversationKey = event.message.groupId ? `group:${event.message.groupId}` : event.message.recipientId;
      clearSendTimer(conversationKey, event.clientId);
      updateConversation(conversationKey, (current) => mergeChatMessage(
        current,
        { ...asAcknowledged(event.message, event.clientId), deliveryState: "acknowledged" },
      ));
    });
    socket.on("group:created", (event) => {
      setGroups((current) => [event.group, ...current.filter((group) => group.id !== event.group.id)]);
    });
    socket.on("group:updated", (event) => {
      setGroups((current) => [event.group, ...current.filter((group) => group.id !== event.group.id)]);
    });
    socket.on("group:removed", (event) => {
      setGroups((current) => current.filter((group) => group.id !== event.groupId));
      if (selectedFriendIdRef.current === `group:${event.groupId}`) {
        setSelectedFriendId(null);
        setMobileConversationOpen(false);
        setSearchParams({}, { replace: true });
      }
    });
    socket.on("message:new", (event) => {
      const isGroupMessage = Boolean(event.message.groupId);
      const friendId = isGroupMessage
        ? `group:${event.message.groupId}`
        : event.message.senderId === currentUserId ? event.message.recipientId : event.message.senderId;
      updateConversation(friendId, (current) => mergeChatMessage(current, asAcknowledged(event.message)));
      if (isGroupMessage) {
        setGroups((current) => current.map((group) => group.id === event.message.groupId
          ? { ...group, latestMessage: event.message, unreadCount: event.message.senderId === currentUserId || selectedFriendIdRef.current === friendId ? 0 : group.unreadCount + 1 }
          : group));
        if (event.message.senderId !== currentUserId) {
          notifyChatUnreadChanged();
          if (selectedFriendIdRef.current === friendId) void markConversationRead(friendId);
          else setUnreadCounts((current) => ({ ...current, [friendId]: (current[friendId] ?? 0) + 1 }));
        }
        return;
      }
      if (event.message.recipientId === currentUserId) {
        notifyChatUnreadChanged();
        if (selectedFriendIdRef.current === friendId) {
          void markConversationRead(friendId);
        } else {
          setUnreadCounts((current) => ({ ...current, [friendId]: (current[friendId] ?? 0) + 1 }));
        }
      }
    });
    socket.on("message:read", (event) => {
      const readMessageIds = new Set(event.messageIds ?? []);
      const readAt = Date.parse(event.readAt);
      updateConversation(event.conversationId, (current) => current.map((message) =>
        message.senderId === currentUserId && (readMessageIds.has(message.id) || (!event.messageIds && Date.parse(message.createdAt) <= readAt))
          ? { ...message, isRead: true }
          : message,
      ));
    });
    socket.on("message:updated", (event) => {
      const friendId = event.message.groupId
        ? `group:${event.message.groupId}`
        : event.message.senderId === currentUserId ? event.message.recipientId : event.message.senderId;
      updateConversation(friendId, (current) => mergeChatMessage(current, asAcknowledged(event.message)));
    });
    socket.on("message:deleted", (event) => {
      const friendId = event.groupId
        ? `group:${event.groupId}`
        : event.senderId === currentUserId ? event.recipientId : event.senderId;
      updateConversation(friendId, (current) => current.filter((message) => message.id !== event.messageId));
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
  }, [clearSendTimer, markConversationRead, refreshConversation, retryPendingMessages, setSearchParams, updateConversation, userId]);

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

  async function createGroupConversation(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (groupCreating) return;
    if (groupMemberIds.length < 2) {
      setGroupCreateError("Choose at least two friends for a group chat.");
      return;
    }
    setGroupCreating(true);
    setGroupCreateError(null);
    try {
      const payload: CreateGroupConversationRequest = { name: groupName.trim(), memberIds: groupMemberIds };
      const response = await apiFetch<{ group: GroupConversation }>("/api/chats/groups", { method: "POST", body: payload });
      setGroups((current) => [response.group, ...current.filter((group) => group.id !== response.group.id)]);
      setGroupDialogOpen(false);
      setGroupName("");
      setGroupMemberIds([]);
      openGroupConversation(response.group.id);
    } catch (error) {
      setGroupCreateError(errorMessage(error, "Could not create this group chat."));
    } finally {
      setGroupCreating(false);
    }
  }

  function openGroupActionDialog(kind: "rename" | "add" | "remove"): void {
    if (!selectedGroup) return;
    setGroupActionError(null);
    setGroupActionStatus(null);
    setGroupActionsOpen(false);
    setGroupActionName(selectedGroup.name);
    setGroupActionMemberIds([]);
    setGroupActionDialog(kind);
  }

  async function submitGroupAction(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!selectedGroup || !groupActionDialog || groupActionDialog === "remove" || groupActionBusy) return;
    if (groupActionDialog === "add" && groupActionMemberIds.length === 0) {
      setGroupActionError("Choose at least one friend to add.");
      return;
    }
    setGroupActionBusy(true);
    setGroupActionError(null);
    try {
      const response = groupActionDialog === "rename"
        ? await apiFetch<{ group: GroupConversation }>(`/api/chats/groups/${encodeURIComponent(selectedGroup.id)}`, { method: "PATCH", body: { name: groupActionName.trim() } })
        : await apiFetch<{ group: GroupConversation }>(`/api/chats/groups/${encodeURIComponent(selectedGroup.id)}/members`, { method: "POST", body: { memberIds: groupActionMemberIds } });
      setGroups((current) => [response.group, ...current.filter((group) => group.id !== response.group.id)]);
      setGroupActionDialog(null);
      setGroupActionStatus(groupActionDialog === "rename" ? "Group name updated." : "Member added to the group.");
    } catch (error) {
      setGroupActionError(errorMessage(error, groupActionDialog === "rename" ? "Could not rename this group." : "Could not add the selected friends."));
    } finally {
      setGroupActionBusy(false);
    }
  }

  async function changeGroupRole(memberId: string, role: GroupMemberRole): Promise<void> {
    if (!selectedGroup || groupRoleBusyId) return;
    setGroupRoleBusyId(memberId);
    setGroupActionError(null);
    setGroupActionStatus(null);
    try {
      const response = await apiFetch<{ group: GroupConversation }>(`/api/chats/groups/${encodeURIComponent(selectedGroup.id)}/members/${encodeURIComponent(memberId)}/role`, { method: "PATCH", body: { role } });
      setGroups((current) => [response.group, ...current.filter((group) => group.id !== response.group.id)]);
      setGroupActionStatus(role === "owner" ? "Group ownership transferred." : "Member role updated.");
    } catch (error) {
      setGroupActionError(errorMessage(error, "Could not update this member's role."));
    } finally {
      setGroupRoleBusyId(null);
    }
  }

  async function removeGroupMember(memberId: string, displayName: string): Promise<void> {
    if (!selectedGroup || groupMemberRemovingId) return;
    if (!window.confirm(`Remove ${displayName} from ${selectedGroup.name}? They will lose access to this group's messages.`)) return;
    setGroupMemberRemovingId(memberId);
    setGroupActionError(null);
    setGroupActionStatus(null);
    try {
      await apiFetch<void>(`/api/chats/groups/${encodeURIComponent(selectedGroup.id)}/members/${encodeURIComponent(memberId)}`, { method: "DELETE" });
      setGroups((current) => current.map((group) => group.id === selectedGroup.id
        ? { ...group, participants: group.participants.filter((participant) => participant.id !== memberId) }
        : group));
      setGroupActionStatus(`${displayName} was removed from the group.`);
      if (groupActionDialog === "remove") setGroupActionDialog(null);
    } catch (error) {
      setGroupActionError(errorMessage(error, `Could not remove ${displayName} from this group.`));
    } finally {
      setGroupMemberRemovingId(null);
    }
  }

  async function leaveGroup(): Promise<void> {
    if (!selectedGroup || groupActionBusy) return;
    if (selectedGroupRole === "owner") {
      setGroupActionError("Transfer ownership using a member's role menu before leaving.");
      return;
    }
    if (!window.confirm(`Leave ${selectedGroup.name}? You will no longer see its messages unless you are added again.`)) return;
    setGroupActionBusy(true);
    setGroupActionError(null);
    try {
      await apiFetch<void>(`/api/chats/groups/${encodeURIComponent(selectedGroup.id)}/members/me`, { method: "DELETE" });
      setGroups((current) => current.filter((group) => group.id !== selectedGroup.id));
      closeConversation();
    } catch (error) {
      setGroupActionError(errorMessage(error, "Could not leave this group."));
    } finally {
      setGroupActionBusy(false);
    }
  }

  async function permanentlyDeleteGroup(): Promise<void> {
    if (!selectedGroup || groupActionBusy) return;
    if (!window.confirm(`Permanently delete ${selectedGroup.name} and all of its messages? This cannot be undone.`)) return;
    setGroupActionBusy(true);
    setGroupActionError(null);
    try {
      await apiFetch<void>(`/api/chats/groups/${encodeURIComponent(selectedGroup.id)}`, { method: "DELETE" });
      setGroups((current) => current.filter((group) => group.id !== selectedGroup.id));
      closeConversation();
    } catch (error) {
      setGroupActionError(errorMessage(error, "Could not permanently delete this group."));
    } finally {
      setGroupActionBusy(false);
    }
  }

  function sendMessage(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const friend = friends.find((item) => item.id === selectedFriendId);
    const group = selectedGroupId ? groups.find((item) => item.id === selectedGroupId) : null;
    const conversationKey = selectedFriendId;
    const text = composerText.trim();
    if ((!friend && !group) || !conversationKey || !user || (!text && !photoAttachment) || photoUploading) return;

    if (photoAttachment) {
      const clientId = createClientMessageId();
      const formData = new FormData();
      formData.set("file", photoAttachment);
      formData.set("clientId", clientId);
      formData.set("text", text);
      setPhotoUploading(true);
      setPhotoAttachmentError(null);
      const photoPath = group
        ? `/api/chats/groups/${encodeURIComponent(group.id)}/messages`
        : `/api/chats/${encodeURIComponent(friend!.id)}/messages`;
      void apiFetch<{ message: Message }>(photoPath, {
        method: "POST",
        body: formData,
      }).then(({ message }) => {
        updateConversation(conversationKey, (current) => mergeChatMessage(current, asAcknowledged(message, clientId)));
        if (group) setGroups((current) => current.map((item) => item.id === group.id ? { ...item, latestMessage: message } : item));
        if (selectedFriendIdRef.current === conversationKey) {
          setComposerText("");
          setPhotoAttachment(null);
        }
      }).catch((error: unknown) => {
        if (selectedFriendIdRef.current === conversationKey) {
          setPhotoAttachmentError(errorMessage(error, "Could not send this image. Please try again."));
        }
      }).finally(() => {
        setPhotoUploading(false);
      });
      return;
    }

    const message: ChatMessage = {
      ...createPendingMessage(user.id, group ? user.id : friend!.id, text),
      ...(group ? { groupId: group.id } : {}),
    };
    updateConversation(conversationKey, (current) => mergeChatMessage(current, message));
    setComposerText("");
    transmitMessage(conversationKey, message);
  }

  function selectPhoto(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    if (file.size > CHAT_PHOTO_MAX_BYTES) {
      setPhotoAttachment(null);
      setPhotoAttachmentError("Choose an image that is 5 MB or smaller.");
      return;
    }
    if (file.type && !CHAT_PHOTO_MIME_TYPES.includes(file.type)) {
      setPhotoAttachment(null);
      setPhotoAttachmentError("Choose a JPEG, PNG, or WebP image.");
      return;
    }
    setPhotoAttachmentError(null);
    setPhotoAttachment(file);
  }

  function beginMessageEdit(message: ChatMessage): void {
    setMessageDraft(message.text);
    setMessageActionError(null);
    setEditingMessageId(message.id);
    setOpenMessageMenuId(null);
  }

  async function saveMessageEdit(friendId: string, message: ChatMessage): Promise<void> {
    if (messageActionBusyId) return;
    setMessageActionBusyId(message.id);
    setMessageActionError(null);
    try {
      const response = await apiFetch<{ message: Message }>(`/api/chats/messages/${encodeURIComponent(message.id)}`, {
        method: "PATCH",
        body: { text: messageDraft.trim() },
      });
      updateConversation(friendId, (current) => mergeChatMessage(current, asAcknowledged(response.message)));
      setEditingMessageId(null);
    } catch (error) {
      setMessageActionError({ messageId: message.id, text: errorMessage(error, "Could not edit this message.") });
    } finally {
      setMessageActionBusyId(null);
    }
  }

  async function permanentlyDeleteMessage(friendId: string, message: ChatMessage): Promise<void> {
    const audience = friendId.startsWith("group:") ? "everyone in this group" : "both people";
    if (messageActionBusyId || !window.confirm(`Permanently delete this message for ${audience}? This cannot be undone.`)) return;
    setOpenMessageMenuId(null);
    setMessageActionError(null);
    setMessageActionBusyId(message.id);
    try {
      await apiFetch<void>(`/api/chats/messages/${encodeURIComponent(message.id)}`, { method: "DELETE" });
      updateConversation(friendId, (current) => current.filter((item) => item.id !== message.id));
      if (editingMessageId === message.id) setEditingMessageId(null);
    } catch (error) {
      setMessageActionError({ messageId: message.id, text: errorMessage(error, "Could not permanently delete this message.") });
    } finally {
      setMessageActionBusyId(null);
    }
  }

  function retryMessage(friendId: string, message: ChatMessage): void {
    if (!message.clientId) return;
    updateConversation(friendId, (current) => retryChatMessage(current, message.clientId!));
    transmitMessage(friendId, { ...message, deliveryState: "pending" });
  }

  function openConversation(friendId: string): void {
    setMobileGroupMembersOpen(false);
    setSelectedFriendId(friendId);
    setMobileConversationOpen(true);
    setSearchParams({ friend: friendId }, { replace: true });
  }

  function openGroupConversation(groupId: string): void {
    const key = `group:${groupId}`;
    setMobileGroupMembersOpen(false);
    setSelectedFriendId(key);
    setMobileConversationOpen(true);
    setSearchParams({ group: groupId }, { replace: true });
  }

  function closeConversation(): void {
    setMobileGroupMembersOpen(false);
    setSelectedFriendId(null);
    setMobileConversationOpen(false);
    setSearchParams({}, { replace: true });
  }

  const selectedFriend = friends.find((friend) => friend.id === selectedFriendId) ?? null;
  const selectedGroupId = selectedFriendId?.startsWith("group:") ? selectedFriendId.slice("group:".length) : null;
  const selectedGroup = selectedGroupId ? groups.find((group) => group.id === selectedGroupId) ?? null : null;
  const selectedGroupRole = selectedGroup?.participants.find((participant) => participant.id === userId)?.role ?? "member";
  const removableGroupParticipants = selectedGroup?.participants.filter((participant) =>
    participant.id !== userId && participant.role !== "owner" &&
    (selectedGroupRole === "owner" || (selectedGroupRole === "admin" && participant.role === "member")),
  ) ?? [];
  const selectedConversationName = selectedFriend?.displayName ?? selectedGroup?.name ?? "Group chat";
  const { presenceById, now: presenceNow } = useFriendPresence(friends.map((friend) => friend.id));
  const selectedPresence = selectedFriend ? presenceById[selectedFriend.id] : undefined;
  const selectedLastActive = lastActiveLabel(selectedPresence, presenceNow);
  const selectedMessages = selectedFriendId ? conversations[selectedFriendId] ?? [] : [];
  const visibleFriends = sortFriendsByLatestMessage(friends.filter((friend) => {
    const latestMessage = conversations[friend.id]?.at(-1);
    return (chatFilter === "all" || (unreadCounts[friend.id] ?? 0) > 0) && `${friend.displayName} ${latestMessage?.text || (latestMessage?.photoUrl ? "Photo" : "")}`
      .toLocaleLowerCase()
      .includes(conversationSearch.trim().toLocaleLowerCase());
  }), conversations);
  const visibleGroups = groups.filter((group) => {
    const latestMessage = conversations[`group:${group.id}`]?.at(-1) ?? group.latestMessage;
    return (chatFilter === "all" || (unreadCounts[`group:${group.id}`] ?? group.unreadCount) > 0) &&
      `${group.name} ${group.participants.map((participant) => participant.displayName).join(" ")} ${latestMessage?.text || (latestMessage?.photoUrl ? "Photo" : "")}`
        .toLocaleLowerCase()
        .includes(conversationSearch.trim().toLocaleLowerCase());
  });

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

  useEffect(() => {
    if (!photoAttachment) {
      setPhotoPreviewUrl(null);
      return;
    }
    const previewUrl = URL.createObjectURL(photoAttachment);
    setPhotoPreviewUrl(previewUrl);
    return () => URL.revokeObjectURL(previewUrl);
  }, [photoAttachment]);

  useEffect(() => {
    if (!attachmentMenuOpen) return;
    const dismissOnOutsidePointer = (event: PointerEvent) => {
      if (!attachmentMenuRef.current?.contains(event.target as Node)) setAttachmentMenuOpen(false);
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setAttachmentMenuOpen(false);
        attachmentToggleRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", dismissOnOutsidePointer);
    document.addEventListener("keydown", dismissOnEscape);
    return () => {
      document.removeEventListener("pointerdown", dismissOnOutsidePointer);
      document.removeEventListener("keydown", dismissOnEscape);
    };
  }, [attachmentMenuOpen]);

  useEffect(() => {
    if (!openMessageMenuId) return;
    const dismissOnOutsidePointer = (event: PointerEvent) => {
      if (!messageMenuRef.current?.contains(event.target as Node)) setOpenMessageMenuId(null);
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenMessageMenuId(null);
        messageMenuButtonRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", dismissOnOutsidePointer);
    document.addEventListener("keydown", dismissOnEscape);
    return () => {
      document.removeEventListener("pointerdown", dismissOnOutsidePointer);
      document.removeEventListener("keydown", dismissOnEscape);
    };
  }, [openMessageMenuId]);

  useEffect(() => {
    if (editingMessageId) messageEditInputRef.current?.focus();
  }, [editingMessageId]);

  return (
    <main className={`messages-shell${mobileConversationOpen ? " messages-shell-conversation-open" : ""}`}>
      <aside className="messages-sidebar" aria-label="Chats">
        <header className="messages-sidebar-heading">
          <h1>Chats</h1>
          <button type="button" onClick={() => { setGroupCreateError(null); setGroupDialogOpen(true); }} aria-label="Create group chat" title="New group chat">+</button>
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
          ) : friends.length === 0 && groups.length === 0 ? (
            <EmptyState title="No chats yet" message="Add some friends, then create a group chat from the plus button." />
          ) : visibleFriends.length === 0 && visibleGroups.length === 0 ? (
            <p className="messages-list-empty">{chatFilter === "unread" ? "No unread messages." : "No chats match your search."}</p>
          ) : (
            <>
              {visibleGroups.length > 0 && <section className="messages-chat-list-section" aria-label="Group conversations">
                <h2>Groups</h2>
                <ul className="chat-friend-list">
                  {visibleGroups.map((group) => {
                    const key = `group:${group.id}`;
                    const recentMessage = conversations[key]?.at(-1) ?? group.latestMessage;
                    const unreadCount = unreadCounts[key] ?? group.unreadCount;
                    return <li key={key}>
                      <button className={`chat-friend-button ${selectedFriendId === key ? "chat-friend-button-active" : ""}`} type="button" aria-pressed={selectedFriendId === key} onClick={() => openGroupConversation(group.id)}>
                        <GroupChatAvatar name={group.name} />
                        <span className="chat-friend-copy">
                          <strong>{group.name}</strong>
                          <span>{recentMessage ? `${recentMessage.senderId === userId ? "You: " : `${group.participants.find((participant) => participant.id === recentMessage.senderId)?.displayName ?? "Member"}: `}${recentMessage.text || (recentMessage.photoUrl ? "Photo" : "")}` : `${group.participants.length} members`}</span>
                        </span>
                        {unreadCount > 0 && <span className="chat-unread-dot" role="img" aria-label={`${unreadCount} unread messages`} />}
                      </button>
                    </li>;
                  })}
                </ul>
              </section>}
              {visibleFriends.length > 0 && <section className="messages-chat-list-section" aria-label="Friend conversations">
                {visibleGroups.length > 0 && <h2>Friends</h2>}
                <ul className="chat-friend-list">
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
                            <span>{recentMessage ? `${recentMessage.senderId === userId ? "You: " : ""}${recentMessage.text || (recentMessage.photoUrl ? "Photo" : "")}` : "Start a conversation"}</span>
                          </span>
                          {lastActive && <time className="chat-friend-time chat-presence-time" dateTime={presence?.lastActiveAt} title="Last active">{lastActive}</time>}
                          {(unreadCounts[friend.id] ?? 0) > 0 && <span className="chat-unread-dot" role="img" aria-label={`${unreadCounts[friend.id]} unread messages`} />}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>}
            </>
          )}
          {friendsLoadingMore && <ChatListSkeleton count={2} />}
          {friendsMoreError && <p className="friend-feedback friend-feedback-error" role="alert">{friendsMoreError}</p>}
          {friendsCursor && <button className="button-secondary chat-load-more" type="button" onClick={() => void loadMoreFriends()} disabled={friendsLoadingMore}>{friendsLoadingMore ? "Loading friends…" : "Load more friends"}</button>}
        </div>
      </aside>

        <section className="chat-conversation-panel messages-conversation" aria-label={selectedFriend || selectedGroup ? `Conversation with ${selectedConversationName}` : "Conversation"}>
          {selectedFriend || selectedGroup ? (
            <>
              <header className="chat-conversation-header">
                <div className="messages-conversation-identity">
                  <button className="messages-mobile-back" type="button" onClick={closeConversation} aria-label="Back to chats" title="Back to chats">
                    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /><path d="M9 12h12" /></svg>
                  </button>
                  <div className="friend-person">
                    {selectedFriend
                      ? <>
                        <span className="chat-presence-avatar"><ChatFriendAvatar user={selectedFriend} />{selectedPresence?.isOnline && <span className="chat-online-dot" role="img" aria-label="Online" />}</span>
                        <div className="friend-person-copy">
                          <h2 className="friend-person-name"><Link className="messages-conversation-name-link" to={`/profile/${encodeURIComponent(selectedFriend.id)}`}>{selectedFriend.displayName}</Link> <SupporterBadge user={selectedFriend} /></h2>
                          {(connectionError || selectedPresence?.isOnline || selectedLastActive) && <p>{connectionError ? "Connection interrupted" : selectedPresence?.isOnline ? "Online" : `Active ${selectedLastActive}`}</p>}
                        </div>
                      </>
                      : <button className="messages-mobile-group-details" type="button" aria-label={`View members of ${selectedGroup?.name ?? "group chat"}`} aria-haspopup="dialog" onClick={() => setMobileGroupMembersOpen(true)}>
                        <GroupChatAvatar name={selectedConversationName} />
                        <span className="friend-person-copy">
                          <span className="friend-person-name">{selectedConversationName}</span>
                          <span className="messages-mobile-group-member-hint">{selectedGroup?.participants.length ?? 0} members <span>· View</span></span>
                        </span>
                      </button>}
                  </div>
                </div>
                <div className="messages-chat-actions">
                  {selectedGroup && <div className="messages-mobile-group-menu">
                    <button className="messages-group-menu-button" type="button" aria-label="Group options" aria-haspopup="menu" aria-expanded={groupActionsOpen} onClick={() => { setGroupActionsOpen((open) => !open); setGroupActionError(null); }}>
                      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></svg>
                    </button>
                    {groupActionsOpen && <div className="messages-group-actions-menu" role="menu">
                      {(selectedGroupRole === "owner" || selectedGroupRole === "admin") && <>
                        <button type="button" role="menuitem" onClick={() => openGroupActionDialog("add")}>Add members</button>
                        <button type="button" role="menuitem" onClick={() => openGroupActionDialog("rename")}>Edit group name</button>
                        {removableGroupParticipants.length > 0 && <button type="button" role="menuitem" onClick={() => openGroupActionDialog("remove")}>Remove member</button>}
                      </>}
                      <button type="button" role="menuitem" onClick={() => { setGroupActionsOpen(false); void leaveGroup(); }}>Leave group</button>
                      {selectedGroupRole === "owner" && <button className="messages-group-danger-action" type="button" role="menuitem" onClick={() => { setGroupActionsOpen(false); void permanentlyDeleteGroup(); }}>Permanently delete group</button>}
                    </div>}
                  </div>}
                  <span className={`chat-connection chat-connection-${connectionState}`} role="status"><span className="chat-connection-dot" aria-hidden="true" />{connectionState === "connected" ? "Connected" : connectionState === "connecting" ? "Connecting…" : "Reconnecting…"}</span>
                </div>
              </header>
              {connectionError && <p className="friend-feedback friend-feedback-error" role="status">{connectionError}</p>}
              {historyError && <p className="friend-feedback friend-feedback-error" role="alert">{historyError}</p>}
              {reportStatus && <p className="friend-feedback" role="status">{reportStatus}</p>}
              {nextCursor && <button className="button-secondary chat-load-more" type="button" onClick={() => void loadOlderMessages()} disabled={historyLoadingMore}>{historyLoadingMore ? "Loading older messages…" : "Load older messages"}</button>}
              <div ref={messageScrollRef} className="chat-message-scroll" onScroll={trackMessageScroll} aria-live="polite" aria-relevant="additions text">
                {historyLoading && selectedMessages.length === 0 ? <MessageBubblesSkeleton /> : selectedMessages.length === 0 ? (
                  <EmptyState title="Start the conversation" message={`Send a message to ${selectedConversationName}.`} />
                ) : (
                  <ol className="chat-message-list" aria-label="Messages">
                    {selectedMessages.map((message) => {
                      const isOwnMessage = message.senderId === user?.id;
                      const messageSender = selectedGroup?.participants.find((participant) => participant.id === message.senderId) ?? selectedFriend;
                      const messageActions = message.deliveryState === "acknowledged" && !message.id.startsWith("local:") ? (
                        <div
                          className={`chat-message-actions${isOwnMessage ? " chat-message-actions-own" : ""}`}
                          ref={openMessageMenuId === message.id ? messageMenuRef : null}
                        >
                          <button
                            ref={openMessageMenuId === message.id ? messageMenuButtonRef : null}
                            className="chat-message-menu-trigger"
                            type="button"
                            onClick={() => setOpenMessageMenuId((current) => current === message.id ? null : message.id)}
                            aria-label="Message options"
                            aria-expanded={openMessageMenuId === message.id}
                            title="Message options"
                          >
                            <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
                          </button>
                          {openMessageMenuId === message.id && (
                            <div className="chat-message-menu" role="menu" aria-label="Message actions">
                              {isOwnMessage ? <>
                              <button type="button" role="menuitem" onClick={() => beginMessageEdit(message)} disabled={messageActionBusyId === message.id}>
                                <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m15 5 4 4M4 20l4.3-.9L19 8.4 15.6 5 4.9 15.7 4 20Z" /></svg>
                                <span>Edit message</span>
                              </button>
                              <button className="chat-message-delete" type="button" role="menuitem" onClick={() => void permanentlyDeleteMessage(selectedFriendId!, message)} disabled={messageActionBusyId === message.id}>
                                <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>
                                <span>Delete permanently</span>
                              </button>
                              </> : <button type="button" role="menuitem" onClick={() => {
                                setOpenMessageMenuId(null);
                                setReportStatus(null);
                                setReportingMessageId(message.id);
                              }}>
                                <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M5 21V4m0 1h12l-2.5 4L17 13H5" /></svg>
                                <span>Report message</span>
                              </button>}
                            </div>
                          )}
                        </div>
                      ) : null;
                      return (
                        <li key={message.id} className={`chat-message-row ${isOwnMessage ? "chat-message-row-own" : ""}`}>
                          {isOwnMessage && messageActions}
                          {!isOwnMessage && messageSender && <span className="chat-message-sender-avatar" role="img" aria-label={`${messageSender.displayName}'s profile picture`} title={messageSender.displayName}>
                            <ChatFriendAvatar user={messageSender} />
                          </span>}
                          <article className={`chat-message-bubble ${isOwnMessage ? "chat-message-bubble-own" : ""}`}>
                            {message.photoUrl && <img className="chat-message-photo" src={message.photoUrl} alt="Photo attachment" loading="lazy" />}
                            {editingMessageId === message.id ? (
                              <div className="chat-message-editor">
                                <label className="sr-only" htmlFor={`chat-message-edit-${message.id}`}>Edit message</label>
                                <textarea
                                  ref={messageEditInputRef}
                                  id={`chat-message-edit-${message.id}`}
                                  value={messageDraft}
                                  onChange={(event) => setMessageDraft(event.target.value)}
                                  maxLength={2_000}
                                  placeholder={message.photoUrl ? "Add a caption…" : "Write a message…"}
                                />
                                <div>
                                  <button type="button" onClick={() => { setEditingMessageId(null); setMessageActionError(null); }} disabled={messageActionBusyId === message.id}>Cancel</button>
                                  <button type="button" onClick={() => void saveMessageEdit(selectedFriendId!, message)} disabled={messageActionBusyId === message.id || (!message.photoUrl && !messageDraft.trim())}>{messageActionBusyId === message.id ? "Saving…" : "Save"}</button>
                                </div>
                              </div>
                            ) : message.text ? <p>{message.text}</p> : null}
                            {messageActionError?.messageId === message.id && <p className="chat-message-action-error" role="alert">{messageActionError.text}</p>}
                            <MessageMeta message={message} isOwnMessage={isOwnMessage} isConnected={connectionState === "connected"} />
                            {message.deliveryState === "failed" && message.failureMessage && (
                              <div className="chat-message-failure">
                                <span>{message.failureMessage}</span>
                                <button type="button" onClick={() => retryMessage(selectedFriendId!, message)} disabled={!message.retryable}>Retry</button>
                              </div>
                            )}
                          </article>
                          {!isOwnMessage && messageActions}
                        </li>
                      );
                    })}
                  </ol>
                )}
              </div>
              <form className="chat-composer" onSubmit={sendMessage}>
                <label htmlFor="chat-message" className="sr-only">Message to {selectedConversationName}</label>
                <input ref={cameraInputRef} className="chat-photo-input" type="file" accept={CHAT_PHOTO_MIME_TYPES.join(",")} capture="environment" onChange={selectPhoto} />
                <input ref={imageInputRef} className="chat-photo-input" type="file" accept={CHAT_PHOTO_MIME_TYPES.join(",")} onChange={selectPhoto} />
                {photoAttachment && photoPreviewUrl && (
                  <div className="chat-composer-attachment">
                    <img src={photoPreviewUrl} alt={`Preview of ${photoAttachment.name}`} />
                    <button type="button" onClick={() => { setPhotoAttachment(null); setPhotoAttachmentError(null); }} disabled={photoUploading} aria-label="Remove attached image" title="Remove image">×</button>
                    <span>{photoAttachment.name}</span>
                  </div>
                )}
                {photoAttachmentError && <p className="chat-composer-error" role="alert">{photoAttachmentError}</p>}
                <div className="chat-composer-input-line">
                  <div className="chat-composer-tools" ref={attachmentMenuRef}>
                    <button
                      ref={attachmentToggleRef}
                      className={`chat-composer-add${attachmentMenuOpen ? " chat-composer-add-open" : ""}`}
                      type="button"
                      onClick={() => setAttachmentMenuOpen((open) => !open)}
                      disabled={photoUploading}
                      aria-label={attachmentMenuOpen ? "Close attachment options" : "Add a photo or image"}
                      aria-expanded={attachmentMenuOpen}
                      aria-controls="chat-attachment-options"
                      title={attachmentMenuOpen ? "Close attachment options" : "Add a photo or image"}
                    >
                      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
                    </button>
                    <div className="chat-attachment-options" id="chat-attachment-options" aria-label="Add to message" hidden={!attachmentMenuOpen}>
                      <button type="button" onClick={() => { setAttachmentMenuOpen(false); cameraInputRef.current?.click(); }}>
                        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 8h3l1.5-2h7L17 8h3v11H4z" /><circle cx="12" cy="13" r="3.2" /></svg>
                        <span>Take a photo</span>
                      </button>
                      <button type="button" onClick={() => { setAttachmentMenuOpen(false); imageInputRef.current?.click(); }}>
                        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3.5" y="4" width="17" height="16" rx="2" /><circle cx="8.5" cy="9" r="1.2" /><path d="m5 17 5-5 3 3 2-2 4 4" /></svg>
                        <span>Choose an image</span>
                      </button>
                    </div>
                  </div>
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
                    placeholder={`Write a message to ${selectedConversationName}…`}
                    disabled={photoUploading}
                  />
                  {(composerText.trim() || photoAttachment) && (
                    <button className="chat-composer-send" type="submit" aria-label={photoUploading ? "Sending image" : "Send message"} title={photoUploading ? "Sending image" : "Send message"} disabled={photoUploading}>
                      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h13" /><path d="m13 6 6 6-6 6" /></svg>
                    </button>
                  )}
                  </div>
                </div>
                {photoUploading && <p className="chat-composer-status" role="status">Sending image…</p>}
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
      {groupActionDialog && selectedGroup && <div className="group-chat-dialog-backdrop" role="presentation" onMouseDown={(event) => {
        if (event.currentTarget === event.target && !groupActionBusy) setGroupActionDialog(null);
      }}>
        <section className="group-chat-dialog" role="dialog" aria-modal="true" aria-labelledby="group-manage-dialog-title">
          <header>
            <div>
              <h2 id="group-manage-dialog-title">{groupActionDialog === "rename" ? "Edit group name" : groupActionDialog === "add" ? "Add members" : "Remove member"}</h2>
              <p>{groupActionDialog === "rename" ? "Choose a name everyone in this group can recognize." : groupActionDialog === "add" ? "Choose friends to add to this group chat." : "Choose a member to remove from this group chat."}</p>
            </div>
            <button type="button" aria-label="Close" onClick={() => setGroupActionDialog(null)} disabled={groupActionBusy}>X</button>
          </header>
          <form onSubmit={(event) => void submitGroupAction(event)}>
            {groupActionDialog === "rename" ? <>
              <label className="group-chat-name-label" htmlFor="group-manage-name">Group name</label>
              <input id="group-manage-name" value={groupActionName} onChange={(event) => setGroupActionName(event.target.value)} maxLength={48} required />
            </> : groupActionDialog === "add" ? <>
              <div className="group-chat-member-heading"><strong>Friends</strong><span>{groupActionMemberIds.length} selected</span></div>
              <div className="group-chat-member-list">
                {friends.filter((friend) => !selectedGroup.participants.some((participant) => participant.id === friend.id)).map((friend) => <label className="group-chat-member" key={friend.id}>
                  <ChatFriendAvatar user={friend} />
                  <span>{friend.displayName}</span>
                  <input type="checkbox" checked={groupActionMemberIds.includes(friend.id)} onChange={(event) => setGroupActionMemberIds((current) => event.target.checked ? [...current, friend.id] : current.filter((id) => id !== friend.id))} />
                </label>)}
                {friendsCursor && <button className="group-chat-load-friends" type="button" onClick={() => void loadMoreFriends()} disabled={friendsLoadingMore}>{friendsLoadingMore ? "Loading..." : "Load more friends"}</button>}
                {friends.every((friend) => selectedGroup.participants.some((participant) => participant.id === friend.id)) && !friendsCursor && <p className="group-chat-no-friends">All your loaded friends are already in this group.</p>}
              </div>
            </> : <>
              <div className="group-chat-member-heading"><strong>Group members</strong><span>{removableGroupParticipants.length} available</span></div>
              <div className="group-chat-remove-list">
                {removableGroupParticipants.map((participant) => <div className="group-chat-remove-row" key={participant.id}>
                  <ChatFriendAvatar user={participant} />
                  <span>{participant.displayName}</span>
                  <span className={`messages-group-role messages-group-role-${participant.role}`}>{participant.role}</span>
                  <button className="messages-group-remove-member" type="button" disabled={Boolean(groupMemberRemovingId)} onClick={() => void removeGroupMember(participant.id, participant.displayName)}>{groupMemberRemovingId === participant.id ? "Removing..." : "Remove"}</button>
                </div>)}
                {removableGroupParticipants.length === 0 && <p className="group-chat-no-friends">There are no members you can remove.</p>}
              </div>
            </>}
            {groupActionError && <p className="group-chat-error" role="alert">{groupActionError}</p>}
            <footer>
              <button className="button-secondary" type="button" onClick={() => setGroupActionDialog(null)} disabled={groupActionBusy || Boolean(groupMemberRemovingId)}>Close</button>
              {groupActionDialog !== "remove" && <button className="button-primary" type="submit" disabled={groupActionBusy || (groupActionDialog === "rename" ? !groupActionName.trim() : groupActionMemberIds.length === 0)}>{groupActionBusy ? "Saving..." : groupActionDialog === "rename" ? "Save name" : "Add members"}</button>}
            </footer>
          </form>
        </section>
      </div>}
      {mobileGroupMembersOpen && selectedGroup && <div className="group-chat-dialog-backdrop messages-mobile-members-backdrop" role="presentation" onMouseDown={(event) => {
        if (event.currentTarget === event.target) setMobileGroupMembersOpen(false);
      }}>
        <section className="group-chat-dialog messages-mobile-members-dialog" role="dialog" aria-modal="true" aria-labelledby="mobile-group-members-title">
          <header>
            <div>
              <h2 id="mobile-group-members-title">{selectedGroup.name}</h2>
              <p>{selectedGroup.participants.length} members</p>
            </div>
            <button type="button" aria-label="Close" onClick={() => setMobileGroupMembersOpen(false)}>×</button>
          </header>
          <div className="messages-mobile-member-list" aria-label="Group members">
            {selectedGroup.participants.map((participant) => <div className="messages-group-member-row" key={participant.id}>
              <Link to={`/profile/${encodeURIComponent(participant.id)}`} onClick={() => setMobileGroupMembersOpen(false)}>
                <span className="chat-avatar">{participant.avatarUrl ? <img src={participant.avatarUrl} alt="" /> : participant.displayName.trim().charAt(0).toUpperCase()}</span>
                <span className="messages-group-member-name">
                  <span className="messages-group-member-display-name">{participant.displayName} {participant.id === userId ? "(You)" : ""}</span>
                  <SupporterBadge user={participant} />
                </span>
              </Link>
              <span className={`messages-group-role messages-group-role-${participant.role}`}>{participant.role}</span>
            </div>)}
          </div>
        </section>
      </div>}
      {groupDialogOpen && <div className="group-chat-dialog-backdrop" role="presentation" onMouseDown={(event) => {
        if (event.currentTarget === event.target && !groupCreating) setGroupDialogOpen(false);
      }}>
        <section className="group-chat-dialog" role="dialog" aria-modal="true" aria-labelledby="group-chat-dialog-title">
          <header>
            <div><h2 id="group-chat-dialog-title">Create a group chat</h2><p>Choose at least two friends to start a shared conversation.</p></div>
            <button type="button" aria-label="Close" onClick={() => setGroupDialogOpen(false)} disabled={groupCreating}>×</button>
          </header>
          <form onSubmit={(event) => void createGroupConversation(event)}>
            <label className="group-chat-name-label" htmlFor="group-chat-name">Group name</label>
            <input id="group-chat-name" value={groupName} onChange={(event) => setGroupName(event.target.value)} maxLength={48} required placeholder="For example, Weekend plans" />
            <div className="group-chat-member-heading"><strong>Friends</strong><span>{groupMemberIds.length} selected</span></div>
            {friends.length === 0 ? <p className="group-chat-no-friends">Add friends before creating a group chat. <Link to="/friends" onClick={() => setGroupDialogOpen(false)}>Find friends</Link></p> : (
              <div className="group-chat-member-list">
                {friends.map((friend) => <label className="group-chat-member" key={friend.id}>
                  <ChatFriendAvatar user={friend} />
                  <span>{friend.displayName}</span>
                  <input
                    type="checkbox"
                    checked={groupMemberIds.includes(friend.id)}
                    onChange={(event) => setGroupMemberIds((current) => event.target.checked
                      ? [...current, friend.id]
                      : current.filter((id) => id !== friend.id))}
                  />
                </label>)}
                {friendsCursor && <button className="group-chat-load-friends" type="button" onClick={() => void loadMoreFriends()} disabled={friendsLoadingMore}>{friendsLoadingMore ? "Loading…" : "Load more friends"}</button>}
              </div>
            )}
            {groupCreateError && <p className="group-chat-error" role="alert">{groupCreateError}</p>}
            <footer>
              <button className="button-secondary" type="button" onClick={() => setGroupDialogOpen(false)} disabled={groupCreating}>Cancel</button>
              <button className="button-primary" type="submit" disabled={groupCreating || groupMemberIds.length < 2}>{groupCreating ? "Creating…" : "Create group"}</button>
            </footer>
          </form>
        </section>
      </div>}
      <ReportDialog
        open={(selectedFriend !== null || selectedGroup !== null) && reportingMessageId !== null}
        targetType="message"
        targetId={reportingMessageId ?? ""}
        onClose={() => setReportingMessageId(null)}
        onReported={() => setReportStatus("Thanks. Your report was sent to the moderators.")}
      />
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
        ) : selectedGroup ? (
          <>
            <div className="messages-info-profile">
              <GroupChatAvatar name={selectedGroup.name} />
              <h2>{selectedGroup.name}</h2>
              <p>{selectedGroup.participants.length} members</p>
            </div>
            <section className="messages-group-members" aria-label="Group members">
              <div className="messages-group-members-heading">
                <h3>Members</h3>
                <button className="messages-group-menu-button" type="button" aria-label="Group options" aria-expanded={groupActionsOpen} onClick={() => { setGroupActionsOpen((open) => !open); setGroupActionError(null); }}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></svg>
                </button>
                {groupActionsOpen && <div className="messages-group-actions-menu" role="menu">
                  {(selectedGroupRole === "owner" || selectedGroupRole === "admin") && <>
                    <button type="button" role="menuitem" onClick={() => openGroupActionDialog("add")}>Add members</button>
                    <button type="button" role="menuitem" onClick={() => openGroupActionDialog("rename")}>Edit group name</button>
                    {removableGroupParticipants.length > 0 && <button type="button" role="menuitem" onClick={() => openGroupActionDialog("remove")}>Remove member</button>}
                  </>}
                  <button type="button" role="menuitem" onClick={() => { setGroupActionsOpen(false); void leaveGroup(); }}>Leave group</button>
                  {selectedGroupRole === "owner" && <button className="messages-group-danger-action" type="button" role="menuitem" onClick={() => { setGroupActionsOpen(false); void permanentlyDeleteGroup(); }}>Permanently delete group</button>}
                </div>}
              </div>
              {selectedGroup.participants.map((participant) => <div className="messages-group-member-row" key={participant.id}>
                <Link to={`/profile/${encodeURIComponent(participant.id)}`}>
                  <span className="chat-avatar">{participant.avatarUrl ? <img src={participant.avatarUrl} alt="" /> : participant.displayName.trim().charAt(0).toUpperCase()}</span>
                  <span className="messages-group-member-name">
                    <span className="messages-group-member-display-name">{participant.displayName} {participant.id === userId ? "(You)" : ""}</span>
                    <SupporterBadge user={participant} />
                  </span>
                </Link>
                {selectedGroupRole === "owner" && participant.id !== userId ? <select aria-label={`Role for ${participant.displayName}`} value={participant.role} disabled={Boolean(groupRoleBusyId)} onChange={(event) => void changeGroupRole(participant.id, event.target.value as GroupMemberRole)}>
                  <option value="member">Member</option><option value="admin">Admin</option><option value="owner">Transfer owner</option>
                </select> : <span className={`messages-group-role messages-group-role-${participant.role}`}>{participant.role}</span>}
              </div>)}
              {groupActionError && !groupActionDialog && <p className="group-chat-error" role="alert">{groupActionError}</p>}
              {groupActionStatus && <p className="messages-group-status" role="status">{groupActionStatus}</p>}
              {selectedGroupRole === "owner" && <p className="messages-group-owner-hint">Transfer ownership before leaving the group.</p>}
            </section>
          </>
        ) : friendsLoading ? (
          <SkeletonRegion message="Loading chat information" className="skeleton-info-panel"><SkeletonBlock className="skeleton-avatar skeleton-profile-avatar" /><SkeletonBlock className="skeleton-line skeleton-w-65" /></SkeletonRegion>
        ) : <p className="messages-info-placeholder">Choose a chat to see its details.</p>}
      </aside>
    </main>
  );
}
