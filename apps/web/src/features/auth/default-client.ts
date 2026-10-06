import { createAuthClient } from './auth-client';

/** The browser-side client shared by the auth screens (same-origin proxy, cookies included). */
export const authClient = createAuthClient();
