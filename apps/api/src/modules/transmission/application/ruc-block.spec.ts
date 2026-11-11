import { describe, expect, it } from 'vitest';
import { isRucBlockMessage } from './ruc-block.js';

/**
 * Spec: HU-E6-05. The Guía 2024 rejects a lote for "Estar bloqueado por envío duplicado" and blocks
 * the "RUC Emisor"; the exact dMsgRes is unconfirmed, so a block needs "bloque..." and the RUC, issuer or duplicate send.
 */
describe('isRucBlockMessage', () => {
  it.each([
    'RUC bloqueado',
    'Contribuyente BLOQUEADO',
    'El RUC fue bloqueado temporalmente',
    'Bloqueo del RUC emisor por envío de lotes inválidos',
    'Estar bloqueado por envío duplicado',
    'RUC se encuentra bloqueada',
  ])('matches %j', (message) => {
    expect(isRucBlockMessage(message)).toBe(true);
  });

  it.each([
    '',
    'Lote sin documentos',
    'Lote no encolado para procesamiento',
    'Desbloqueado',
    'RUC desbloqueado',
    'Lote bloqueado en la cola de procesamiento',
    'Error en el bloque de datos del RUC emisor',
  ])('does not match %j', (message) => {
    expect(isRucBlockMessage(message)).toBe(false);
  });
});
