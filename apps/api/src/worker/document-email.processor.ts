import { assertValidTenantId, type Database } from '@sifen/db';
import type { SignedXmlReader } from '../modules/emission/application/ports/signed-xml-reader.port.js';
import type { KudeResult } from '../modules/emission/application/get-kude.js';
import type { DocumentMailer } from '../modules/email/application/ports/document-mailer.port.js';
import {
  createSendDocumentEmails,
  type SendSummary,
} from '../modules/email/application/send-document-emails.js';
import { createDrizzleDocumentEmailStore } from '../modules/email/infrastructure/drizzle-document-email-store.js';

/**
 * Document email job wiring (HU-E11-02, queue `document-email`). Free of `bullmq`, like the webhook
 * delivery job: `worker.ts` owns the Worker/Queue bootstrap and schedules one repeatable
 * `documentEmailJob(tenantId)` per active tenant (idempotent through its scheduler key).
 */
export const DOCUMENT_EMAIL_QUEUE = 'document-email';
const JOB_NAME = 'send';
const DEFAULT_EVERY_MS = 30_000;

export interface DocumentEmailJobData {
  readonly tenantId: string;
}

export function documentEmailJob(tenantId: string, everyMs = DEFAULT_EVERY_MS) {
  return {
    name: JOB_NAME,
    data: { tenantId } satisfies DocumentEmailJobData,
    opts: {
      repeat: { every: everyMs },
      jobId: `document-email:${tenantId}`,
      removeOnComplete: true,
      removeOnFail: 100,
    },
  };
}

export interface DocumentEmailProcessorDeps {
  readonly db: Database;
  readonly mailer: DocumentMailer;
  readonly getKude: (tenantId: string, documentId: string) => Promise<KudeResult>;
  readonly reader: SignedXmlReader;
  readonly now?: () => Date;
  readonly batchSize?: number;
  readonly logger?: { warn(message: string): void };
}

/** Runs one send pass for the job's tenant. The tenant id is validated before any query is built. */
export function createDocumentEmailProcessor(deps: DocumentEmailProcessorDeps) {
  return async (job: { data: DocumentEmailJobData }): Promise<SendSummary> => {
    const { tenantId } = job.data;
    assertValidTenantId(tenantId);
    const summary = await createSendDocumentEmails({
      store: createDrizzleDocumentEmailStore({ db: deps.db, tenantId }),
      mailer: deps.mailer,
      getKude: deps.getKude,
      reader: deps.reader,
      now: deps.now,
      batchSize: deps.batchSize,
      logger: deps.logger,
    })();
    if (summary.dead > 0 || summary.unrecorded > 0) {
      deps.logger?.warn(
        `document emails for tenant ${tenantId}: claimed=${String(summary.claimed)} sent=${String(summary.sent)} retried=${String(summary.retried)} dead=${String(summary.dead)} unrecorded=${String(summary.unrecorded)}`,
      );
    }
    return summary;
  };
}
