import { parseArgs, type ParseArgsConfig } from 'node:util';
import {
  createEstablishment,
  createEstablishmentContact,
  type Establishment,
  type EstablishmentContact,
} from '../modules/fiscal-config/domain/establishment.js';
import {
  createExpeditionPoint,
  type ExpeditionPoint,
} from '../modules/fiscal-config/domain/expedition-point.js';
import {
  createFiscalProfile,
  type EconomicActivity,
  type FiscalProfile,
  type TaxpayerType,
} from '../modules/fiscal-config/domain/fiscal-profile.js';
import { parseRuc } from '../modules/fiscal-config/domain/ruc.js';
import { createTimbrado, type Timbrado } from '../modules/fiscal-config/domain/timbrado.js';
import type { TenantEnvironment } from '../modules/fiscal-config/domain/document-environment.js';
import { InvalidCscError, parseCsc } from '../modules/custody/domain/csc.js';
import type { ApiKeyEnvironment } from '../modules/identity/domain/api-key.js';
import { isPortalRole, type PortalRole } from '../modules/identity/domain/portal-role.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Invalid argv or missing environment for the operator CLI (backlog HU-E1-05). */
export class OpsArgError extends Error {}

export type OpsCommand =
  | { kind: 'usage:show'; tenantId: string; period: string | undefined }
  | { kind: 'tenant:sync-transmission'; tenantId: string; enabled: boolean }
  | {
      kind: 'subscription:assign';
      tenantId: string;
      planCode: string;
      startsOn: string | undefined;
    }
  | {
      kind: 'payment:record';
      tenantId: string;
      amount: number;
      reference: string | undefined;
      paidOn: string | undefined;
    }
  | { kind: 'plan:seed' }
  | { kind: 'plan:list' }
  | {
      kind: 'plan:price-set';
      planCode: string;
      monthlyPrice: number;
      includedDocuments: number;
      overagePrice: number;
      validFrom: string;
      tiers: { fromDocuments: number; unitPrice: number }[];
    }
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
  | {
      kind: 'user:create';
      tenantId: string;
      email: string;
      displayName: string;
      role: PortalRole;
      /** Read from stdin by the CLI (`--password -`), never from argv; omitted for an existing user. */
      password: string | undefined;
    }
  | { kind: 'fiscal:set'; tenantId: string; profile: FiscalProfile }
  | { kind: 'establishment:add'; tenantId: string; establishment: Establishment }
  | {
      kind: 'establishment:contact';
      tenantId: string;
      establishmentCode: string;
      contact: EstablishmentContact;
    }
  | { kind: 'document:release-hold'; tenantId: string; documentId: string }
  | { kind: 'document:release-holds'; tenantId: string; reason: string }
  | { kind: 'point:add'; tenantId: string; establishmentCode: string; point: ExpeditionPoint }
  | { kind: 'timbrado:add'; tenantId: string; timbrado: Timbrado }
  | { kind: 'tenant:environment'; tenantId: string; environment: TenantEnvironment }
  | {
      kind: 'csc:add';
      tenantId: string;
      environment: TenantEnvironment;
      idCsc: string;
      csc: string;
    }
  | {
      kind: 'certificate:add';
      tenantId: string;
      environment: TenantEnvironment;
      p12Path: string;
      /** Read from stdin by the CLI (`--password -`), never from argv. */
      password: string;
      replace: boolean;
    }
  | {
      kind: 'certificate:revoke';
      tenantId: string;
      /** Exactly one of `id` / `fingerprint` is set. */
      id: string | undefined;
      fingerprint: string | undefined;
      /** Narrows a fingerprint that exists in both environments. */
      environment: TenantEnvironment | undefined;
    };

/**
 * `parseArgs` wrapper: stray positionals (a forgotten flag, an unquoted value)
 * and parser errors become fixed messages, because node's own errors echo the
 * offending argv value, which for `csc:add` may be the CSC.
 */
function parseStrict<T extends ParseArgsConfig>(config: T) {
  try {
    const result = parseArgs({ ...config, allowPositionals: true });
    if (result.positionals.length > 0) {
      throw new OpsArgError('unexpected positional argument (value hidden)');
    }
    return result;
  } catch (error) {
    if (error instanceof OpsArgError) {
      throw error;
    }
    const code = (error as { code?: string }).code ?? 'ERR_PARSE_ARGS';
    throw new OpsArgError(`invalid arguments (${code})`);
  }
}

