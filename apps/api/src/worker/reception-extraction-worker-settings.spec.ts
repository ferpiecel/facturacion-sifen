import { describe, expect, it } from 'vitest';
import {
  RECEPTION_EXTRACTION_LOCK_DURATION_MS,
  RECEPTION_EXTRACTION_MAX_STALLED_COUNT,
  receptionExtractionWorkerSettings,
} from './queue.js';

describe('reception extraction worker settings', () => {
  it('allows at least one stalled requeue before BullMQ fails the job', () => {
    expect(RECEPTION_EXTRACTION_MAX_STALLED_COUNT).toBeGreaterThanOrEqual(1);
    expect(receptionExtractionWorkerSettings().maxStalledCount).toBe(
      RECEPTION_EXTRACTION_MAX_STALLED_COUNT,
    );
  });

  it('keeps a modest lock independent of the LLM timeout', () => {
    // LLM calls are async I/O and BullMQ renews the lock meanwhile; only CPU-bound sections can
    // starve the renewal, and a long lock would delay stall recovery by minutes.
    expect(receptionExtractionWorkerSettings().lockDuration).toBe(
      RECEPTION_EXTRACTION_LOCK_DURATION_MS,
    );
    expect(RECEPTION_EXTRACTION_LOCK_DURATION_MS).toBeGreaterThanOrEqual(60_000);
    expect(RECEPTION_EXTRACTION_LOCK_DURATION_MS).toBeLessThanOrEqual(120_000);
  });
});
