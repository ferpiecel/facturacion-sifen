import { sql } from 'drizzle-orm';
import type { Database } from '@sifen/db';
import type { SealedSecret } from '../../../custody/domain/sealed-secret.js';
import type { MfaRecord, MfaStore } from '../../application/ports/mfa.ports.js';
import { callFunction } from './sql-auth-support.shared.js';

interface MfaRow {
  sealed: SealedSecret;
  confirmed_at: Date | string | null;
  last_used_step: string | number | null;
  recovery_hashes: string[];
}

const enrolmentUnavailable = () => new Error('MFA enrolment is not available yet');

/**
 * The login-time half of `MfaStore` for the runtime connection, BOUND to one pending session (the SHA-256 of
 * its token): the `userId` arguments of the port are ignored and the functions resolve the user from that live
 * pending session, so a caller cannot read or spend another user's MFA state. (`app_user` through the `mfa_*` functions of
 * migration 0042): read the enrolment, spend a TOTP step, spend a recovery code. The enrolment writes need the
 * operator connection today (`DrizzleMfaStore`); the portal has no enrolment endpoint yet, so they refuse.
 */
export class SqlMfaRuntimeStore implements MfaStore {
  constructor(
    private readonly db: Database,
    private readonly pendingHash: string,
  ) {}

  async find(): Promise<MfaRecord | null> {
    const row = (
      await callFunction<MfaRow>(this.db, sql`select * from mfa_find(${this.pendingHash})`)
    ).at(0);
    return row
      ? {
          sealed: row.sealed,
          confirmedAt: row.confirmed_at === null ? null : new Date(row.confirmed_at),
          lastUsedStep: row.last_used_step === null ? null : Number(row.last_used_step),
          recoveryHashes: row.recovery_hashes,
        }
      : null;
  }

  async advanceStep(_userId: string, step: number): Promise<boolean> {
    const row = (
      await callFunction<{ ok: boolean }>(
        this.db,
        sql`select mfa_advance_step(${this.pendingHash}, ${step}) as ok`,
      )
    ).at(0);
    return row?.ok === true;
  }

  async consumeRecoveryCode(_userId: string, hash: string): Promise<boolean> {
    const row = (
      await callFunction<{ ok: boolean }>(
        this.db,
        sql`select mfa_consume_recovery_code(${this.pendingHash}, ${hash}) as ok`,
      )
    ).at(0);
    return row?.ok === true;
  }

  readonly savePending: MfaStore['savePending'] = () => Promise.reject(enrolmentUnavailable());
  readonly confirm: MfaStore['confirm'] = () => Promise.reject(enrolmentUnavailable());
  readonly remove: MfaStore['remove'] = () => Promise.reject(enrolmentUnavailable());
}
