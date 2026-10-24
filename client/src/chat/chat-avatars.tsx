import { useState } from "react";
import type { User } from "../../../shared";

export function ChatFriendAvatar({ user }: { user: User }) {
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

export function GroupChatAvatar({ name }: { name: string }) {
  return (
    <span className="chat-avatar group-chat-avatar" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="9" cy="8" r="3" /><path d="M3.5 19v-1a5.5 5.5 0 0 1 11 0v1" /><path d="M16 5.5a3 3 0 0 1 0 5.8M17 14a5 5 0 0 1 3.5 4.8V19" />
      </svg>
      <span className="sr-only">{name}</span>
    </span>
  );
}
