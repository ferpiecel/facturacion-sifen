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

const unavailable = () => new Error('MFA removal is not available at runtime');

/**
 * The login-time half of `MfaStore` for the runtime connection, BOUND to one pending session (the SHA-256 of
 * its token): the `userId` arguments of the port are ignored and the functions resolve the user from that live
 * pending session, so a caller cannot read or spend another user's MFA state. (`app_user` through the `mfa_*` functions of
 * migration 0042): read the enrolment, spend a TOTP step, spend a recovery code. Enrolment (`savePending`, `confirm`,
 * `account`) goes through the same pending-bound functions of migration 0045; removing an enrolment (a reset) is an
 * operator action (`DrizzleMfaStore`) and refuses here.
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

  /** The email of the pending session's user: the label of the authenticator entry. */
  async account(): Promise<string | null> {
    const row = (
      await callFunction<{ account: string | null }>(
        this.db,
        sql`select mfa_account(${this.pendingHash}) as account`,
      )
    ).at(0);
    return row?.account ?? null;
  }

  async savePending(_userId: string, sealed: SealedSecret): Promise<void> {
    const row = (
      await callFunction<{ ok: boolean }>(
        this.db,
        sql`select mfa_save_pending(${this.pendingHash}, ${JSON.stringify(sealed)}::jsonb) as ok`,
      )
    ).at(0);
    if (row?.ok !== true) throw new Error('MFA is already confirmed for this user');
  }

  async confirm(
    _userId: string,
    step: number,
    recoveryHashes: string[],
    expectedSealed: SealedSecret,
  ): Promise<boolean> {
    const hashes = sql`array[${sql.join(
      recoveryHashes.map((h) => sql`${h}`),
      sql`, `,
    )}]::text[]`;
    const row = (
      await callFunction<{ ok: boolean }>(
        this.db,
        sql`select mfa_confirm(${this.pendingHash}, ${step}, ${hashes}, ${JSON.stringify(expectedSealed)}::jsonb) as ok`,
      )
    ).at(0);
    return row?.ok === true;
  }

  readonly remove: MfaStore['remove'] = () => Promise.reject(unavailable());
}
