import { and, eq, isNull } from 'drizzle-orm';
import {
  apiKeys,
  partners,
  tenantEstablishments,
  tenantExpeditionPoints,
  tenantFiscalEconomicActivities,
  tenantFiscalProfiles,
  tenantTimbrados,
  tenants,
  type Database,
} from '@sifen/db';
import type { TenantEnvironment } from '../modules/fiscal-config/domain/document-environment.js';
import type {
  Establishment,
  EstablishmentContact,
} from '../modules/fiscal-config/domain/establishment.js';
import type { ExpeditionPoint } from '../modules/fiscal-config/domain/expedition-point.js';
import type { FiscalProfile } from '../modules/fiscal-config/domain/fiscal-profile.js';
import { formatRuc } from '../modules/fiscal-config/domain/ruc.js';
import type { Timbrado } from '../modules/fiscal-config/domain/timbrado.js';
import type { ApiKeyEnvironment } from '../modules/identity/domain/api-key.js';
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

export interface AddEstablishmentParams {
  tenantId: string;
  establishment: Establishment;
}

export interface AddEstablishmentResult {
  id: string;
  code: string;
}

/**
 * Operator CLI handler (backlog HU-E2-02): inserts one tenant-scoped
 * establishment, persisting every field the domain validates. `districtCode`/
 * `districtDescription` are optional together (cDisEmi has occurrence 0-1),
 * matching `tenant_establishments.district_code`'s nullability.
 */
export async function addEstablishment(
  db: Database,
  params: AddEstablishmentParams,
): Promise<AddEstablishmentResult> {
  const { tenantId, establishment } = params;

  return db.transaction(async (tx) => {
    const found = await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId));
    if (found.length === 0) {
      throw new Error(`tenant not found: ${tenantId}`);
    }

    const [row] = await tx
      .insert(tenantEstablishments)
      .values({
        tenantId,
        code: establishment.code,
        address: establishment.address,
        houseNumber: establishment.houseNumber,
        addressComplement1: establishment.addressComplement1,
        addressComplement2: establishment.addressComplement2,
        departmentCode: String(establishment.departmentCode),
        districtCode: establishment.districtCode,
        districtDescription: establishment.districtDescription,
        cityCode: establishment.cityCode,
        cityDescription: establishment.cityDescription,
        phone: establishment.phone,
        email: establishment.email,
        commercialName: establishment.commercialName,
      })
      .returning();

    return { id: required(row, 'establishment was not inserted').id, code: establishment.code };
  });
}

export interface SetEstablishmentContactParams {
  tenantId: string;
  establishmentCode: string;
  contact: EstablishmentContact;
}

/** Operator CLI handler: sets dTelEmi/dEmailE/dDenSuc on an existing establishment (HU-E6-02). */
export async function setEstablishmentContact(
  db: Database,
  params: SetEstablishmentContactParams,
): Promise<{ id: string; code: string }> {
  const { tenantId, establishmentCode, contact } = params;
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(tenantEstablishments)
      .set({
        phone: contact.phone,
        email: contact.email,
        commercialName: contact.commercialName,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(tenantEstablishments.tenantId, tenantId),
          eq(tenantEstablishments.code, establishmentCode),
        ),
      )
      .returning({ id: tenantEstablishments.id, code: tenantEstablishments.code });
    const row = updated.at(0);
    if (!row) {
      throw new Error(`establishment not found: ${establishmentCode}`);
    }
    return row;
  });
}

export interface AddExpeditionPointParams {
  tenantId: string;
  establishmentCode: string;
  point: ExpeditionPoint;
}

export interface AddExpeditionPointResult {
  id: string;
  code: string;
}

/**
 * Operator CLI handler (backlog HU-E2-02): resolves the establishment by
 * `(tenantId, establishmentCode)` before inserting, so a mistyped or
 * cross-tenant establishment code fails with a clear error rather than a
 * raw FK violation.
 */
export async function addExpeditionPoint(
  db: Database,
  params: AddExpeditionPointParams,
): Promise<AddExpeditionPointResult> {
  const { tenantId, establishmentCode, point } = params;

  return db.transaction(async (tx) => {
    const foundTenant = await tx
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    if (foundTenant.length === 0) {
      throw new Error(`tenant not found: ${tenantId}`);
    }

    const foundEstablishment = await tx
      .select({ id: tenantEstablishments.id })
      .from(tenantEstablishments)
      .where(
        and(
          eq(tenantEstablishments.tenantId, tenantId),
          eq(tenantEstablishments.code, establishmentCode),
        ),
      );
    if (foundEstablishment.length === 0) {
      throw new Error(`establishment not found: ${establishmentCode} (tenant ${tenantId})`);
    }
    const establishmentId = required(
      foundEstablishment[0],
      'establishment query returned no row',
    ).id;

    const [row] = await tx
      .insert(tenantExpeditionPoints)
      .values({ tenantId, establishmentId, code: point.code })
      .returning();

    return { id: required(row, 'expedition point was not inserted').id, code: point.code };
  });
}

export interface AddTimbradoParams {
  tenantId: string;
  timbrado: Timbrado;
}

export interface AddTimbradoResult {
  id: string;
  number: string;
}

/** Operator CLI handler (backlog HU-E2-02): inserts one tenant-scoped timbrado. */
export async function addTimbrado(
  db: Database,
  params: AddTimbradoParams,
): Promise<AddTimbradoResult> {
  const { tenantId, timbrado } = params;

  return db.transaction(async (tx) => {
    const found = await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId));
    if (found.length === 0) {
      throw new Error(`tenant not found: ${tenantId}`);
    }

    const [row] = await tx
      .insert(tenantTimbrados)
      .values({
        tenantId,
        number: timbrado.number,
        validFrom: timbrado.validityStart,
        validTo: timbrado.validityEnd,
      })
      .returning();

    return { id: required(row, 'timbrado was not inserted').id, number: timbrado.number };
  });
}

export interface SetTenantEnvironmentParams {
  tenantId: string;
  environment: TenantEnvironment;
}

export interface SetTenantEnvironmentResult {
  id: string;
  environment: TenantEnvironment;
}

/**
 * Operator CLI handler (backlog HU-E2-04): switches a tenant's SIFEN
 * environment. The `--confirm-production` guard against an accidental
 * production switch lives in `parseOpsArgs`, not here — this handler only
 * requires that the tenant exists so a mistyped id fails clearly instead of
 * silently updating 0 rows.
 */
export async function setTenantEnvironment(
  db: Database,
  params: SetTenantEnvironmentParams,
): Promise<SetTenantEnvironmentResult> {
  const { tenantId, environment } = params;

  const rows = await db
    .update(tenants)
    .set({ environment })
    .where(eq(tenants.id, tenantId))
    .returning({ id: tenants.id, environment: tenants.environment });
  if (rows.length === 0) {
    throw new Error(`tenant not found: ${tenantId}`);
  }
  const row = required(rows[0], 'tenant update returned no row');
  return { id: row.id, environment: row.environment };
}
