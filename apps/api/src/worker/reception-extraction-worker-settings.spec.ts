import { describe, expect, it } from 'vitest';
import {
  RECEPTION_EXTRACTION_MAX_STALLED_COUNT,
  receptionExtractionWorkerSettings,
} from './queue.js';

describe('reception extraction worker settings', () => {
  it('allows at least one stalled requeue before BullMQ fails the job', () => {
    expect(RECEPTION_EXTRACTION_MAX_STALLED_COUNT).toBeGreaterThanOrEqual(1);
    expect(receptionExtractionWorkerSettings(120_000).maxStalledCount).toBe(
      RECEPTION_EXTRACTION_MAX_STALLED_COUNT,
    );
  });

  it('keeps the lock longer than the slowest run (two LLM calls of the primary and fallback model)', () => {
    expect(receptionExtractionWorkerSettings(120_000).lockDuration).toBeGreaterThan(2 * 120_000);
    expect(receptionExtractionWorkerSettings(600_000).lockDuration).toBeGreaterThan(2 * 600_000);
  });

  it('never goes below the 5 minute floor', () => {
    expect(receptionExtractionWorkerSettings(1_000).lockDuration).toBe(300_000);
  });
});
