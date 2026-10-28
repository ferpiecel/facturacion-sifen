import { and, eq } from 'drizzle-orm';
import { issuerEvents, type TenantTx } from '@sifen/db';
import { readNominatedReceiver } from '../domain/nominated-receiver.js';

/** The receiver named by the FE's approved nomination event, if any (one open nomination per FE, 4453). */
export async function approvedNomination(tx: TenantTx, tenantId: string, documentId: string) {
  const [row] = await tx
    .select({ nomination: issuerEvents.nomination })
    .from(issuerEvents)
    .where(
      and(
        eq(issuerEvents.tenantId, tenantId),
        eq(issuerEvents.documentId, documentId),
        eq(issuerEvents.kind, 'nomination'),
        eq(issuerEvents.status, 'approved'),
      ),
    );
  return row ? readNominatedReceiver(row.nomination) : null;
}
