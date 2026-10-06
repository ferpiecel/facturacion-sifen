import { sql } from 'drizzle-orm';
import type { Database } from '@sifen/db';
import type { AuthEvent, AuthEventLog } from '../../application/ports/auth-event-log.port.js';
import { callFunction, subjectHash } from './sql-auth-support.shared.js';

/** `record_auth_event` of migration 0040 (append-only `auth_events`). */
export class SqlAuthEventLog implements AuthEventLog {
  constructor(private readonly db: Database) {}

  async record(event: AuthEvent): Promise<void> {
    await callFunction(
      this.db,
      sql`select record_auth_event(${event.userId}, ${subjectHash(event.subject)}, ${event.event}, ${JSON.stringify(event.detail ?? {})}::jsonb)`,
    );
  }
}
