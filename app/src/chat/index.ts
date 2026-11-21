import { createMockChat } from './mock';
import type { ChatService } from './types';

export type { ChatMessage, ChatService, ChatRoom, RoomEvents } from './types';

export async function createChat(): Promise<ChatService> {
  const response = await fetch('/api/nexconn/config', {cache: 'no-store'});
  // A static export supports the local demo without a token server.
  if (response.status === 404 || (response.ok && response.headers.get('content-type')?.includes('text/html'))) return createMockChat();
  if (!response.ok) throw new Error('Nexconn configuration unavailable');
  const {appKey, region} = await response.json();
  if (!appKey) return createMockChat();
  const { createNexconnChat } = await import('./nexconn');
  return createNexconnChat(appKey, region);
}
