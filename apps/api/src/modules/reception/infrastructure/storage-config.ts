/** Object storage settings read from the environment (infrastructure concern only). */
export interface StorageConfig {
  readonly endpointUrl: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: string;
}

export type StorageConfigResult =
  { readonly status: 'disabled' } | { readonly status: 'enabled'; readonly config: StorageConfig };

const DEFAULT_REGION = 'us-east-1';

/** Well-known default credentials that must never reach production. Compared case-insensitively. */
const PERMISSIVE_CREDENTIALS = new Set([
  'minioadmin',
  'minio',
  'changeme',
  'change-me',
  'password',
  'admin',
  'secret',
  'test',
  'example',
]);

const REQUIRED = [
  ['STORAGE_ENDPOINT_URL', 'endpointUrl'],
  ['STORAGE_BUCKET', 'bucket'],
  ['STORAGE_ACCESS_KEY_ID', 'accessKeyId'],
  ['STORAGE_SECRET_ACCESS_KEY', 'secretAccessKey'],
] as const;

function read(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function assertEndpoint(endpoint: string, production: boolean): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('STORAGE_ENDPOINT_URL must be a valid URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('STORAGE_ENDPOINT_URL must use http or https.');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('STORAGE_ENDPOINT_URL must not embed credentials.');
  }
  if (production && url.protocol !== 'https:') {
    throw new Error(
      'STORAGE_ENDPOINT_URL must use https when NODE_ENV is not development or test.',
    );
  }
}

const ALL_STORAGE_VARIABLES = [...REQUIRED.map(([name]) => name), 'STORAGE_REGION'] as const;

/**
 * True when no storage variable is set at all (unset or blank), i.e. storage is not in use.
 * Independent of NODE_ENV: callers that must not fail for deployments without storage use it
 * before `loadStorageConfig`.
 */
export function isStorageUnconfigured(env: Readonly<Record<string, string | undefined>>): boolean {
  return ALL_STORAGE_VARIABLES.every((name) => read(env, name) === undefined);
}

/**
 * Parses the storage environment variables, failing fast on unsafe configuration.
 *
 * - `development` / `test`: nothing set yields `disabled` (storage unavailable, no crash);
 *   a partial configuration is rejected.
 * - Any other `NODE_ENV` (including unset): every required value must be present, the endpoint
 *   must be https and the credentials must not be well-known placeholders.
 *
 * Error messages name variables, never their values.
 */
export function loadStorageConfig(
  env: Readonly<Record<string, string | undefined>>,
  nodeEnv: string | undefined,
): StorageConfigResult {
  const production = nodeEnv !== 'development' && nodeEnv !== 'test';
  const values = REQUIRED.map(([name]) => read(env, name));

  if (!production && values.every((value) => value === undefined)) {
    return { status: 'disabled' };
  }

  const missing = REQUIRED.filter((_, index) => values[index] === undefined).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`Missing required storage configuration: ${missing.join(', ')}.`);
  }

  const [endpointUrl, bucket, accessKeyId, secretAccessKey] = values as [
    string,
    string,
    string,
    string,
  ];
  assertEndpoint(endpointUrl, production);

  if (production) {
    for (const [name, value] of [
      ['STORAGE_ACCESS_KEY_ID', accessKeyId],
      ['STORAGE_SECRET_ACCESS_KEY', secretAccessKey],
    ] as const) {
      if (PERMISSIVE_CREDENTIALS.has(value.toLowerCase())) {
        throw new Error(`${name} is a well-known placeholder; set a real credential.`);
      }
    }
  }

  return {
    status: 'enabled',
    config: {
      endpointUrl,
      bucket,
      accessKeyId,
      secretAccessKey,
      region: read(env, 'STORAGE_REGION') ?? DEFAULT_REGION,
    },
  };
}
