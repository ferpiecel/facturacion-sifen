import { describe, expect, it } from 'vitest';
import { isRucBlockMessage } from './ruc-block.js';

/** Spec: HU-E6-05. SIFEN's wording for a blocked RUC is unconfirmed, so detection is a tolerant text match. */
describe('isRucBlockMessage', () => {
  it.each([
    'RUC bloqueado',
    'Contribuyente BLOQUEADO',
    'El RUC fue bloqueado temporalmente',
    'Bloqueo por envío de lotes inválidos',
    'RUC se encuentra bloqueada',
  ])('matches %j', (message) => {
    expect(isRucBlockMessage(message)).toBe(true);
  });

  it.each(['', 'Lote sin documentos', 'Lote no encolado para procesamiento', 'Desbloqueado'])(
    'does not match %j',
    (message) => {
      expect(isRucBlockMessage(message)).toBe(false);
    },
  );
});
