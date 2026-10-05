import { TipsDeXmlBuilder, TipsQrGenerator, TipsXmlSigner } from '@sifen/sifen-tips';
import type { Database } from '@sifen/db';
import { measureLoteMessage, type SifenGateway } from '@sifen/sifen-gateway';
import type {
  CertificateSource,
  CscSource,
} from '../modules/emission/application/ports/signing.port.js';
import { SignDocument } from '../modules/emission/application/sign-document.js';
import { createDrizzleSigningStore } from '../modules/emission/infrastructure/drizzle-signing-store.js';
import { LoteAssembler } from '../modules/transmission/application/assemble-lotes.js';
import { PollLoteResult } from '../modules/transmission/application/poll-lote-result.js';
import { RecoverLoteByCdc } from '../modules/transmission/application/recover-lote-by-cdc.js';
import { SendLote } from '../modules/transmission/application/send-lote.js';
import { TransmissionCycle } from '../modules/transmission/application/transmission-cycle.js';
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
}: TenantCycleFactoryDeps): (tenantId: string) => TransmissionCycle {
  return (tenantId) => {
    const store = createDrizzleTransmissionCycleStore({ db, tenantId, now });
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
      }),
      assembler: new LoteAssembler({
        store: createDrizzleLoteAssemblyStore({ db, tenantId, now }),
        measureMessage: measureLoteMessage,
        logger,
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
      now,
      logger,
    });
  };
}
