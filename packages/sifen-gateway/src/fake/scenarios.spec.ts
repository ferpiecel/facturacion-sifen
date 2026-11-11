import { describe, expect, it } from 'vitest';
import { SIFEN_CODES } from '../codes.ts';
import { eventosProcesados } from './scenarios.ts';

describe('eventosProcesados', () => {
  it('uses the first message of the first result as the headline, like parseEventos', () => {
    const result = eventosProcesados([
      { id: '7', dEstRes: 'Rechazado', mensajes: [{ dCodRes: '4009', dMsgRes: 'Extemporaneo' }] },
      { id: '8', dEstRes: 'Aprobado', mensajes: [{ dCodRes: '0600', dMsgRes: 'Registrado' }] },
    ]);

    expect(result.dCodRes).toBe('4009');
    expect(result.dMsgRes).toBe('Extemporaneo');
    expect(result.resultados).toHaveLength(2);
  });

  it('answers 0600 when there is nothing to report, and copies its input', () => {
    const input = [{ id: '1', dEstRes: 'Aprobado', mensajes: [] }];

    const result = eventosProcesados(input);

    expect(result.dCodRes).toBe(SIFEN_CODES.EVENTO_REGISTRADO);
    expect(SIFEN_CODES.EVENTO_REGISTRADO).toBe('0600');
    expect(result.resultados).not.toBe(input);
  });
});
