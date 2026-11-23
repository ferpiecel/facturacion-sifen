import { assertValidTenantId } from '@sifen/db';
import type {
  LookupCdcDocumentInput,
  LookupCdcDocumentResult,
} from '../modules/reception/application/lookup-cdc-document.js';
import type { EkuatiaLookupJobData } from '../modules/reception/infrastructure/adapters/bullmq-ekuatia-lookup-queue.adapter.js';

/**
 * eKuatia lookup job wiring (R6.3, queue `reception-ekuatia-lookup`). Free of `bullmq`, like the
 * other processors: `worker.ts` owns the Worker bootstrap. The queue name lives with the producer.
 */
export { RECEPTION_EKUATIA_LOOKUP_QUEUE } from '../modules/reception/infrastructure/adapters/bullmq-ekuatia-lookup-queue.adapter.js';
export type { EkuatiaLookupJobData };

export interface ReceptionEkuatiaJob {
  readonly data: EkuatiaLookupJobData;
}

export interface ReceptionEkuatiaProcessorDeps {
  readonly lookup: {
    execute(input: LookupCdcDocumentInput): Promise<LookupCdcDocumentResult>;
  };
  /** Ids, counts and stable codes only: never the CDC, the XML, a token, a URL or a key. */
  readonly logger?: { info(message: string): void; warn(message: string): void };
}

export interface ReceptionEkuatiaOutcome {
  readonly outcome: string;
}

const CDC = /^\d{44}$/;
const USAGE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Runs one lookup by CDC. Every result the use case reports (ingested, skipped or a stable
 * failure code) completes the job: the queue never retries a lookup (see
 * `RECEPTION_EKUATIA_LOOKUP_ATTEMPTS`), because each retry would solve another paid captcha. An
 * unexpected exception is logged by class and rethrown so BullMQ marks the job failed.
 */
export function createReceptionEkuatiaProcessor(deps: ReceptionEkuatiaProcessorDeps) {
  return async (job: ReceptionEkuatiaJob): Promise<ReceptionEkuatiaOutcome> => {
    const { tenantId, cdc, usageDate } = job.data;
    assertValidTenantId(tenantId);
    if (!CDC.test(cdc) || !USAGE_DATE.test(usageDate)) {
      deps.logger?.warn(`reception ekuatia lookup ${tenantId}: malformed job`);
      return { outcome: 'failed:invalid_job' };
    }
    let result: LookupCdcDocumentResult;
    try {
      result = await deps.lookup.execute({ tenantId, cdc, usageDate });
    } catch (error) {
      deps.logger?.warn(
        `reception ekuatia lookup ${tenantId}: unexpected ${error instanceof Error ? error.name : 'error'}`,
      );
      throw error;
    }
    switch (result.kind) {
      case 'ingested': {
        const outcome = result.created ? `ingested:${result.document.status}` : 'ingested:existing';
        deps.logger?.info(`reception ekuatia lookup ${tenantId}: ${outcome}`);
        return { outcome };
      }
      case 'skipped':
        deps.logger?.info(`reception ekuatia lookup ${tenantId}: skipped (${result.reason})`);
        return { outcome: `skipped:${result.reason}` };
      case 'failed':
        deps.logger?.warn(`reception ekuatia lookup ${tenantId}: failed ${result.code}`);
        return { outcome: `failed:${result.code}` };
    }
  };
}
