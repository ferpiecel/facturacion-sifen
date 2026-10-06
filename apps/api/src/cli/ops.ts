import { createNodePostgresDatabase, type Database } from '@sifen/db';
import { EnvelopeCipher } from '../modules/custody/application/envelope-cipher.js';
import { createLocalKms } from '../modules/custody/infrastructure/adapters/local-kms.adapter.js';
import { CscVault } from '../modules/custody/infrastructure/csc-vault.js';
import { MAX_PKCS12_BYTES } from '../modules/certificates/infrastructure/pkcs12-inspector.js';
import { CertificateVault } from '../modules/certificates/infrastructure/certificate-vault.js';
import { loadTrustedRoots } from '../modules/certificates/infrastructure/trusted-roots.js';
import { BoundedReadError, readBoundedFile } from './bounded-file.js';
import { getOpsDatabaseUrl, OpsArgError, parseOpsArgs, type OpsCommand } from './args.js';
import {
  addEstablishment,
  addExpeditionPoint,
  addTimbrado,
  createPartner,
  createTenant,
  issueApiKey,
  releaseDocumentHold,
  releaseDocumentHolds,
  revokeApiKey,
  revokeCertificate,
  setEstablishmentContact,
  setFiscalProfile,
  setTenantEnvironment,
} from './commands.js';
import { createPortalUser } from './user-commands.js';

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
  readFile: (path: string, maxBytes: number) => Buffer,
): CertificateVault {
  if (!env.KMS_LOCAL_MASTER_KEY) {
    throw new Error(
      'certificate:add requires KMS_LOCAL_MASTER_KEY (a throwaway key would lose the certificate)',
    );
  }
  const trustedPscRoots = loadTrustedRoots(env, (path) =>
    readFile(path, MAX_ROOTS_BUNDLE_BYTES).toString('utf8'),
  );
  const cipher = new EnvelopeCipher(createLocalKms(env.KMS_LOCAL_MASTER_KEY, env.NODE_ENV));
  return new CertificateVault(cipher, { trustedPscRoots });
}

/** A PEM bundle of a handful of roots is a few KiB; anything near this is not one. */
const MAX_ROOTS_BUNDLE_BYTES = 1024 * 1024;

export interface CertificateDeps {
  readonly vault: CertificateVault;
  /** The `.p12`, already read within its size cap before any database work; zeroized after use. */
  readonly p12: Buffer;
}

/** Reads the `--p12` file within the PKCS#12 size cap, with errors that never carry the path. */
function readP12(io: Pick<CliIo, 'readFile'>, path: string): Buffer {
  try {
    return io.readFile(path, MAX_PKCS12_BYTES);
  } catch (error) {
    // The cause is dropped on purpose: formatOpsError prints causes, and a path must not leak.
    /* eslint-disable preserve-caught-error */
    if (error instanceof BoundedReadError && error.reason === 'too-large') {
      throw new Error('the --p12 file is larger than 64 KiB; it is not a tenant certificate');
    }
    throw new Error('could not read the --p12 file (it must be a regular file)');
    /* eslint-enable preserve-caught-error */
  }
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
    case 'user:create': {
      const result = await createPortalUser(db, {
        tenantId: command.tenantId,
        email: command.email,
        displayName: command.displayName,
        role: command.role,
        password: command.password,
      });
      return result.created
        ? `user created: ${result.userId} (${command.role})`
        : `user added to tenant: ${result.userId} (${command.role}); the account already existed, so --name and any password were ignored`;
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
    case 'establishment:contact': {
      const result = await setEstablishmentContact(db, {
        tenantId: command.tenantId,
        establishmentCode: command.establishmentCode,
        contact: command.contact,
      });
      // Public business data, but echoing only the code keeps the output uniform with the others.
      return `establishment contact saved: ${command.tenantId} (code ${result.code})`;
    }
    case 'document:release-hold': {
      const result = await releaseDocumentHold(db, {
        tenantId: command.tenantId,
        documentId: command.documentId,
      });
      return `document hold released: ${result.id} (was ${result.hold})`;
    }
    case 'document:release-holds': {
      const count = await releaseDocumentHolds(db, {
        tenantId: command.tenantId,
        reason: command.reason,
      });
      return `document holds released: ${String(count)} (${command.reason})`;
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
      const { p12 } = certificates;
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
    case 'certificate:revoke': {
      const result = await revokeCertificate(db, {
        tenantId: command.tenantId,
        id: command.id,
        fingerprint: command.fingerprint,
        environment: command.environment,
      });
      const facts = `tenant ${command.tenantId} (${result.environment}, id ${result.id}, fingerprint ${result.fingerprint})`;
      return result.revoked
        ? `certificate revoked: ${facts}`
        : `certificate already revoked: ${facts}`;
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

/** Longest secret read from stdin: the policy caps a password at 128 characters, a CSC is 32. */
export const MAX_STDIN_SECRET_LENGTH = 4096;

async function readSecret(readStdin: () => Promise<string>): Promise<string> {
  const value = (await readStdin()).replace(/\r?\n$/, '');
  if (value.length > MAX_STDIN_SECRET_LENGTH) {
    throw new OpsArgError(
      `stdin secret is larger than ${String(MAX_STDIN_SECRET_LENGTH)} characters (value hidden)`,
    );
  }
  return value;
}

/**
 * `--csc -` reads the CSC from stdin so it never lands in shell history or `ps`. For
 * `certificate:add` and `user:create` the password may only come that way: `--password -`. The value
 * goes back as ONE `--flag=value` token, so a secret that starts with a dash is not read as an option.
 */
export async function resolveStdinSecrets(
  argv: string[],
  readStdin: () => Promise<string>,
): Promise<string[]> {
  const command = argv[0];
  if (command === 'certificate:add' || command === 'user:create') {
    const occurrences = argv.filter((arg) => arg === '--password' || arg.startsWith('--password='));
    const index = argv.indexOf('--password');
    if (
      occurrences.length > 1 ||
      occurrences.some((arg) => arg !== '--password') ||
      (index >= 0 && argv[index + 1] !== '-')
    ) {
      throw new OpsArgError(
        '--password must be given once, as "-": the password is read from stdin, never from argv (value hidden)',
      );
    }
    if (index < 0) return argv;
    const value = await readSecret(readStdin);
    return [...argv.slice(0, index), `--password=${value}`, ...argv.slice(index + 2)];
  }
  const index = argv.indexOf('--csc');
  if (command !== 'csc:add' || argv[index + 1] !== '-') {
    return argv;
  }
  const value = await readSecret(readStdin);
  return [...argv.slice(0, index), `--csc=${value}`, ...argv.slice(index + 2)];
}

export interface CliIo {
  argv: string[];
  env: NodeJS.ProcessEnv;
  readStdin: () => Promise<string>;
  /** Reads a file of at most `maxBytes` (regular files only). */
  readFile: (path: string, maxBytes: number) => Buffer;
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
        ? {
            vault: createCertificateVault(io.env, io.readFile),
            p12: readP12(io, command.p12Path),
          }
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
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    // Stop reading long before memory matters; readSecret rejects anything past the character limit.
    if (bytes > MAX_STDIN_SECRET_LENGTH * 4) {
      throw new OpsArgError('stdin secret is too large (value hidden)');
    }
    chunks.push(buffer);
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
    readFile: (path, maxBytes) => readBoundedFile(path, maxBytes),
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
