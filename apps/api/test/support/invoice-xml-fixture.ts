import { createEstablishment } from '../../src/modules/fiscal-config/domain/establishment.js';
import { createExpeditionPoint } from '../../src/modules/fiscal-config/domain/expedition-point.js';
import { createFiscalProfile } from '../../src/modules/fiscal-config/domain/fiscal-profile.js';
import { parseRuc } from '../../src/modules/fiscal-config/domain/ruc.js';
import { createTimbrado } from '../../src/modules/fiscal-config/domain/timbrado.js';
import type { InvoiceXmlContext } from '../../src/modules/emission/application/invoice-xml.js';

const ruc = parseRuc('80000001-3');

/** Fixed fiscal context for XML golden tests (same data as invoice-xml.spec.ts). */
export function context(environment: 'test' | 'production'): InvoiceXmlContext {
  return {
    environment,
    issuer: createFiscalProfile({
      ruc,
      legalName: 'Empresa Real SA',
      tradeName: 'Empresa Real',
      taxpayerType: 'persona_juridica',
      regimeCode: '8',
      economicActivities: [{ code: '1254', description: 'Desarrollo de Software' }],
    }),
    establishment: createEstablishment({
      code: '001',
      address: 'Calle Falsa',
      houseNumber: '123',
      departmentCode: 11,
      districtCode: '145',
      districtDescription: 'CIUDAD DEL ESTE',
      cityCode: '3432',
      cityDescription: 'PUERTO PTE.STROESSNER (MUNIC)',
    }),
    establishmentContact: { phone: '0973-000000', email: 'emisor@test.com', name: 'Casa Matriz' },
    point: createExpeditionPoint({ code: '001' }),
    timbrado: createTimbrado({ number: '12345678', validityStart: '2024-01-01' }),
    numbering: { documentNumber: '0000001', securityCode: '298398000' },
    issuedAt: new Date('2026-09-30T13:00:00Z'),
    receiver: {
      ruc: '80000002-7',
      name: 'Receptor Prueba SA',
      address: 'Avda Prueba',
      houseNumber: '100',
      districtCode: 143,
      districtDescription: 'DOMINGO MARTINEZ DE IRALA',
      cityCode: 3344,
      cityDescription: 'PASO ITA (INDIGENA)',
    },
    lines: [
      { code: 'A-001', description: 'Servicio real uno', unitCode: 77 },
      { code: 'A-002', description: 'Servicio real dos', unitCode: 77 },
    ],
  };
}
