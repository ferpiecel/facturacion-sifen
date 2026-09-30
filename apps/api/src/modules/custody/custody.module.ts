import { Module } from '@nestjs/common';
import { EnvelopeCipher } from './application/envelope-cipher.js';
import type { KeyManagementService } from './application/ports/key-management.port.js';
import { KEY_MANAGEMENT_SERVICE } from './custody.tokens.js';
import { createLocalKms } from './infrastructure/adapters/local-kms.adapter.js';

/**
 * Secret custody (ADR-0009). The KMS is built eagerly, so a production
 * deployment without `KMS_LOCAL_MASTER_KEY` fails to start (fail closed).
 */
@Module({
  providers: [
    {
      provide: KEY_MANAGEMENT_SERVICE,
      useFactory: (): KeyManagementService =>
        createLocalKms(process.env.KMS_LOCAL_MASTER_KEY, process.env.NODE_ENV),
    },
    {
      provide: EnvelopeCipher,
      useFactory: (kms: KeyManagementService) => new EnvelopeCipher(kms),
      inject: [KEY_MANAGEMENT_SERVICE],
    },
  ],
  exports: [EnvelopeCipher],
})
export class CustodyModule {}
