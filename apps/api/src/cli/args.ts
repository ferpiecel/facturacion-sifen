import { parseArgs } from 'node:util';
import type { ApiKeyEnvironment } from '../modules/identity/domain/api-key.js';

/** Invalid argv or missing environment for the operator CLI (backlog HU-E1-05). */
export class OpsArgError extends Error {}

export type OpsCommand =
  | { kind: 'partner:create'; name: string }
  | { kind: 'tenant:create'; name: string; partnerId: string | undefined }
  | {
      kind: 'apikey:create';
      tenantId: string;
      environment: ApiKeyEnvironment;
      scopes: string[];
      label: string | undefined;
    }
  | { kind: 'apikey:revoke'; keyId: string };

function requireOption(value: string | undefined, flag: string): string {
  if (!value) {
    throw new OpsArgError(`missing required --${flag}`);
  }
  return value;
}

function parseEnvironment(value: string | undefined): ApiKeyEnvironment {
  const environment = requireOption(value, 'env');
  if (environment !== 'live' && environment !== 'test') {
    throw new OpsArgError(`--env must be "live" or "test", got "${environment}"`);
  }
  return environment;
}

function parseScopes(value: string | undefined): string[] {
  const raw = requireOption(value, 'scopes');
  return raw
    .split(',')
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
}

/** Parses `argv` (without `node`/script) into one typed operator command, or throws {@link OpsArgError}. */
export function parseOpsArgs(argv: string[]): OpsCommand {
  const [subcommand, ...rest] = argv;
  if (!subcommand) {
    throw new OpsArgError('missing subcommand');
  }

  switch (subcommand) {
    case 'partner:create': {
      const { values } = parseArgs({ args: rest, options: { name: { type: 'string' } } });
      return { kind: 'partner:create', name: requireOption(values.name, 'name') };
    }
    case 'tenant:create': {
      const { values } = parseArgs({
        args: rest,
        options: { name: { type: 'string' }, partner: { type: 'string' } },
      });
      return {
        kind: 'tenant:create',
        name: requireOption(values.name, 'name'),
        partnerId: values.partner,
      };
    }
    case 'apikey:create': {
      const { values } = parseArgs({
        args: rest,
        options: {
          tenant: { type: 'string' },
          env: { type: 'string' },
          scopes: { type: 'string' },
          label: { type: 'string' },
        },
      });
      return {
        kind: 'apikey:create',
        tenantId: requireOption(values.tenant, 'tenant'),
        environment: parseEnvironment(values.env),
        scopes: parseScopes(values.scopes),
        label: values.label,
      };
    }
    case 'apikey:revoke': {
      const { values } = parseArgs({ args: rest, options: { 'key-id': { type: 'string' } } });
      return { kind: 'apikey:revoke', keyId: requireOption(values['key-id'], 'key-id') };
    }
    default:
      throw new OpsArgError(`unknown subcommand "${subcommand}"`);
  }
}

/**
 * The operator CLI must run against its own DB role, never `app_login`
 * (backlog HU-E1-05): reading `DATABASE_URL` here would be a silent
 * privilege mix-up, so only `OPS_DATABASE_URL` is ever consulted.
 */
export function getOpsDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const url = env.OPS_DATABASE_URL;
  if (!url) {
    throw new OpsArgError('OPS_DATABASE_URL is required to run the operator CLI');
  }
  return url;
}
