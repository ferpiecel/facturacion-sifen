import { and, eq, isNull } from 'drizzle-orm';
import {
  apiKeys,
  partners,
  tenantFiscalEconomicActivities,
  tenantFiscalProfiles,
  tenants,
  type Database,
} from '@sifen/db';
import type { ApiKeyEnvironment } from '../modules/identity/domain/api-key.js';
import type { FiscalProfile } from '../modules/fiscal-config/domain/fiscal-profile.js';
import { formatRuc } from '../modules/fiscal-config/domain/ruc.js';
import { Argon2SecretHasherAdapter } from '../modules/identity/infrastructure/adapters/argon2-secret-hasher.adapter.js';
import { IssueApiKeyUseCase } from '../modules/identity/application/issue-api-key.use-case.js';

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

export interface CreatePartnerResult {
  id: string;
}

/** Operator CLI handler (backlog HU-E1-05): inserts a partner row directly, never through `app_login`. */
export async function createPartner(db: Database, name: string): Promise<CreatePartnerResult> {
  const [row] = await db.insert(partners).values({ name }).returning();
  return { id: required(row, 'partner was not inserted').id };
}

export interface CreateTenantResult {
  id: string;
}

/** Operator CLI handler (backlog HU-E1-05): `partnerId` is optional (a direct SaaS tenant has none). */
export async function createTenant(
  db: Database,
  name: string,
  partnerId?: string,
): Promise<CreateTenantResult> {
  const [row] = await db
    .insert(tenants)
    .values({ name, partnerId: partnerId ?? null })
    .returning();
  return { id: required(row, 'tenant was not inserted').id };
}

export interface IssueApiKeyParams {
  tenantId: string;
  environment: ApiKeyEnvironment;
  scopes: string[];
  label?: string;
}

export interface IssueApiKeyResult {
  /** The full bearer token: the CLI must print this exactly once and never log it again. */
  formattedKey: string;
  keyId: string;
  apiKeyId: string;
}

/**
 * Operator CLI handler (backlog HU-E1-05): mints a key through the same
 * {@link IssueApiKeyUseCase} the domain exposes, then persists only the
 * hash — the raw secret lives solely in the returned {@link IssueApiKeyResult}.
 */
export async function issueApiKey(
  db: Database,
  params: IssueApiKeyParams,
): Promise<IssueApiKeyResult> {
  const issued = await new IssueApiKeyUseCase(new Argon2SecretHasherAdapter()).execute(
    params.environment,
  );
  const [row] = await db
    .insert(apiKeys)
    .values({
      tenantId: params.tenantId,
      keyId: issued.keyId,
      environment: params.environment,
      secretHash: issued.secretHash,
      scopes: params.scopes,
      label: params.label,
    })
    .returning();

  return {
    formattedKey: issued.formattedKey,
    keyId: issued.keyId,
    apiKeyId: required(row, 'api key was not inserted').id,
  };
}

/**
 * Operator CLI handler (backlog HU-E1-05): revokes by the public `keyId`
 * embedded in the issued token. Throws when no active key matched, so a
 * mistyped keyId never reads as a successful revocation, and never
 * overwrites the original `revoked_at` of an already revoked key.
 */
export async function revokeApiKey(db: Database, keyId: string): Promise<void> {
  const rows = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.keyId, keyId), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });
  if (rows.length === 0) {
    throw new Error(`no active api key with keyId ${keyId}`);
  }
}

export interface SetFiscalProfileParams {
  tenantId: string;
  profile: FiscalProfile;
}

export interface SetFiscalProfileResult {
  tenantId: string;
  ruc: string;
}

/**
 * Operator CLI handler (backlog HU-E2-01): upserts the tenant's fiscal
 * profile and replaces its economic activities inside one transaction, so
 * a failing activity (e.g. a DB check-constraint violation) leaves no
 * partial state. `profile` must already be domain-validated by the caller
 * (see `parseOpsArgs`'s `fiscal:set` case) before this ever touches the DB.
 */
export async function setFiscalProfile(
  db: Database,
  params: SetFiscalProfileParams,
): Promise<SetFiscalProfileResult> {
  const { tenantId, profile } = params;

  return db.transaction(async (tx) => {
    const found = await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId));
    if (found.length === 0) {
      throw new Error(`tenant not found: ${tenantId}`);
    }

    const now = new Date();
    await tx
      .insert(tenantFiscalProfiles)
      .values({
        tenantId,
        rucBase: profile.ruc.base,
        rucDv: profile.ruc.dv,
        legalName: profile.legalName,
        tradeName: profile.tradeName,
        taxpayerType: profile.taxpayerType,
        regimeCode: profile.regimeCode,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: tenantFiscalProfiles.tenantId,
        set: {
          rucBase: profile.ruc.base,
          rucDv: profile.ruc.dv,
          legalName: profile.legalName,
          tradeName: profile.tradeName,
          taxpayerType: profile.taxpayerType,
          regimeCode: profile.regimeCode,
          updatedAt: now,
        },
      });

    await tx
      .delete(tenantFiscalEconomicActivities)
      .where(eq(tenantFiscalEconomicActivities.tenantId, tenantId));

    await tx.insert(tenantFiscalEconomicActivities).values(
      profile.economicActivities.map((activity) => ({
        tenantId,
        code: activity.code,
        description: activity.description,
      })),
    );

    return { tenantId, ruc: formatRuc(profile.ruc) };
  });
}
