import { readFileSync } from 'node:fs';
import { createNodePostgresDatabase, type Database } from '@sifen/db';
import { EnvelopeCipher } from '../modules/custody/application/envelope-cipher.js';
import { createLocalKms } from '../modules/custody/infrastructure/adapters/local-kms.adapter.js';
import { CscVault } from '../modules/custody/infrastructure/csc-vault.js';
import { CertificateVault } from '../modules/certificates/infrastructure/certificate-vault.js';
import { loadTrustedRoots } from '../modules/certificates/infrastructure/trusted-roots.js';
import { getOpsDatabaseUrl, OpsArgError, parseOpsArgs, type OpsCommand } from './args.js';
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
  // Unlike the API, never accept the throwaway dev key: a CSC sealed with it is unrecoverable.
  if (!env.KMS_LOCAL_MASTER_KEY) {
    throw new Error('csc:add requires KMS_LOCAL_MASTER_KEY (a throwaway key would lose the CSC)');
  }
  return new CscVault(new EnvelopeCipher(createLocalKms(env.KMS_LOCAL_MASTER_KEY, env.NODE_ENV)));
}

/**
 * Builds the certificate vault: same KMS rules as the CSC vault, plus the PSC trusted roots from
 * `PSC_TRUSTED_ROOTS_PATH` (fails closed without them).
 */
export function createCertificateVault(
  env: NodeJS.ProcessEnv,
  readFile: (path: string) => Buffer,
): CertificateVault {
  if (!env.KMS_LOCAL_MASTER_KEY) {
    throw new Error(
      'certificate:add requires KMS_LOCAL_MASTER_KEY (a throwaway key would lose the certificate)',
    );
  }
  const trustedPscRoots = loadTrustedRoots(env, (path) => readFile(path).toString('utf8'));
  const cipher = new EnvelopeCipher(createLocalKms(env.KMS_LOCAL_MASTER_KEY, env.NODE_ENV));
  return new CertificateVault(cipher, { trustedPscRoots });
}

export interface CertificateDeps {
  readonly vault: CertificateVault;
  readonly readFile: (path: string) => Buffer;
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
  certificates?: CertificateDeps,
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
    case 'certificate:add': {
      if (!certificates) {
        throw new Error('certificate:add requires a certificate vault');
      }
      let p12: Buffer;
      try {
        p12 = certificates.readFile(command.p12Path);
      } catch {
        throw new Error('could not read the --p12 file');
      }
      try {
        const stored = await certificates.vault.add(db, {
          tenantId: command.tenantId,
          environment: command.environment,
          p12,
          password: command.password,
          replace: command.replace,
        });
        // Only public facts: the .p12 and its password exist in clear only in memory.
        return `certificate stored: tenant ${command.tenantId} (${command.environment}, RUC ${stored.subjectRuc}, fingerprint ${stored.fingerprint}, valid until ${stored.notAfter.toISOString()})`;
      } finally {
        p12.fill(0);
      }
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

/**
 * `--csc -` reads the CSC from stdin so it never lands in shell history or `ps`. For
 * `certificate:add` the `.p12` password may only come that way: `--password -` is mandatory.
 */
async function resolveStdinSecrets(
  argv: string[],
  readStdin: () => Promise<string>,
): Promise<string[]> {
  if (argv[0] === 'certificate:add') {
    const index = argv.indexOf('--password');
    if (
      argv.some((arg) => arg.startsWith('--password=')) ||
      (index >= 0 && argv[index + 1] !== '-')
    ) {
      throw new OpsArgError(
        '--password must be "-": the .p12 password is read from stdin, never from argv (value hidden)',
      );
    }
    if (index < 0) return argv;
    const value = (await readStdin()).replace(/\r?\n$/, '');
    return argv.map((arg, position) => (position === index + 1 ? value : arg));
  }
  const index = argv.indexOf('--csc');
  if (argv[0] !== 'csc:add' || argv[index + 1] !== '-') {
    return argv;
  }
  const value = (await readStdin()).replace(/\r?\n$/, '');
  return argv.map((arg, position) => (position === index + 1 ? value : arg));
}

export interface CliIo {
  argv: string[];
  env: NodeJS.ProcessEnv;
  readStdin: () => Promise<string>;
  readFile: (path: string) => Buffer;
  out: (text: string) => void;
  err: (text: string) => void;
  openDb: (url: string) => { db: Database; close: () => Promise<void> };
}

/** Runs one CLI invocation; returns the process exit code. Never prints argv values. */
export async function runCli(io: CliIo): Promise<number> {
  try {
    const url = getOpsDatabaseUrl(io.env);
    const command = parseOpsArgs(await resolveStdinSecrets(io.argv, io.readStdin));
    const vault = command.kind === 'csc:add' ? createCscVault(io.env) : undefined;
    const certificates =
      command.kind === 'certificate:add'
        ? { vault: createCertificateVault(io.env, io.readFile), readFile: io.readFile }
        : undefined;
    const handle = io.openDb(url);
    try {
      io.out(await runOpsCommand(handle.db, command, vault, certificates));
    } finally {
      await handle.close();
    }
    return 0;
  } catch (error) {
    io.err(formatOpsError(error));
    return 1;
  }
}

// Process entrypoint below, exercised by the manual docker check (see
// README's "Operación" section) and excluded from coverage in
// vitest.config.ts, not by unit tests.
async function readProcessStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString('utf8');
}

const isMainModule =
  process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href;
if (isMainModule) {
  void runCli({
    argv: process.argv.slice(2),
    env: process.env,
    readStdin: readProcessStdin,
    readFile: (path) => readFileSync(path),
    out: (text) => {
      console.log(text);
    },
    err: (text) => {
      console.error(text);
    },
    openDb: createNodePostgresDatabase,
  }).then((code) => {
    process.exitCode = code;
  });
}
