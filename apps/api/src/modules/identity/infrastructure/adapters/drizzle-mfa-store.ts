import { and, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { userMfa, type Database } from '@sifen/db';
import type { SealedSecret } from '../../../custody/domain/sealed-secret.js';
import type { MfaRecord, MfaStore } from '../../application/ports/mfa.ports.js';

/**
 * `user_mfa` over the operator/resolver connection (the table has no `app_user` grant). Every state
 * change that races (`confirm`, `advanceStep`, `consumeRecoveryCode`) is a single conditional UPDATE,
 * so two concurrent logins can never both spend the same TOTP step or recovery code.
 */
export class DrizzleMfaStore implements MfaStore {
  constructor(private readonly db: Database) {}

  async find(userId: string): Promise<MfaRecord | null> {
    const rows = await this.db.select().from(userMfa).where(eq(userMfa.userId, userId));
    const row = rows.at(0);
    if (!row) return null;
    return {
      sealed: row.sealed as SealedSecret,
      confirmedAt: row.confirmedAt,
      lastUsedStep: row.lastUsedStep,
      recoveryHashes: row.recoveryHashes,
    };
  }

  async savePending(userId: string, sealed: SealedSecret): Promise<void> {
    const saved = await this.db
      .insert(userMfa)
      .values({ userId, sealed })
      .onConflictDoUpdate({
        target: userMfa.userId,
        set: { sealed },
        setWhere: isNull(userMfa.confirmedAt),
      })
      .returning({ userId: userMfa.userId });
    if (saved.length === 0) {
      throw new Error('MFA is already confirmed for this user');
    }
  }

  async confirm(userId: string, step: number, recoveryHashes: string[]): Promise<boolean> {
    const rows = await this.db
      .update(userMfa)
      .set({ confirmedAt: new Date(), lastUsedStep: step, recoveryHashes })
      .where(and(eq(userMfa.userId, userId), isNull(userMfa.confirmedAt)))
      .returning({ userId: userMfa.userId });
    return rows.length > 0;
  }

  async advanceStep(userId: string, step: number): Promise<boolean> {
    const rows = await this.db
      .update(userMfa)
      .set({ lastUsedStep: step })
      .where(
        and(
          eq(userMfa.userId, userId),
          isNotNull(userMfa.confirmedAt),
          or(isNull(userMfa.lastUsedStep), lt(userMfa.lastUsedStep, step)),
        ),
      )
      .returning({ userId: userMfa.userId });
    return rows.length > 0;
  }

  async consumeRecoveryCode(userId: string, hash: string): Promise<boolean> {
    const rows = await this.db
      .update(userMfa)
      .set({ recoveryHashes: sql`array_remove(${userMfa.recoveryHashes}, ${hash})` })
      .where(and(eq(userMfa.userId, userId), sql`${hash} = ANY(${userMfa.recoveryHashes})`))
      .returning({ userId: userMfa.userId });
    return rows.length > 0;
  }

  async remove(userId: string): Promise<void> {
    await this.db.delete(userMfa).where(eq(userMfa.userId, userId));
  }
}