function parseCount(value: string | undefined, flag: string): number {
  const raw = requireOption(value, flag);
  const number = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(number)) {
    throw new OpsArgError(`--${flag} must be a non-negative whole number`);
  }
  return number;
}

/** `--tier <from-documents>:<unit-price>`: the unit price applies from that document count upward. */
function parseTier(value: string): { fromDocuments: number; unitPrice: number } {
  const parts = value.split(':');
  if (parts.length !== 2) {
    throw new OpsArgError('--tier must be <from-documents>:<unit-price>');
  }
  const [from, price] = parts;
  return { fromDocuments: parseCount(from, 'tier'), unitPrice: parseCount(price, 'tier') };
}

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

/** Parses `--env test|production` for `tenant:environment` (HU-E2-04). */
function parseTenantEnvironment(value: string | undefined): TenantEnvironment {
  const environment = requireOption(value, 'env');
  if (environment !== 'test' && environment !== 'production') {
    throw new OpsArgError(`--env must be "test" or "production", got "${environment}"`);
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

/** Parses `--department <code>` (cDepEmi) into the integer the establishment domain expects. */
function parseDepartmentCode(value: string | undefined): number {
  const raw = requireOption(value, 'department');
  const code = Number(raw);
  if (!Number.isInteger(code)) {
    throw new OpsArgError(`--department must be an integer code, got "${raw}"`);
  }
  return code;
}

/**
 * `--district`/`--district-description` (cDisEmi/dDesDisEmi) mirror the
 * domain's occurrence-0-1 rule: both present or both absent. Passing only
 * one is a usage error here rather than a silent domain rejection later.
 */
function parseDistrict(
  district: string | undefined,
  districtDescription: string | undefined,
): { districtCode: string | undefined; districtDescription: string | undefined } {
  if ((district === undefined) !== (districtDescription === undefined)) {
    throw new OpsArgError(
      '--district and --district-description must both be provided or both omitted',
    );
  }
  return { districtCode: district, districtDescription };
}

/** Parses `argv` (without `node`/script) into one typed operator command, or throws {@link OpsArgError}. */
export function parseOpsArgs(argv: string[]): OpsCommand {
  const [subcommand, ...rest] = argv;
  if (!subcommand) {
    throw new OpsArgError('missing subcommand');
  }

  switch (subcommand) {
    case 'tenant:sync-transmission': {
      const { values } = parseStrict({
        args: rest,
        options: {
          tenant: { type: 'string' },
          on: { type: 'boolean' },
          off: { type: 'boolean' },
        },
      });
      if (values.on === values.off) throw new OpsArgError('pass exactly one of --on or --off');
      return {
        kind: 'tenant:sync-transmission',
        tenantId: requireOption(values.tenant, 'tenant'),
        enabled: values.on === true,
      };
    }
    case 'usage:show': {
      const { values } = parseStrict({
        args: rest,
        options: { tenant: { type: 'string' }, period: { type: 'string' } },
      });
      return {
        kind: 'usage:show',
        tenantId: requireOption(values.tenant, 'tenant'),
        period: values.period,
      };
    }
    case 'subscription:assign': {
      const { values } = parseStrict({
        args: rest,
        options: {
          tenant: { type: 'string' },
          plan: { type: 'string' },
          'starts-on': { type: 'string' },
        },
      });
      return {
        kind: 'subscription:assign',
        tenantId: requireOption(values.tenant, 'tenant'),
        planCode: requireOption(values.plan, 'plan'),
        startsOn: values['starts-on'],
      };
    }
    case 'payment:record': {
      const { values } = parseStrict({
        args: rest,
        options: {
          tenant: { type: 'string' },
          amount: { type: 'string' },
          reference: { type: 'string' },
          'paid-on': { type: 'string' },
        },
      });
      const amount = parseCount(values.amount, 'amount');
      if (amount === 0) {
        throw new OpsArgError('--amount must be greater than zero');
      }
      return {
        kind: 'payment:record',
        tenantId: requireOption(values.tenant, 'tenant'),
        amount,
        reference: values.reference,
        paidOn: values['paid-on'],
      };
    }
    case 'plan:seed':
    case 'plan:list': {
      parseStrict({ args: rest, options: {} });
      return { kind: subcommand };
    }
    case 'plan:price-set': {
      const { values } = parseStrict({
        args: rest,
        options: {
          plan: { type: 'string' },
          monthly: { type: 'string' },
          included: { type: 'string' },
          overage: { type: 'string' },
          'valid-from': { type: 'string' },
          tier: { type: 'string', multiple: true },
        },
      });
      return {
        kind: 'plan:price-set',
        planCode: requireOption(values.plan, 'plan'),
        monthlyPrice: parseCount(values.monthly, 'monthly'),
        includedDocuments: parseCount(values.included, 'included'),
        overagePrice: parseCount(values.overage, 'overage'),
        validFrom: requireOption(values['valid-from'], 'valid-from'),
        tiers: (values.tier ?? []).map(parseTier),
      };
    }
    case 'partner:create': {
      const { values } = parseStrict({ args: rest, options: { name: { type: 'string' } } });
      return { kind: 'partner:create', name: requireOption(values.name, 'name') };
    }
    case 'tenant:create': {
      const { values } = parseStrict({
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
      const { values } = parseStrict({
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
      const { values } = parseStrict({ args: rest, options: { 'key-id': { type: 'string' } } });
      return { kind: 'apikey:revoke', keyId: requireOption(values['key-id'], 'key-id') };
    }
    case 'user:create': {
      const { values } = parseStrict({
        args: rest,
        options: {
          tenant: { type: 'string' },
          email: { type: 'string' },
          name: { type: 'string' },
          role: { type: 'string' },
          password: { type: 'string' },
        },
      });
      const role = requireOption(values.role, 'role');
      if (!isPortalRole(role)) {
        throw new OpsArgError('--role must be owner, admin, emisor or lector');
      }
      return {
        kind: 'user:create',
        tenantId: requireOption(values.tenant, 'tenant'),
        email: requireOption(values.email, 'email'),
        displayName: requireOption(values.name, 'name'),
        role,
        password: values.password,
      };
    }
    case 'fiscal:set': {
      const { values } = parseStrict({
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
    case 'establishment:add': {
      const { values } = parseStrict({
        args: rest,
        options: {
          tenant: { type: 'string' },
          code: { type: 'string' },
          address: { type: 'string' },
          'house-number': { type: 'string' },
          'address-complement-1': { type: 'string' },
          'address-complement-2': { type: 'string' },
          department: { type: 'string' },
          district: { type: 'string' },
          'district-description': { type: 'string' },
          city: { type: 'string' },
          'city-description': { type: 'string' },
          phone: { type: 'string' },
          email: { type: 'string' },
          name: { type: 'string' },
        },
      });

      const { districtCode, districtDescription } = parseDistrict(
        values.district,
        values['district-description'],
      );

      const establishment = createEstablishment({
        code: requireOption(values.code, 'code'),
        address: requireOption(values.address, 'address'),
        houseNumber: requireOption(values['house-number'], 'house-number'),
        addressComplement1: values['address-complement-1'],
        addressComplement2: values['address-complement-2'],
        departmentCode: parseDepartmentCode(values.department),
        districtCode,
        districtDescription,
        cityCode: requireOption(values.city, 'city'),
        cityDescription: requireOption(values['city-description'], 'city-description'),
        phone: values.phone,
        email: values.email,
        commercialName: values.name,
      });

      return {
        kind: 'establishment:add',
        tenantId: requireOption(values.tenant, 'tenant'),
        establishment,
      };
    }
    case 'establishment:contact': {
      const { values } = parseStrict({
        args: rest,
        options: {
          tenant: { type: 'string' },
          establishment: { type: 'string' },
          phone: { type: 'string' },
          email: { type: 'string' },
          name: { type: 'string' },
        },
      });
      return {
        kind: 'establishment:contact',
        tenantId: requireOption(values.tenant, 'tenant'),
        establishmentCode: requireOption(values.establishment, 'establishment'),
        contact: createEstablishmentContact({
          phone: requireOption(values.phone, 'phone'),
          email: requireOption(values.email, 'email'),
          commercialName: values.name,
        }),
      };
    }
    case 'document:release-hold': {
      const { values } = parseStrict({
        args: rest,
        options: { tenant: { type: 'string' }, document: { type: 'string' } },
      });
      return {
        kind: 'document:release-hold',
        tenantId: requireOption(values.tenant, 'tenant'),
        documentId: requireOption(values.document, 'document'),
      };
    }
    case 'document:release-holds': {
      const { values } = parseStrict({
        args: rest,
        options: { tenant: { type: 'string' }, reason: { type: 'string' } },
      });
      const reason = requireOption(values.reason, 'reason');
      if (!/^[A-Za-z0-9:_-]{1,64}$/.test(reason)) {
        throw new OpsArgError(
          '--reason must be a plain hold code, e.g. signing:CscNotConfiguredError',
        );
      }
      return {
        kind: 'document:release-holds',
        tenantId: requireOption(values.tenant, 'tenant'),
        reason,
      };
    }
    case 'point:add': {
      const { values } = parseStrict({
        args: rest,
        options: {
          tenant: { type: 'string' },
          establishment: { type: 'string' },
          code: { type: 'string' },
        },
      });

      const point = createExpeditionPoint({ code: requireOption(values.code, 'code') });

      return {
        kind: 'point:add',
        tenantId: requireOption(values.tenant, 'tenant'),
        establishmentCode: requireOption(values.establishment, 'establishment'),
        point,
      };
    }
    case 'timbrado:add': {
      const { values } = parseStrict({
        args: rest,
        options: {
          tenant: { type: 'string' },
          number: { type: 'string' },
          'valid-from': { type: 'string' },
          'valid-to': { type: 'string' },
        },
      });

      const timbrado = createTimbrado({
        number: requireOption(values.number, 'number'),
        validityStart: requireOption(values['valid-from'], 'valid-from'),
        validityEnd: values['valid-to'],
      });

      return {
        kind: 'timbrado:add',
        tenantId: requireOption(values.tenant, 'tenant'),
        timbrado,
      };
    }
    case 'tenant:environment': {
      const { values } = parseStrict({
        args: rest,
        options: {
          tenant: { type: 'string' },
          env: { type: 'string' },
          'confirm-production': { type: 'boolean' },
        },
      });

      const environment = parseTenantEnvironment(values.env);
      if (environment === 'production' && !values['confirm-production']) {
        throw new OpsArgError(
          '--confirm-production is required to switch --env production (HU-E2-04)',
        );
      }

      return {
        kind: 'tenant:environment',
        tenantId: requireOption(values.tenant, 'tenant'),
        environment,
      };
    }
    case 'csc:add': {
      const { values } = parseStrict({
        args: rest,
        options: {
          tenant: { type: 'string' },
          env: { type: 'string' },
          id: { type: 'string' },
          csc: { type: 'string' },
        },
      });

      const tenantId = requireOption(values.tenant, 'tenant');
      const environment = parseTenantEnvironment(values.env);
      try {
        // parseCsc never echoes the value; a format error is a usage error.
        const { idCsc, value } = parseCsc(
          requireOption(values.id, 'id'),
          requireOption(values.csc, 'csc'),
        );
        return { kind: 'csc:add', tenantId, environment, idCsc, csc: value };
      } catch (error) {
        if (error instanceof InvalidCscError) {
          throw new OpsArgError(error.message);
        }
        throw error;
      }
    }
    case 'certificate:add': {
      const { values } = parseStrict({
        args: rest,
        options: {
          tenant: { type: 'string' },
          env: { type: 'string' },
          p12: { type: 'string' },
          password: { type: 'string' },
          replace: { type: 'boolean' },
        },
      });
      return {
        kind: 'certificate:add',
        tenantId: requireOption(values.tenant, 'tenant'),
        environment: parseTenantEnvironment(values.env),
        p12Path: requireOption(values.p12, 'p12'),
        password: requireOption(values.password, 'password'),
        replace: values.replace === true,
      };
    }
    case 'certificate:revoke': {
      const { values } = parseStrict({
        args: rest,
        options: {
          tenant: { type: 'string' },
          id: { type: 'string' },
          fingerprint: { type: 'string' },
          env: { type: 'string' },
        },
      });
      if ((values.id === undefined) === (values.fingerprint === undefined)) {
        throw new OpsArgError('pass exactly one of --id or --fingerprint');
      }
      if (values.id !== undefined && !UUID_PATTERN.test(values.id)) {
        throw new OpsArgError('--id must be a certificate uuid');
      }
      const fingerprint = values.fingerprint?.toLowerCase();
      if (fingerprint !== undefined && !/^[0-9a-f]{64}$/.test(fingerprint)) {
        throw new OpsArgError(
          '--fingerprint must be 64 hex characters (sha-256 of the certificate)',
        );
      }
      return {
        kind: 'certificate:revoke',
        tenantId: requireOption(values.tenant, 'tenant'),
        id: values.id,
        fingerprint,
        environment: values.env === undefined ? undefined : parseTenantEnvironment(values.env),
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
