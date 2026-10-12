import { describe, expect, it } from 'vitest';
import { assertSafeDevSeedEnv, DevSeedRefusedError } from './dev-seed-guard.js';

const LOCAL = 'postgresql://sifen:sifen@localhost:5432/sifen';

describe('assertSafeDevSeedEnv', () => {
  it.each(['development', 'test'])('accepts NODE_ENV=%s against a local database', (nodeEnv) => {
    expect(() => {
      assertSafeDevSeedEnv({ NODE_ENV: nodeEnv, OPS_DATABASE_URL: LOCAL });
    }).not.toThrow();
  });

  it.each([undefined, '', 'production', 'staging', 'Development'])(
    'refuses NODE_ENV=%s',
    (nodeEnv) => {
      expect(() => {
        assertSafeDevSeedEnv({ NODE_ENV: nodeEnv, OPS_DATABASE_URL: LOCAL });
      }).toThrow(DevSeedRefusedError);
    },
  );

  it.each([
    'postgresql://u:p@127.0.0.1:5433/db',
    'postgresql://u:p@[::1]:5432/db',
    'postgres://u:p@LOCALHOST/db',
  ])('accepts the loopback host in %s', (url) => {
    expect(() => {
      assertSafeDevSeedEnv({ NODE_ENV: 'development', OPS_DATABASE_URL: url });
    }).not.toThrow();
  });

  it.each([
    'postgresql://u:p@db.prod.example.com:5432/db',
    'postgresql://u:p@10.0.0.5:5432/db',
    'postgresql://u:p@localhost.evil.com/db',
    'postgresql://localhost:p@evil.com/db',
    'postgresql://u:p@evil.com/db?host=localhost',
    'not a url',
    '',
  ])('refuses the non-local database %s', (url) => {
    expect(() => {
      assertSafeDevSeedEnv({ NODE_ENV: 'development', OPS_DATABASE_URL: url });
    }).toThrow(DevSeedRefusedError);
  });

  it('refuses a missing OPS_DATABASE_URL and never echoes the URL', () => {
    expect(() => {
      assertSafeDevSeedEnv({ NODE_ENV: 'development' });
    }).toThrow(DevSeedRefusedError);
    expect(() => {
      assertSafeDevSeedEnv({
        NODE_ENV: 'development',
        OPS_DATABASE_URL: 'postgresql://u:s3cret@evil.com/db',
      });
    }).toThrow(/^(?!.*s3cret)/);
  });
});
