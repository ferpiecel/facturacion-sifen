import { FakeSifenGateway, SifenTimeoutError, sifenScenarios } from '@sifen/sifen-gateway';
import { describe, expect, it } from 'vitest';
import type { ReadyDocument } from './assemble-lotes.js';
import { ResendPreflight, type ResendPreflightStore } from './resend-preflight.js';

const CDC = '01444444017001001000000122026092211234567890'.slice(0, 44);
const document: ReadyDocument = { documentId: 'doc-1', cdc: CDC, xml: '<rDE/>', resent: true };
const found = (cdc: string) =>
  sifenScenarios.cdcEncontrado(`<rDE><DE Id="${cdc}"><dCdCDERef>${CDC}</dCdCDERef></DE></rDE>`);

function setup(approves = true) {
  const gateway = new FakeSifenGateway();
  const approved: { documentId: string; message: string }[] = [];
  const store: ResendPreflightStore = {
    approveFound: (documentId, resolution) => {
      approved.push({ documentId, message: resolution.messages[0]?.message ?? '' });
      return Promise.resolve(approves);
    },
  };
  let dId = 40n;
  const preflight = new ResendPreflight({
    gateway,
    store,
    nextRequestId: () => Promise.resolve((dId += 1n)),
  });
  return { gateway, approved, preflight };
}

/** The last look before a resend: SIFEN must still say it does not hold the DE. */
describe('ResendPreflight', () => {
  it('clears the send only when SIFEN still answers 0420, asking for that CDC', async () => {
    const { preflight, gateway, approved } = setup();
    gateway.enqueue('consultarDE', sifenScenarios.cdcInexistente());
    expect(await preflight.verify(document)).toBe('send');
    expect(gateway.callsTo('consultarDE')).toEqual([[{ dId: 41n, cdc: CDC }]]);
    expect(approved).toEqual([]);
  });

  it('approves the document and never sends it when SIFEN now holds it (0422 race)', async () => {
    const { preflight, gateway, approved } = setup();
    gateway.enqueue('consultarDE', found(CDC));
    expect(await preflight.verify(document)).toBe('approved');
    expect(approved).toEqual([{ documentId: 'doc-1', message: 'CDC encontrado' }]);
    expect(gateway.callsTo('enviarLote')).toHaveLength(0);
  });

  it('does not send when the approval could not be stored: SIFEN has the DE', async () => {
    const { preflight, gateway } = setup(false);
    gateway.enqueue('consultarDE', found(CDC));
    expect(await preflight.verify(document)).toBe('wait');
  });

  it('waits on a 0422 whose DE is another document: a reference is not the document', async () => {
    const { preflight, gateway, approved } = setup();
    gateway.enqueue('consultarDE', found('9'.repeat(44)));
    expect(await preflight.verify(document)).toBe('wait');
    expect(approved).toEqual([]);
  });

  it.each([
    ['an unexpected code', sifenScenarios.rucCertificadoSinPermiso()],
    ['a timeout', new SifenTimeoutError('consultarDE')],
    ['a plain error', new Error('socket hang up')],
  ])('waits on %s: not knowing is never permission to send', async (_label, answer) => {
    const { preflight, gateway } = setup();
    gateway.enqueue('consultarDE', answer);
    expect(await preflight.verify(document)).toBe('wait');
  });
});
