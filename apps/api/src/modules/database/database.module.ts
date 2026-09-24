import { Global, Inject, Module, type OnModuleDestroy } from '@nestjs/common';
import {
  assertNonPrivilegedSession,
  createNodePostgresDatabase,
  type Database,
  type DatabaseHandle,
} from '@sifen/db';

export const DATABASE_HANDLE = Symbol('DatabaseHandle');
export const DATABASE = Symbol('Database');

async function createHandle(): Promise<DatabaseHandle | null> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    return null;
  }

  const handle = createNodePostgresDatabase(url);
  try {
    await assertNonPrivilegedSession(handle.db);
  } catch (error) {
    // The assertion failed (privileged session, or the check itself
    // couldn't run): the handle is unusable, so close it here or its pool
    // leaks forever, since nothing else ever gets a reference to it.
    await handle.close();
    throw error;
  }
  return handle;
}

/**
 * Creates the api's `DatabaseHandle` from `DATABASE_URL` (`app_login`) and
 * asserts it cannot bypass RLS at startup (ADR-0016). When `DATABASE_URL`
 * is unset, `DATABASE_HANDLE`/`DATABASE` are `null`: the app still boots
 * and `/health` works, but every route behind `ApiKeyGuard` fails closed
 * with 503 (backlog HU-E1-04).
 */
@Global()
@Module({
  providers: [
    { provide: DATABASE_HANDLE, useFactory: createHandle },
    {
      provide: DATABASE,
      useFactory: (handle: DatabaseHandle | null): Database | null => handle?.db ?? null,
      inject: [DATABASE_HANDLE],
    },
  ],
  exports: [DATABASE_HANDLE, DATABASE],
})
export class DatabaseModule implements OnModuleDestroy {
  constructor(@Inject(DATABASE_HANDLE) private readonly handle: DatabaseHandle | null) {}

  /** Closes the pool on app shutdown (see `main.ts`'s `enableShutdownHooks()`). */
  async onModuleDestroy(): Promise<void> {
    await this.handle?.close();
  }
}
