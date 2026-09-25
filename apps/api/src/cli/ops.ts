import { createNodePostgresDatabase, type Database } from '@sifen/db';
import { getOpsDatabaseUrl, parseOpsArgs, type OpsCommand } from './args.js';
import { createPartner, createTenant, issueApiKey, revokeApiKey } from './commands.js';

/**
 * Dispatches one parsed {@link OpsCommand} to its handler and formats the
 * operator-facing output (backlog HU-E1-05). `apikey:create`'s formatted
 * key is the only place the raw secret ever appears — the caller must
 * print this return value once and never log it again.
 */
export async function runOpsCommand(db: Database, command: OpsCommand): Promise<string> {
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
  }
}

// Process entrypoint below, exercised by the manual docker check (see
// README's "Operación" section) and excluded from coverage in
// vitest.config.ts, not by unit tests.
async function main(): Promise<void> {
  const url = getOpsDatabaseUrl(process.env);
  const command = parseOpsArgs(process.argv.slice(2));

  const handle = createNodePostgresDatabase(url);
  try {
    const output = await runOpsCommand(handle.db, command);
    console.log(output);
  } finally {
    await handle.close();
  }
}

const isMainModule =
  process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href;
if (isMainModule) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
