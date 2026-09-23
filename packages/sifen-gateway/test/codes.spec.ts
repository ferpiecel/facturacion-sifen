import { describe, expect, it } from 'vitest';
import { SIFEN_CODES } from '../src/codes.ts';

describe('SIFEN_CODES', () => {
  it('exposes exactly the verified codes', () => {
    expect(SIFEN_CODES).toStrictEqual({
      LOTE_RECIBIDO: '0300',
      LOTE_NO_ENCOLADO: '0301',
      LOTE_EN_PROCESAMIENTO: '0361',
      LOTE_CONCLUIDO: '0362',
      LOTE_INEXISTENTE: '0360',
      CONSULTA_EXTEMPORANEA: '0364',
      DE_AUTORIZADO: '0260',
      CDC_ENCONTRADO: '0422',
      CDC_INEXISTENTE: '0420',
      RUC_CERTIFICADO_SIN_PERMISO: '0421',
      XML_MALFORMADO: '0160',
    });
  });
});
