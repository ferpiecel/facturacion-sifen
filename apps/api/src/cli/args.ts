import { parseArgs } from 'node:util';
import type { ApiKeyEnvironment } from '../modules/identity/domain/api-key.js';
import {
  createFiscalProfile,
  type EconomicActivity,
  type FiscalProfile,
  type TaxpayerType,
} from '../modules/fiscal-config/domain/fiscal-profile.js';
import { parseRuc } from '../modules/fiscal-config/domain/ruc.js';

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
  | { kind: 'apikey:revoke'; keyId: string }
  | { kind: 'fiscal:set'; tenantId: string; profile: FiscalProfile };

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

function parseTaxpayerType(value: string | undefined): TaxpayerType {
  const raw = requireOption(value, 'taxpayer-type');
  if (raw === 'fisica') {
    return 'persona_fisica';
  }
  if (raw === 'juridica') {
    return 'persona_juridica';
  }
  throw new OpsArgError(`--taxpayer-type must be "fisica" or "juridica", got "${raw}"`);
}

/** Parses repeated `--activity <code>:<description>` flags (backlog HU-E2-01). */
function parseActivities(values: string[] | undefined): EconomicActivity[] {
  return (values ?? []).map((entry) => {
    const separatorIndex = entry.indexOf(':');
    if (separatorIndex <= 0) {
      throw new OpsArgError(`--activity must be "<code>:<description>", got "${entry}"`);
    }
    return {
      code: entry.slice(0, separatorIndex),
      description: entry.slice(separatorIndex + 1),
    };
  });
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
    case 'fiscal:set': {
      const { values } = parseArgs({
        args: rest,
        options: {
          tenant: { type: 'string' },
          ruc: { type: 'string' },
          'legal-name': { type: 'string' },
          'trade-name': { type: 'string' },
          'taxpayer-type': { type: 'string' },
          regime: { type: 'string' },
          activity: { type: 'string', multiple: true },
        },
      });

      const profile = createFiscalProfile({
        ruc: parseRuc(requireOption(values.ruc, 'ruc')),
        legalName: requireOption(values['legal-name'], 'legal-name'),
        tradeName: values['trade-name'],
        taxpayerType: parseTaxpayerType(values['taxpayer-type']),
        regimeCode: values.regime,
        economicActivities: parseActivities(values.activity),
      });

      return {
        kind: 'fiscal:set',
        tenantId: requireOption(values.tenant, 'tenant'),
        profile,
      };
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
