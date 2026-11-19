import { BENGALURU } from './cities/bengaluru';
import { SINGAPORE } from './cities/singapore';

/** The one-line city switch: BENGALURU or SINGAPORE. */
export const CITY = BENGALURU;

export const CITIES = { BENGALURU, SINGAPORE };

/** Injected by vite.config.ts from ../.env. Empty string means "not set". */
export const NEXCONN_APP_KEY: string = __NEXCONN_APP_KEY__;
/** True when the dev/preview server holds a Nexconn App Secret and can issue tokens. */
export const NEXCONN_SERVER: boolean = __NEXCONN_SERVER__;
