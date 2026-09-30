import { createNodePostgresDatabase, type Database } from '@sifen/db';
import { EnvelopeCipher } from '../modules/custody/application/envelope-cipher.js';
import { createLocalKms } from '../modules/custody/infrastructure/adapters/local-kms.adapter.js';
import { CscVault } from '../modules/custody/infrastructure/csc-vault.js';
import { getOpsDatabaseUrl, parseOpsArgs, type OpsCommand } from './args.js';
import {
  addEstablishment,
  addExpeditionPoint,
  addTimbrado,
  createPartner,
  createTenant,
  issueApiKey,
  revokeApiKey,
  setFiscalProfile,
  setTenantEnvironment,
} from './commands.js';

/**
 * Builds the CSC vault with the same KMS rules as the API (ADR-0009): fails
 * closed without `KMS_LOCAL_MASTER_KEY` unless `NODE_ENV` is development/test.
 */
export function createCscVault(env: NodeJS.ProcessEnv): CscVault {
  return new CscVault(new EnvelopeCipher(createLocalKms(env.KMS_LOCAL_MASTER_KEY, env.NODE_ENV)));
}

/**
 * Dispatches one parsed {@link OpsCommand} to its handler and formats the
 * operator-facing output (backlog HU-E1-05). `apikey:create`'s formatted
 * key is the only place the raw secret ever appears — the caller must
 * print this return value once and never log it again.
 */
export async function runOpsCommand(
  db: Database,
  command: OpsCommand,
  vault?: CscVault,
): Promise<string> {
  switch (command.kind) {
    case 'partner:create': {
      const { id } = await createPartner(db, command.name);
      return `partner created: ${id}`;
    }
    case 'tenant:create': {
      const { id } = await createTenant(db, command.name, command.partnerId);
      return `tenant created: ${id}`;
    }
    case 'apikey:create': {
      const issued = await issueApiKey(db, {
        tenantId: command.tenantId,
        environment: command.environment,
        scopes: command.scopes,
        label: command.label,
      });
      return [
        issued.formattedKey,
        '',
        'WARNING: this key cannot be retrieved again. Store it now; only its hash is kept.',
      ].join('\n');
    }
    case 'apikey:revoke': {
      await revokeApiKey(db, command.keyId);
      return `api key revoked: ${command.keyId}`;
    }
    case 'fiscal:set': {
      const result = await setFiscalProfile(db, {
        tenantId: command.tenantId,
        profile: command.profile,
      });
      return `fiscal profile saved: ${result.tenantId} (RUC ${result.ruc})`;
    }
    case 'establishment:add': {
      const result = await addEstablishment(db, {
        tenantId: command.tenantId,
        establishment: command.establishment,
      });
      return `establishment created: ${result.id} (code ${result.code})`;
    }
    case 'point:add': {
      const result = await addExpeditionPoint(db, {
        tenantId: command.tenantId,
        establishmentCode: command.establishmentCode,
        point: command.point,
      });
      return `expedition point created: ${result.id} (code ${result.code})`;
    }
    case 'timbrado:add': {
      const result = await addTimbrado(db, {
        tenantId: command.tenantId,
        timbrado: command.timbrado,
      });
      return `timbrado created: ${result.id} (number ${result.number})`;
    }
    case 'tenant:environment': {
      const result = await setTenantEnvironment(db, {
        tenantId: command.tenantId,
        environment: command.environment,
      });
      return `tenant environment set: ${result.id} (${result.environment})`;
    }
    case 'csc:add': {
      if (!vault) {
        throw new Error('csc:add requires a CSC vault');
      }
      await vault.add(db, {
        tenantId: command.tenantId,
        environment: command.environment,
        idCsc: command.idCsc,
        value: command.csc,
      });
      // Never echo the CSC: the operator already holds it, and only its sealed form is stored.
      return `csc stored: tenant ${command.tenantId} (${command.environment}, idCSC ${command.idCsc})`;
    }
  }
}

/**
 * Operator-facing error text. drizzle's query errors embed the bound params
 * (e.g. a key's `secret_hash`) in `message`, so print the driver's own
 * `cause` instead and never the raw failed-query text.
 */
export function formatOpsError(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'unknown error';
  }
  if (error.cause instanceof Error) {
    return error.cause.message;
  }
  return error.message.startsWith('Failed query') ? 'database query failed' : error.message;
}

// Process entrypoint below, exercised by the manual docker check (see
// README's "Operación" section) and excluded from coverage in
// vitest.config.ts, not by unit tests.
async function main(): Promise<void> {
  const url = getOpsDatabaseUrl(process.env);
  const command = parseOpsArgs(process.argv.slice(2));

  const handle = createNodePostgresDatabase(url);
  try {
    const vault = command.kind === 'csc:add' ? createCscVault(process.env) : undefined;
    const output = await runOpsCommand(handle.db, command, vault);
    console.log(output);
  } finally {
    await handle.close();
  }
}

const isMainModule =
  process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href;
if (isMainModule) {
  main().catch((error: unknown) => {
    console.error(formatOpsError(error));
    process.exitCode = 1;
  });
}
