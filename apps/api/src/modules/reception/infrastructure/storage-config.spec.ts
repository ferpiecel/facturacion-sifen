import { describe, expect, it } from 'vitest';
import { isStorageUnconfigured, loadStorageConfig } from './storage-config.js';

const full = {
  STORAGE_ENDPOINT_URL: 'https://s3.example.com',
  STORAGE_BUCKET: 'sifen-artifacts',
  STORAGE_ACCESS_KEY_ID: 'AKIAEXAMPLE0123456',
  STORAGE_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI-example-secret-0123456789',
};

describe('loadStorageConfig', () => {
  it('returns the parsed config with the default region', () => {
    expect(loadStorageConfig(full, 'production')).toEqual({
      status: 'enabled',
      config: {
        endpointUrl: 'https://s3.example.com',
        bucket: 'sifen-artifacts',
        accessKeyId: 'AKIAEXAMPLE0123456',
        secretAccessKey: 'wJalrXUtnFEMI-example-secret-0123456789',
        region: 'us-east-1',
      },
    });
  });

  it('honours STORAGE_REGION', () => {
    const result = loadStorageConfig({ ...full, STORAGE_REGION: 'sa-east-1' }, 'production');
    expect(result.status === 'enabled' && result.config.region).toBe('sa-east-1');
  });

  describe('production', () => {
    for (const name of Object.keys(full)) {
      it(`rejects a missing ${name}`, () => {
        const env = { ...full, [name]: undefined };
        expect(() => loadStorageConfig(env, 'production')).toThrow(name);
      });

      it(`rejects a blank ${name}`, () => {
        expect(() => loadStorageConfig({ ...full, [name]: '  ' }, 'production')).toThrow(name);
      });
    }

    it('rejects a non-https endpoint', () => {
      expect(() =>
        loadStorageConfig({ ...full, STORAGE_ENDPOINT_URL: 'http://s3.example.com' }, 'production'),
      ).toThrow(/https/);
    });

    it('rejects an endpoint with embedded credentials', () => {
      expect(() =>
        loadStorageConfig(
          { ...full, STORAGE_ENDPOINT_URL: 'https://user:pw@s3.example.com' },
          'production',
        ),
      ).toThrow(/credentials/);
    });

    it('rejects an unparseable endpoint', () => {
      expect(() =>
        loadStorageConfig({ ...full, STORAGE_ENDPOINT_URL: 'not a url' }, 'production'),
      ).toThrow(/STORAGE_ENDPOINT_URL/);
    });

    for (const placeholder of ['minioadmin', 'MinioAdmin', 'changeme', 'password', 'admin']) {
      it(`rejects the placeholder access key ${placeholder}`, () => {
        expect(() =>
          loadStorageConfig({ ...full, STORAGE_ACCESS_KEY_ID: placeholder }, 'production'),
        ).toThrow(/STORAGE_ACCESS_KEY_ID/);
      });

      it(`rejects the placeholder secret ${placeholder}`, () => {
        expect(() =>
          loadStorageConfig({ ...full, STORAGE_SECRET_ACCESS_KEY: placeholder }, 'production'),
        ).toThrow(/STORAGE_SECRET_ACCESS_KEY/);
      });
    }

    it('treats an unset NODE_ENV as production', () => {
      expect(() => loadStorageConfig({}, undefined)).toThrow(/STORAGE_ENDPOINT_URL/);
    });

    it('never echoes secret values in errors', () => {
      try {
        loadStorageConfig({ ...full, STORAGE_SECRET_ACCESS_KEY: 'changeme' }, 'production');
        expect.unreachable();
      } catch (error) {
        expect(String(error)).not.toContain('changeme');
      }
    });
  });

  describe.each(['development', 'test'])('%s', (nodeEnv) => {
    it('is disabled when nothing is configured', () => {
      expect(loadStorageConfig({}, nodeEnv)).toEqual({ status: 'disabled' });
    });

    it('treats blank values as unset', () => {
      expect(loadStorageConfig({ STORAGE_BUCKET: ' ', STORAGE_REGION: '' }, nodeEnv)).toEqual({
        status: 'disabled',
      });
    });

    it('rejects partially-set config', () => {
      expect(() => loadStorageConfig({ STORAGE_BUCKET: 'b' }, nodeEnv)).toThrow(
        /STORAGE_ENDPOINT_URL/,
      );
    });

    it('allows a local http endpoint and local credentials', () => {
      const result = loadStorageConfig(
        {
          ...full,
          STORAGE_ENDPOINT_URL: 'http://localhost:8333',
          STORAGE_ACCESS_KEY_ID: 'minioadmin',
          STORAGE_SECRET_ACCESS_KEY: 'minioadmin',
        },
        nodeEnv,
      );
      expect(result.status).toBe('enabled');
    });

    it('still rejects an unparseable endpoint', () => {
      expect(() => loadStorageConfig({ ...full, STORAGE_ENDPOINT_URL: '::' }, nodeEnv)).toThrow(
        /STORAGE_ENDPOINT_URL/,
      );
    });
  });
});

describe('isStorageUnconfigured', () => {
  it('is true when no storage variable is set', () => {
    expect(isStorageUnconfigured({})).toBe(true);
  });

  it('is true when every storage variable is blank', () => {
    expect(
      isStorageUnconfigured({
        STORAGE_ENDPOINT_URL: '',
        STORAGE_BUCKET: '  ',
        STORAGE_ACCESS_KEY_ID: undefined,
        STORAGE_SECRET_ACCESS_KEY: '\t',
        STORAGE_REGION: ' ',
      }),
    ).toBe(true);
  });

  it('ignores unrelated variables', () => {
    expect(isStorageUnconfigured({ NODE_ENV: 'production', OTHER: 'x' })).toBe(true);
  });

  for (const name of [...Object.keys(full), 'STORAGE_REGION']) {
    it(`is false when only ${name} is set`, () => {
      expect(isStorageUnconfigured({ [name]: 'value' })).toBe(false);
    });
  }
});
