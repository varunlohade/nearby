import { NEXCONN_APP_KEY, NEXCONN_SERVER } from '../config';
import type { CityConfig } from '../types';
import { createMockChat } from './mock';
import type { ChatService } from './types';

export type { ChatMessage, ChatService } from './types';

/** Live Nexconn chat when the App Key and the server-side secret are set; demo chat otherwise. */
export async function createChat(city: CityConfig): Promise<ChatService> {
  if (NEXCONN_APP_KEY && NEXCONN_SERVER) {
    const { createNexconnChat } = await import('./nexconn');
    return createNexconnChat(NEXCONN_APP_KEY);
  }
  return createMockChat(city);
}

export const roomIdFor = (city: CityConfig, areaId: string) => `nearby.${city.id}.${areaId}`.replace(/\./g, '_');
