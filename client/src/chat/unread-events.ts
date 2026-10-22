export const CHAT_UNREAD_CHANGED_EVENT = "senderi:chat-unread-changed";

export function notifyChatUnreadChanged(): void {
  window.dispatchEvent(new Event(CHAT_UNREAD_CHANGED_EVENT));
}
