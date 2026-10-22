/** Count all live tabs and devices before treating a user as offline. */
const connections = new Map<string, Set<string>>();

export function addPresenceConnection(userId: string, socketId: string): void {
  const sockets = connections.get(userId) ?? new Set<string>();
  sockets.add(socketId);
  connections.set(userId, sockets);
}

export function removePresenceConnection(userId: string, socketId: string): boolean {
  const sockets = connections.get(userId);
  if (!sockets) return false;
  sockets.delete(socketId);
  if (sockets.size > 0) return false;
  connections.delete(userId);
  return true;
}

export function isUserOnline(userId: string): boolean {
  return (connections.get(userId)?.size ?? 0) > 0;
}
