import { describe, expect, it } from 'vitest';
import {
  RECEPTION_EKUATIA_LOCK_DURATION_MS,
  RECEPTION_EKUATIA_MAX_STALLED_COUNT,
  receptionEkuatiaWorkerSettings,
} from './queue.js';

describe('reception eKuatia lookup worker settings', () => {
  it('never reruns a stalled lookup: a rerun would solve another paid captcha', () => {
    expect(RECEPTION_EKUATIA_MAX_STALLED_COUNT).toBe(0);
    expect(receptionEkuatiaWorkerSettings().maxStalledCount).toBe(0);
  });

  it('outlasts one solve plus one consultation at their default timeouts', () => {
    // 2Captcha default 120 s + eKuatia default 30 s.
    expect(receptionEkuatiaWorkerSettings().lockDuration).toBe(RECEPTION_EKUATIA_LOCK_DURATION_MS);
    expect(RECEPTION_EKUATIA_LOCK_DURATION_MS).toBeGreaterThanOrEqual(150_000);
  });
});
