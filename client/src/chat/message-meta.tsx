import type { ChatMessage } from "./message-state";

function messageTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
}

export function MessageMeta({ message, isOwnMessage, isConnected }: {
  message: ChatMessage;
  isOwnMessage: boolean;
  isConnected: boolean;
}) {
  return (
    <div className="chat-message-meta">
      <time dateTime={message.createdAt}>{messageTime(message.createdAt)}</time>
      {message.editedAt && <span>Edited</span>}
      {isOwnMessage && message.deliveryState === "pending" && <span>{isConnected ? "Sending…" : "Queued"}</span>}
      {isOwnMessage && message.deliveryState === "acknowledged" && <span className={`chat-message-read-receipt${message.isRead ? " chat-message-read-receipt-seen" : ""}`} role="img" aria-label={message.isRead ? "Seen" : "Sent"} title={message.isRead ? "Seen" : "Sent"}>
        {message.isRead
          ? <svg aria-hidden="true" viewBox="0 0 18 14"><path d="m1.5 7.5 3.2 3.2 6.4-6.5M6.5 7.5l3.2 3.2 6.4-6.5" /></svg>
          : <svg aria-hidden="true" viewBox="0 0 18 14"><path d="m3 7.5 3.2 3.2 7-7" /></svg>}
      </span>}
      {isOwnMessage && message.deliveryState === "failed" && <span className="chat-message-failed">Failed</span>}
    </div>
  );
}
