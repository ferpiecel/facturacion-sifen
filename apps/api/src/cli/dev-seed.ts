import { eq } from 'drizzle-orm';
import { createNodePostgresDatabase, tenants, type Database } from '@sifen/db';
import { parseOpsArgs } from './args.js';
import { createPartner, createTenant, issueApiKey } from './commands.js';
import { assertSafeDevSeedEnv } from './dev-seed-guard.js';
import { DEMO_ISSUER } from './dev-seed-issuer.js';
import { formatOpsError, runOpsCommand } from './ops.js';

export const DEMO = {
  partner: 'Partner Demo',
  tenant: 'Demo SA',
  email: 'owner@demo.example.com',
  password: 'Tigre-Azul-Mesa-2026',
} as const;

export interface DevSeedResult {
  tenantId: string;
  /** The API key, printed once; null when the demo tenant already existed (the key is not recoverable). */
  apiKey: string | null;
}

async function run(db: Database, argv: string[]): Promise<void> {
  await runOpsCommand(db, parseOpsArgs(argv));
}

/** Creates the partner, tenant, fiscal data, owner and API key through the operator-CLI commands. */
async function createDemoTenant(db: Database): Promise<{ tenantId: string; apiKey: string }> {
  const { id: partnerId } = await createPartner(db, DEMO.partner);
  const { id: tenantId } = await createTenant(db, DEMO.tenant, partnerId);
  const tenant = ['--tenant', tenantId];
  await run(db, [
    'fiscal:set',
    ...tenant,
    '--ruc',
    DEMO_ISSUER.ruc,
    '--legal-name',
    DEMO_ISSUER.legalName,
    '--taxpayer-type',
    'juridica',
    '--activity',
    '62010:Programación informática',
  ]);
  await run(db, [
    'establishment:add',
    ...tenant,
    '--code',
    DEMO_ISSUER.establishment,
    '--address',
    'Calle Falsa 123',
    '--house-number',
    '0',
    '--department',
    '11',
    '--district',
    '145',
    '--district-description',
    'CIUDAD DEL ESTE',
    '--city',
    '3432',
    '--city-description',
    'PUERTO PTE.STROESSNER (MUNIC)',
    '--phone',
    '0973-000000',
    '--email',
    'demo@example.com',
    '--name',
    'Casa Matriz',
  ]);
  await run(db, [
    'point:add',
    ...tenant,
    '--establishment',
    DEMO_ISSUER.establishment,
    '--code',
    DEMO_ISSUER.point,
  ]);
  await run(db, [
    'timbrado:add',
    ...tenant,
    '--number',
    DEMO_ISSUER.timbrado,
    '--valid-from',
    DEMO_ISSUER.timbradoFrom,
    '--valid-to',
    '2099-12-31',
  ]);
  await run(db, [
    'user:create',
    ...tenant,
    '--email',
    DEMO.email,
    '--name',
    'Dueño Demo',
    '--role',
    'owner',
    `--password=${DEMO.password}`,
  ]);
  const key = await issueApiKey(db, {
    tenantId,
    environment: 'test',
    scopes: ['documents:write', 'documents:read'],
    label: 'dev:seed',
  });
  return { tenantId, apiKey: key.formattedKey };
}

/** Idempotent: the demo tenant is found by name, so a second run changes nothing. */
export async function runDevSeed(db: Database): Promise<DevSeedResult> {
  const existing = (
    await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.name, DEMO.tenant))
  ).at(0);
  const created = existing ? null : await createDemoTenant(db);
  const tenantId = existing?.id ?? created?.tenantId ?? '';
  return {
    tenantId,
    apiKey: created?.apiKey ?? null,
  };
}

export function formatDevSeedResult(result: DevSeedResult): string {
  return [
    `tenant: ${DEMO.tenant} (${result.tenantId})`,
    `login: ${DEMO.email}`,
    `password: ${DEMO.password}   (dev only; MFA is enrolled at first login)`,
    result.apiKey
      ? `api key: ${result.apiKey}   (printed once)`
      : 'api key: already issued by a previous run (not recoverable; use `ops apikey:create`)',
  ].join('\n');
}

const isMainModule =
  process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href;
if (isMainModule) {
  void (async () => {
    try {
      assertSafeDevSeedEnv(process.env);
      const handle = createNodePostgresDatabase(process.env.OPS_DATABASE_URL ?? '');
      try {
        console.log(formatDevSeedResult(await runDevSeed(handle.db)));
      } finally {
        await handle.close();
      }
    } catch (error) {
      console.error(formatOpsError(error));
      process.exitCode = 1;
    }
  })();
}
