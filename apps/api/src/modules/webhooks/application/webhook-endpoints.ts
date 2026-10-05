import { randomUUID } from 'node:crypto';
import type { WebhookSecretVault } from '../../custody/application/webhook-secret-vault.js';
import {
  validateEndpointEvents,
  validateEndpointUrl,
  type InputError,
} from '../domain/webhook-endpoint-input.js';
import { generateWebhookSecret } from '../domain/webhook-signature.js';
import type {
  Actor,
  EndpointPatch,
  EndpointView,
  WebhookEndpointStore,
} from './ports/webhook-endpoint-store.port.js';

/** A rotation keeps the previous secret valid this long so receivers can switch (the DB allows up to 7 days). */
const ROTATION_OVERLAP_MS = 24 * 60 * 60 * 1000;

export class WebhookValidationError extends Error {
  constructor(readonly errors: readonly InputError[]) {
    super('Validation failed');
    this.name = 'WebhookValidationError';
  }
}

export class WebhookEndpointNotFoundError extends Error {
  constructor() {
    super('Webhook endpoint not found');
    this.name = 'WebhookEndpointNotFoundError';
  }
}

export class WebhookRotationConflictError extends Error {
  constructor() {
    super('The endpoint was rotated concurrently; retry');
    this.name = 'WebhookRotationConflictError';
  }
}

export interface WebhookEndpointServiceDeps {
  readonly store: WebhookEndpointStore;
  readonly vault: Pick<WebhookSecretVault, 'seal'>;
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly generateSecret?: () => string;
}

export interface EndpointWithSecret {
  readonly endpoint: EndpointView;
  /** Shown to the integrator exactly once; only its sealed form is stored. */
  readonly secret: string;
}

/**
 * Endpoint management (HU-E11-01 S5). The secret is sealed under the identity the dispatcher opens
 * (tenant, endpoint id, secret version) and returned in clear only by `create` and `rotate`.
 */
export function createWebhookEndpointService({
  store,
  vault,
  now = () => new Date(),
  newId = randomUUID,
  generateSecret = generateWebhookSecret,
}: WebhookEndpointServiceDeps) {
  const check = (input: { url?: unknown; events?: unknown }, required: boolean) => {
    const errors: InputError[] = [];
    const parts: { url?: string; events?: readonly string[] } = {};
    if (required || input.url !== undefined) {
      const url = validateEndpointUrl(input.url);
      if (url.ok) parts.url = url.value;
      else errors.push(...url.errors);
    }
    if (required || input.events !== undefined) {
      const events = validateEndpointEvents(input.events);
      if (events.ok) parts.events = events.value;
      else errors.push(...events.errors);
    }
    return { errors, parts };
  };

  return {
    async create(
      tenantId: string,
      actor: Actor,
      input: { url?: unknown; events?: unknown },
    ): Promise<EndpointWithSecret> {
      const { errors, parts } = check(input, true);
      if (errors.length > 0) throw new WebhookValidationError(errors);
      const id = newId();
      const secret = generateSecret();
      const sealed = await vault.seal(secret, { tenantId, endpointId: id, version: 1 });
      const endpoint = await store.insert(tenantId, actor, {
        id,
        url: parts.url as string,
        events: parts.events as readonly string[],
        sealed,
      });
      return { endpoint, secret };
    },

    list: (tenantId: string) => store.list(tenantId),

    async update(
      tenantId: string,
      actor: Actor,
      id: string,
      input: { url?: unknown; events?: unknown; active?: unknown },
    ): Promise<EndpointView> {
      const { errors, parts } = check(input, false);
      if (input.active !== undefined && typeof input.active !== 'boolean') {
        errors.push({ field: 'active', message: 'active must be a boolean' });
      }
      if (errors.length > 0) throw new WebhookValidationError(errors);
      const patch: EndpointPatch = {
        ...parts,
        ...(typeof input.active === 'boolean' ? { active: input.active } : {}),
      };
      const updated = await store.update(tenantId, actor, id, patch);
      if (!updated) throw new WebhookEndpointNotFoundError();
      return updated;
    },

    async rotate(tenantId: string, actor: Actor, id: string): Promise<EndpointWithSecret> {
      const current = await store.find(tenantId, id);
      if (!current) throw new WebhookEndpointNotFoundError();
      const secret = generateSecret();
      const sealed = await vault.seal(secret, {
        tenantId,
        endpointId: id,
        version: current.secretVersion + 1,
      });
      const rotated = await store.rotate(tenantId, actor, id, {
        expectedVersion: current.secretVersion,
        sealed,
        previousSealed: current.sealed,
        previousExpiresAt: new Date(now().getTime() + ROTATION_OVERLAP_MS),
      });
      if (rotated === null) throw new WebhookEndpointNotFoundError();
      if (rotated === 'stale') throw new WebhookRotationConflictError();
      return { endpoint: rotated, secret };
    },
  };
}
