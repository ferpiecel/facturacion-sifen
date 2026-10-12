/** SIFEN's `dCodRes`/`dMsgRes` pair stored with a settled document. */
export interface SifenMessage {
  code: string;
  message: string;
}

export interface DocumentEvent {
  status: string;
  at: string;
  code: string | null;
  message: string | null;
}

/** Reads the stored `sifen_messages` JSON defensively: anything that is not a `{code, message}` pair is dropped. */
export function parseSifenMessages(raw: unknown): SifenMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry: unknown) => {
    const { code, message } = (entry ?? {}) as Record<string, unknown>;
    return typeof code === 'string' && typeof message === 'string' ? [{ code, message }] : [];
  });
}

/**
 * There is no status history table yet, so the timeline is what the row proves: it was accepted when created,
 * signed when `signed_at` was set, and is in its current status since the last update (with SIFEN's answer).
 */
export function buildDocumentEvents(input: {
  status: string;
  createdAt: Date;
  signedAt: Date | null;
  updatedAt: Date;
  messages: readonly SifenMessage[];
}): DocumentEvent[] {
  const events: DocumentEvent[] = [
    { status: 'accepted', at: input.createdAt.toISOString(), code: null, message: null },
  ];
  if (input.signedAt) {
    events.push({ status: 'signed', at: input.signedAt.toISOString(), code: null, message: null });
  }
  if (input.status !== 'accepted' && input.status !== 'signed') {
    const first = input.messages.at(0);
    events.push({
      status: input.status,
      at: input.updatedAt.toISOString(),
      code: first?.code ?? null,
      message: first?.message ?? null,
    });
  }
  return events;
}

/** The reason SIFEN gave for refusing the document, in its own words; `null` when it was not rejected. */
export function rejectionReasonOf(
  status: string,
  messages: readonly SifenMessage[],
): string | null {
  if (status !== 'rejected' || messages.length === 0) return null;
  return messages.map((m) => m.message).join('; ');
}
