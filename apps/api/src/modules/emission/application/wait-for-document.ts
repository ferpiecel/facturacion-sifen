import type { DocumentResponse } from './get-document.js';

/** Statuses SIFEN has settled; a document in any other status is still on its way. */
const FINAL_STATUSES = new Set(['approved', 'approved_with_observations', 'rejected']);

export interface WaitForDocumentDeps {
  /** Whether the tenant opted in to synchronous transmission (HU-E6-06). */
  isSyncEnabled(tenantId: string): Promise<boolean>;
  getDocument(tenantId: string, by: { id: string }): Promise<DocumentResponse | null>;
  timeoutMs: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * HU-E6-06, `?wait=true`: for a tenant with the synchronous flag, polls the document until SIFEN
 * settles it or `timeoutMs` passes. Returns the final document, or `null` when the caller should
 * answer the usual 202 (no flag, timeout, or document not readable). It only observes: sending is
 * done by the worker cycle (`TRANSMISSION_CYCLE_INTERVAL_MS`).
 */
export function createWaitForDocument(deps: WaitForDocumentDeps) {
  const pollMs = deps.pollMs ?? 500;
  const now = deps.now ?? Date.now;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return async (tenantId: string, documentId: string): Promise<DocumentResponse | null> => {
    if (!(await deps.isSyncEnabled(tenantId))) return null;
    const deadline = now() + deps.timeoutMs;
    for (;;) {
      const found = await deps.getDocument(tenantId, { id: documentId });
      if (!found) return null;
      if (FINAL_STATUSES.has(found.status)) return found;
      const remaining = deadline - now();
      if (remaining <= 0) return null;
      await sleep(Math.min(pollMs, remaining));
    }
  };
}
