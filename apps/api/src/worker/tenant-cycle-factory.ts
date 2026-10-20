import {
  TipsDeXmlBuilder,
  TipsEventSigner,
  TipsEventXmlBuilder,
  TipsQrGenerator,
  TipsXmlSigner,
} from '@sifen/sifen-tips';
import type { Database } from '@sifen/db';
import { measureLoteMessage, type SifenGateway } from '@sifen/sifen-gateway';
import type {
  CertificateSource,
  CscSource,
} from '../modules/emission/application/ports/signing.port.js';
import { signingValidationConfig } from '../modules/emission/emission-validation-config.js';
import { SignDocument } from '../modules/emission/application/sign-document.js';
import { createDrizzleSigningStore } from '../modules/emission/infrastructure/drizzle-signing-store.js';
import { ResendPreflight } from '../modules/transmission/application/resend-preflight.js';
import { LoteAssembler } from '../modules/transmission/application/assemble-lotes.js';
import { PollLoteResult } from '../modules/transmission/application/poll-lote-result.js';
import {
  assertMaxQueries,
  RecoverLoteByCdc,
} from '../modules/transmission/application/recover-lote-by-cdc.js';
import { ResolveUnknownEvents } from '../modules/transmission/application/resolve-unknown-events.js';
import { SendEventBatch } from '../modules/transmission/application/send-event-batch.js';
import { SendLote } from '../modules/transmission/application/send-lote.js';
import { SignPendingEvent } from '../modules/transmission/application/sign-pending-event.js';
import {
  TransmissionCycle,
  type TransmissionCycleBatch,
} from '../modules/transmission/application/transmission-cycle.js';
import { createDrizzleEventBatchStore } from '../modules/transmission/infrastructure/drizzle-event-batch-store.js';
import { createDrizzleEventRecoveryStore } from '../modules/transmission/infrastructure/drizzle-event-recovery-store.js';
import { createDrizzleEventSigningStore } from '../modules/transmission/infrastructure/drizzle-event-signing-store.js';
import { validateEventXml } from '../modules/transmission/infrastructure/event-xsd-validator.js';
import { createDrizzleResendPreflightStore } from '../modules/transmission/infrastructure/drizzle-resend-preflight-store.js';
import { createDrizzleLoteAssemblyStore } from '../modules/transmission/infrastructure/drizzle-lote-assembly-store.js';
import { createDrizzleLoteDispatchStore } from '../modules/transmission/infrastructure/drizzle-lote-dispatch-store.js';
import { createDrizzleLoteRecoveryStore } from '../modules/transmission/infrastructure/drizzle-lote-recovery-store.js';
import { createDrizzleLotePollStore } from '../modules/transmission/infrastructure/drizzle-lote-poll-store.js';
import { createDrizzleTransmissionCycleStore } from '../modules/transmission/infrastructure/drizzle-transmission-cycle-store.js';

export interface TenantCycleFactoryDeps {
  readonly db: Database;
  readonly gateway: SifenGateway;
  readonly certificates: CertificateSource;
  readonly cscs: CscSource;
  readonly logger?: { warn(message: string): void };
  readonly now?: () => Date;
  /** Most CDC queries one recovery pass makes per lote (default 20, see `RecoverLoteByCdc`). */
  readonly recoveryMaxQueries?: number;
  /** Per-step batch sizes of the cycle (defaults in `TransmissionCycle`). */
  readonly batch?: TransmissionCycleBatch;
}

/**
 * Composition of one tenant's `TransmissionCycle` over the real Drizzle adapters: the API and the
 * worker are two entrypoints of the same code (ADR-0003). Every store runs in the tenant's own
 * transaction (ADR-0006).
 */
export function createTenantCycleFactory({
  db,
  gateway,
  certificates,
  cscs,
  logger,
  now,
  recoveryMaxQueries,
  batch,
}: TenantCycleFactoryDeps): (tenantId: string) => TransmissionCycle {
  // Fail when the worker is wired, not on the first tenant run.
  assertMaxQueries(recoveryMaxQueries);
  return (tenantId) => {
    const store = createDrizzleTransmissionCycleStore({ db, tenantId, now });
    const eventSigning = createDrizzleEventSigningStore({ db, tenantId });
    return new TransmissionCycle({
      tenantId,
      store,
      signer: new SignDocument({
        store: createDrizzleSigningStore({ db, now }),
        certificates,
        cscs,
        builder: new TipsDeXmlBuilder(),
        signer: new TipsXmlSigner(),
        qr: new TipsQrGenerator(),
        validation: signingValidationConfig(),
      }),
      assembler: new LoteAssembler({
        store: createDrizzleLoteAssemblyStore({ db, tenantId, now }),
        measureMessage: measureLoteMessage,
        logger,
        now,
        resendCheck: new ResendPreflight({
          gateway,
          store: createDrizzleResendPreflightStore({ db, tenantId, now }),
          nextRequestId: () => store.nextRequestId(),
        }),
      }),
      sender: new SendLote({
        gateway,
        store: createDrizzleLoteDispatchStore({ db, tenantId, now }),
      }),
      poller: new PollLoteResult({
        gateway,
        store: createDrizzleLotePollStore({ db, tenantId }),
        now,
      }),
      recoverer: new RecoverLoteByCdc({
        gateway,
        store: createDrizzleLoteRecoveryStore({ db, tenantId, logger }),
        nextRequestId: () => store.nextRequestId(),
        now,
        maxQueries: recoveryMaxQueries,
      }),
      events: {
        pendingEventIds: (limit) => eventSigning.pendingEventIds(limit),
        signer: new SignPendingEvent({
          store: eventSigning,
          certificates,
          builder: new TipsEventXmlBuilder(),
          signer: new TipsEventSigner(),
          now,
        }),
        sender: new SendEventBatch({
          gateway,
          store: createDrizzleEventBatchStore({ db, tenantId, now }),
          nextRequestId: () => store.nextRequestId(),
          validate: validateEventXml,
          logger,
        }),
        resolver: new ResolveUnknownEvents({
          gateway,
          store: createDrizzleEventRecoveryStore({ db, tenantId, now }),
          nextRequestId: () => store.nextRequestId(),
          now,
        }),
      },
      now,
      logger,
      batch,
    });
  };
}
