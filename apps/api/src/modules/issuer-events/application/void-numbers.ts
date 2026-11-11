import { requestHash } from '../../emission/domain/request-hash.js';
import type { AuditEntry } from '../../audit/application/ports/record-audit.port.js';
import {
  DEFAULT_VOID_CONFIG,
  parseVoidRequest,
  rangeSize,
  rangesOverlap,
  type VoidConfig,
  type VoidFieldError,
  type VoidRange,
} from '../domain/void-rules.js';
import { EventKeyReusedError } from './cancel-document.js';
import { EventKeyCollisionError } from './ports/cancellation-unit-of-work.port.js';
import type { VoidingUnitOfWork } from './ports/voiding-unit-of-work.port.js';

/** The request or a rule of the manual refuses the voiding; nothing was stored. */
export class VoidRefusedError extends Error {
  constructor(readonly errors: (VoidFieldError & { numbers?: number[] })[]) {
    super('The voiding was refused');
    this.name = 'VoidRefusedError';
  }
}

export interface VoidNumbersInput {
  tenantId: string;
  actor: AuditEntry['actor'];
  /** The request body as received. */
  body: unknown;
  idempotencyKey: string;
}

export interface VoidingRequested {
  eventId: string;
  status: 'pending';
}

export interface VoidNumbersDependencies {
  unitOfWork: VoidingUnitOfWork;
  config?: VoidConfig;
}

/** Numbers listed in a refusal: enough to act on, not a dump of the range. */
const LISTED_NUMBERS = 20;

/**
 * Requests the voiding of a range of numbers that will not be used (HU-E8-03). Inside one tenant transaction
 * it checks the range against the tenant's setup (4052, 4054, 4055), locks the numbering row, refuses numbers
 * that were never issued, ranges holding a document SIFEN may know (4065) and overlaps with an earlier voiding
 * (4066), and only then takes an event id and stores the event `pending`: a refusal burns none. Idempotent.
 *
 * @throws VoidRefusedError, EventKeyReusedError
 */
export function createVoidNumbers(deps: VoidNumbersDependencies) {
  const config = deps.config ?? DEFAULT_VOID_CONFIG;

  return async function voidNumbers(input: VoidNumbersInput): Promise<VoidingRequested> {
    const parsed = parseVoidRequest(input.body, config);
    if (!parsed.ok) throw new VoidRefusedError(parsed.errors);
    const hash = requestHash({ action: 'void', range: parsed.range, reason: parsed.reason });
    try {
      return await requestOnce(input, parsed.range, parsed.reason, hash);
    } catch (error) {
      if (!(error instanceof EventKeyCollisionError)) throw error;
      return requestOnce(input, parsed.range, parsed.reason, hash);
    }
  };

  async function requestOnce(
    input: VoidNumbersInput,
    range: VoidRange,
    reason: string,
    hash: string,
  ): Promise<VoidingRequested> {
    return deps.unitOfWork.run(input.tenantId, async (unit) => {
      const replayed = replay(await unit.findByIdempotencyKey(input.idempotencyKey), hash);
      if (replayed) return replayed;

      const scope = await unit.resolveScope(range);
      if (!scope.found) throw refusal(UNKNOWN[scope.unknown]);
      const last = await unit.lockLastNumber(scope, range);
      // A parallel request with the same key may have committed while this one waited for the lock.
      const late = replay(await unit.findByIdempotencyKey(input.idempotencyKey), hash);
      if (late) return late;

      if (last === null || range.to > last) {
        throw refusal({
          field: 'to',
          rule: 'range-beyond-issued-numbers',
          message: 'Only numbers already issued can be voided; later ones may still be used.',
        });
      }
      const documents = await unit.listDocumentNumbersInRange(
        scope,
        range,
        Math.min(LISTED_NUMBERS, rangeSize(range)),
      );
      if (documents.length > 0) {
        throw refusal({
          field: 'from',
          rule: 'range-has-documents',
          sifenCode: '4065',
          message: 'The range holds documents that exist or are on their way to SIFEN.',
          numbers: documents,
        });
      }
      const open = await unit.listOpenVoidRanges(range);
      if (open.some((other) => rangesOverlap(range, other))) {
        throw refusal({
          field: 'from',
          rule: 'range-overlaps-voided',
          sifenCode: '4066',
          message: 'The range overlaps numbers already voided or being voided.',
        });
      }

      const { id } = await unit.insertVoiding({
        environment: scope.environment,
        range,
        reason,
        idempotencyKey: input.idempotencyKey,
        requestHash: hash,
      });
      await unit.recordAudit({
        actor: input.actor,
        action: 'numbering.voiding_requested',
        entity: { type: 'issuer_event', id },
        before: null,
        after: { range, status: 'pending' },
      });
      return { eventId: id, status: 'pending' };
    });
  }

  function replay(
    stored: { eventId: string; documentId: string | null; requestHash: string } | null,
    hash: string,
  ): VoidingRequested | null {
    if (!stored) return null;
    if (stored.requestHash !== hash || stored.documentId !== null) throw new EventKeyReusedError();
    return { eventId: stored.eventId, status: 'pending' };
  }
}

const UNKNOWN = {
  timbrado: {
    field: 'timbrado',
    rule: 'unknown-timbrado',
    sifenCode: '4052',
    message: 'The timbrado is not one of the tenant`s.',
  },
  establishment: {
    field: 'establishment',
    rule: 'unknown-establishment',
    sifenCode: '4054',
    message: 'The establishment code is not one of the tenant`s.',
  },
  'expedition-point': {
    field: 'expeditionPoint',
    rule: 'unknown-expedition-point',
    sifenCode: '4055',
    message: 'The expedition point code is not one of the tenant`s.',
  },
} as const;

function refusal(error: VoidFieldError & { numbers?: number[] }): VoidRefusedError {
  return new VoidRefusedError([error]);
}
