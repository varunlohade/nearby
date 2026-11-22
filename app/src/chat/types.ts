export interface ChatMessage {
  id: string;
  roomId: string;
  userId: string;
  name: string;
  text: string;
  at: number;
  image?: string;
}

export interface ChatIdentity { userId: string; name: string }
export interface ChatRoom {
  id: string;
  title: string;
  demoMessages?: {name: string; text: string}[];
  /** Label shown above the room title, e.g. "Chat room". */
  kind?: string;
}
export interface RoomEvents {
  message(message: ChatMessage): void;
  presence(count: number): void;
  metadata(values: Record<string, string>): void;
  availability(ready: boolean, detail?: string): void;
  metadataError(): void;
}

export interface ChatService {
  mode: 'nexconn' | 'demo';
  connect(who: ChatIdentity): Promise<ChatIdentity>;
  join(room: ChatRoom, events: RoomEvents): Promise<void>;
  leave(): Promise<void>;
  send(roomId: string, text: string, image?: File): Promise<ChatMessage>;
  offerCall?(id: string, name: string): void;
  earlier?(roomId: string, before: number): Promise<{messages: ChatMessage[]; more: boolean}>;
  write(roomId: string, key: string, value: string | null): Promise<void>;
}
