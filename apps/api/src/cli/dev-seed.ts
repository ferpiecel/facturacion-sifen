import { and, eq } from 'drizzle-orm';
import {
  createNodePostgresDatabase,
  documents,
  tenantEstablishments,
  tenantExpeditionPoints,
  tenants,
  tenantTimbrados,
  type Database,
} from '@sifen/db';
import { parseOpsArgs } from './args.js';
import { createPartner, createTenant, issueApiKey } from './commands.js';
import { assertSafeDevSeedEnv } from './dev-seed-guard.js';
import { buildSignedDemoInvoice, generateDemoCertificate } from './dev-seed-invoice.js';
import { DEMO_ISSUER } from './dev-seed-issuer.js';
import { formatOpsError, runOpsCommand } from './ops.js';

export const DEMO = {
  partner: 'Partner Demo',
  tenant: 'Demo SA',
  email: 'owner@demo.example.com',
  password: 'Tigre-Azul-Mesa-2026',
} as const;

const DAY_MS = 24 * 3600 * 1000;

/** Documents of the demo: the status each one ends in and what SIFEN answered, if anything. */
const DEMO_DOCUMENTS = [
  {
    status: 'approved',
    receiver: 'Cliente Aprobado SA',
    messages: [{ code: '0260', message: 'Aprobado' }],
  },
  {
    status: 'approved',
    receiver: 'Comercial Guaraní SRL',
    messages: [{ code: '0260', message: 'Aprobado' }],
  },
  {
    status: 'rejected',
    receiver: 'Rechazos y Cía',
    messages: [
      { code: '1002', message: 'Timbrado inexistente o vencido (mensaje de demostración)' },
    ],
  },
  {
    status: 'approved_with_observations',
    receiver: 'Observaciones SA',
    messages: [{ code: '0261', message: 'Aprobado con observación (mensaje de demostración)' }],
  },
  { status: 'queued', receiver: 'En Cola SA', messages: null },
  {
    status: 'cancelled',
    receiver: 'Cancelados SRL',
    messages: [{ code: '0260', message: 'Aprobado' }],
  },
] as const;

export interface DevSeedResult {
  tenantId: string;
  /** The API key, printed once; null when the demo tenant already existed (the key is not recoverable). */
  apiKey: string | null;
  documentsCreated: number;
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

/**
 * Inserts the demo documents already settled in their final status. They do not travel the
 * emission path (POST /v1/documents + worker) because the simulator gateway only answers
 * "approved" unless scripted in-process, so rejected, observed and cancelled could not be
 * produced that way. The XML is real (TIPS builder, XMLDSig, QR), so XML and KuDE downloads work.
 * Re-running is a no-op: `(tenant, environment, cdc)` is unique and the CDC is deterministic.
 */
async function seedDemoDocuments(db: Database, tenantId: string): Promise<number> {
  const [est] = await db
    .select({ id: tenantEstablishments.id })
    .from(tenantEstablishments)
    .where(
      and(
        eq(tenantEstablishments.tenantId, tenantId),
        eq(tenantEstablishments.code, DEMO_ISSUER.establishment),
      ),
    );
  const [point] = await db
    .select({ id: tenantExpeditionPoints.id })
    .from(tenantExpeditionPoints)
    .where(eq(tenantExpeditionPoints.tenantId, tenantId));
  const [timbrado] = await db
    .select({ id: tenantTimbrados.id })
    .from(tenantTimbrados)
    .where(eq(tenantTimbrados.tenantId, tenantId));
  const certificate = generateDemoCertificate();
  let created = 0;
  for (const [index, demo] of DEMO_DOCUMENTS.entries()) {
    const number = index + 1;
    const { xml, cdc } = await buildSignedDemoInvoice(certificate, number, demo.receiver);
    const at = new Date(Date.now() - (DEMO_DOCUMENTS.length - index) * DAY_MS);
    const rows = await db
      .insert(documents)
      .values({
        tenantId,
        environment: 'test',
        cdc,
        documentType: 1,
        timbradoId: timbrado.id,
        establishmentId: est.id,
        expeditionPointId: point.id,
        number,
        securityCode: cdc.slice(34, 43),
        status: demo.status,
        receiverRuc: '80000002-7',
        issuedAt: at,
        totalAmount: '11000',
        payload: { receiver: { name: demo.receiver } },
        signedXml: xml,
        signedAt: at,
        sifenMessages: demo.messages,
        // Backoff far in the future keeps the queued document queued even with a worker running.
        nextTransmissionAt: demo.status === 'queued' ? new Date(Date.now() + 365 * DAY_MS) : null,
        createdAt: at,
        updatedAt: new Date(at.getTime() + 60_000),
      })
      .onConflictDoNothing()
      .returning({ id: documents.id });
    created += rows.length;
  }
  return created;
}

/** Idempotent: the demo tenant is found by name, so a second run only completes missing documents. */
export async function runDevSeed(db: Database): Promise<DevSeedResult> {
  const existing = (
    await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.name, DEMO.tenant))
  ).at(0);
  const created = existing ? null : await createDemoTenant(db);
  const tenantId = existing?.id ?? created?.tenantId ?? '';
  return {
    tenantId,
    apiKey: created?.apiKey ?? null,
    documentsCreated: await seedDemoDocuments(db, tenantId),
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
    `documents created: ${String(result.documentsCreated)}`,
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
