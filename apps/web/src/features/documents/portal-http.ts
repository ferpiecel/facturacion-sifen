import type { FetchLike } from '../auth/auth-client';
import { authClient } from '../auth/default-client';

export type Failure = { kind: 'unauthenticated' } | { kind: 'unavailable' };

export interface PortalHttpOptions {
  fetchImpl?: FetchLike;
  /** Recovers an expired session (refresh); `false` means the user must sign in again, a rejection means transient. */
  ensureSession?: () => Promise<boolean>;
}

/**
 * GET helper shared by the portal clients: same-origin requests with the session cookies, one session recovery on
 * a 401, and a lost session or a network error mapped to the shared `Failure`s.
 */
export function createPortalHttp({
  fetchImpl = (url, init) => fetch(url, init),
  ensureSession = async () => {
    const result = await authClient.me();
    if (result.kind === 'ok') return true;
    // Only a gone session logs out; a transient failure (5xx, 429, network) is a retryable error.
    if (result.kind === 'unauthenticated') return false;
    throw new Error('session check unavailable');
  },
}: PortalHttpOptions = {}) {
  const get = (url: string) => fetchImpl(url, { method: 'GET', credentials: 'include' });

  /** GET with one session recovery on 401; `null` means the session is gone. */
  async function session(target: string): Promise<Response | null> {
    const first = await get(target);
    if (first.status !== 401) return first;
    if (!(await ensureSession())) return null;
    const second = await get(target);
    return second.status === 401 ? null : second;
  }

  return {
    run: async <T>(
      target: string,
      handle: (response: Response) => Promise<T>,
    ): Promise<T | Failure> => {
      try {
        const response = await session(target);
        if (!response) return { kind: 'unauthenticated' };
        return await handle(response);
      } catch {
        return { kind: 'unavailable' };
      }
    },
  };
}
