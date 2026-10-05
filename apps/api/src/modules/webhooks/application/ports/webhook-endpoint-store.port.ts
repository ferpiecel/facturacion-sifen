import type { SealedSecret } from '../../../custody/domain/sealed-secret.js';

/** An endpoint as the API shows it: never the secret, sealed or not. */
export interface EndpointView {
  readonly id: string;
  readonly url: string;
  readonly events: readonly string[];
  readonly active: boolean;
  readonly secretVersion: number;
  readonly previousExpiresAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface Actor {
  readonly type: 'api_key' | 'user' | 'operator';
  readonly id: string;
}

export interface EndpointPatch {
  readonly url?: string;
  readonly events?: readonly string[];
  readonly active?: boolean;
}

/** Tenant-scoped persistence of endpoints; each write also appends its audit row in the same transaction. */
export interface WebhookEndpointStore {
  insert(
    tenantId: string,
    actor: Actor,
    row: { id: string; url: string; events: readonly string[]; sealed: SealedSecret },
  ): Promise<EndpointView>;
  list(tenantId: string): Promise<EndpointView[]>;
  /** The row with its sealed secret, for rotation. */
  find(
    tenantId: string,
    id: string,
  ): Promise<(EndpointView & { sealed: SealedSecret; previousSealed: SealedSecret | null }) | null>;
  update(
    tenantId: string,
    actor: Actor,
    id: string,
    patch: EndpointPatch,
  ): Promise<EndpointView | null>;
  /** Only applies while the endpoint is still at `expectedVersion`; `stale` otherwise. */
  rotate(
    tenantId: string,
    actor: Actor,
    id: string,
    change: {
      expectedVersion: number;
      sealed: SealedSecret;
      previousSealed: SealedSecret;
      previousExpiresAt: Date;
    },
  ): Promise<EndpointView | 'stale' | null>;
}
