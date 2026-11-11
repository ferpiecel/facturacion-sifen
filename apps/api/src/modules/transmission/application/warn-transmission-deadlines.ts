import {
  DEADLINE_WARNING_HOURS,
  TRANSMISSION_WINDOW_MS,
  hoursRemaining,
  transmissionDeadline,
} from '../domain/transmission-deadline.js';
import type { DeadlineWarning, DeadlineWarningStore } from './ports/deadline-warning-store.port.js';

export interface WarnTransmissionDeadlinesDeps {
  readonly store: DeadlineWarningStore;
  readonly now: () => Date;
}

/**
 * HU-E6-07: one pass of the deadline watch for a tenant. A pending document that crossed the 48 h or
 * the 66 h mark and is still inside its 72 h window gets that threshold's warning. Running it again
 * is harmless: the store never repeats a (document, threshold) warning.
 */
export class WarnTransmissionDeadlines {
  constructor(private readonly deps: WarnTransmissionDeadlinesDeps) {}

  async run(): Promise<{ warned: number }> {
    const now = this.deps.now();
    const after = new Date(now.getTime() - TRANSMISSION_WINDOW_MS);
    const warnings: DeadlineWarning[] = [];
    for (const thresholdHours of DEADLINE_WARNING_HOURS) {
      const until = new Date(now.getTime() - thresholdHours * 3_600_000);
      for (const doc of await this.deps.store.findPending({ after, until })) {
        const deadline = transmissionDeadline(doc.signedAt);
        warnings.push({
          documentId: doc.id,
          cdc: doc.cdc,
          thresholdHours,
          deadline,
          hoursRemaining: hoursRemaining(deadline, now),
        });
      }
    }
    if (warnings.length > 0) await this.deps.store.enqueue(warnings, now);
    return { warned: warnings.length };
  }
}
