export interface ChatMessage {
  id: string;
  roomId: string;
  userId: string;
  name: string;
  text: string;
  at: number;
}

export interface ChatIdentity { userId: string; name: string }

/** One room per area. Real (Nexconn open channel) and demo chat both follow this shape. */
export interface ChatService {
  mode: 'nexconn' | 'demo';
  label: string;
  /** Connect (or reconnect) as this identity. */
  connect(who: ChatIdentity): Promise<void>;
  /** Make sure the room exists. Called when someone builds a new area. */
  ensureRoom(roomId: string): Promise<void>;
  /** Enter a room. Returns recent messages; later ones arrive through onMessage. */
  join(roomId: string, onMessage: (m: ChatMessage) => void): Promise<ChatMessage[]>;
  leave(): Promise<void>;
  send(roomId: string, text: string): Promise<ChatMessage>;
}
