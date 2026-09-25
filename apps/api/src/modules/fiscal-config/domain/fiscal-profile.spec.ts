import { describe, expect, it } from 'vitest';
import { createFiscalProfile, InvalidFiscalProfileError } from './fiscal-profile.js';
import { createRuc } from './ruc.js';

const RUC = createRuc('4490207', 7);
const ONE_ACTIVITY = [{ code: '47111', description: 'Venta al por menor en comercios' }];

describe('createFiscalProfile', () => {
  it('builds a valid profile, trimming names and the optional regime code', () => {
    const profile = createFiscalProfile({
      ruc: RUC,
      legalName: '  Acme S.A.  ',
      tradeName: '  Acme  ',
      taxpayerType: 'persona_juridica',
      regimeCode: ' 1 ',
      economicActivities: ONE_ACTIVITY,
    });

    expect(profile).toEqual({
      ruc: RUC,
      legalName: 'Acme S.A.',
      tradeName: 'Acme',
      taxpayerType: 'persona_juridica',
      regimeCode: '1',
      economicActivities: ONE_ACTIVITY,
    });
  });

  it('defaults tradeName and regimeCode to null when omitted', () => {
    const profile = createFiscalProfile({
      ruc: RUC,
      legalName: 'Juan Perez',
      taxpayerType: 'persona_fisica',
      economicActivities: ONE_ACTIVITY,
    });

    expect(profile.tradeName).toBeNull();
    expect(profile.regimeCode).toBeNull();
  });

  it('rejects a legal name shorter than 4 characters', () => {
    expect(() =>
      createFiscalProfile({
        ruc: RUC,
        legalName: 'Ab',
        taxpayerType: 'persona_fisica',
        economicActivities: ONE_ACTIVITY,
      }),
    ).toThrow(InvalidFiscalProfileError);
  });

  it('rejects a legal name longer than 255 characters', () => {
    expect(() =>
      createFiscalProfile({
        ruc: RUC,
        legalName: 'a'.repeat(256),
        taxpayerType: 'persona_fisica',
        economicActivities: ONE_ACTIVITY,
      }),
    ).toThrow(InvalidFiscalProfileError);
  });

  it('rejects a regime code that is not 1-2 digits', () => {
    expect(() =>
      createFiscalProfile({
        ruc: RUC,
        legalName: 'Juan Perez',
        taxpayerType: 'persona_fisica',
        regimeCode: 'ABC',
        economicActivities: ONE_ACTIVITY,
      }),
    ).toThrow(InvalidFiscalProfileError);

    expect(() =>
      createFiscalProfile({
        ruc: RUC,
        legalName: 'Juan Perez',
        taxpayerType: 'persona_fisica',
        regimeCode: '123',
        economicActivities: ONE_ACTIVITY,
      }),
    ).toThrow(InvalidFiscalProfileError);
  });

  it('rejects zero economic activities', () => {
    expect(() =>
      createFiscalProfile({
        ruc: RUC,
        legalName: 'Juan Perez',
        taxpayerType: 'persona_fisica',
        economicActivities: [],
      }),
    ).toThrow(InvalidFiscalProfileError);
  });

  it('rejects more than 9 economic activities (gActEco occurrence 1-9)', () => {
    const tooMany = Array.from({ length: 10 }, (_, i) => ({
      code: String(i + 1).padStart(5, '0'),
      description: `Activity ${String(i + 1)}`,
    }));

    expect(() =>
      createFiscalProfile({
        ruc: RUC,
        legalName: 'Juan Perez',
        taxpayerType: 'persona_fisica',
        economicActivities: tooMany,
      }),
    ).toThrow(InvalidFiscalProfileError);
  });

  it('accepts exactly 9 economic activities', () => {
    const nine = Array.from({ length: 9 }, (_, i) => ({
      code: String(i + 1).padStart(5, '0'),
      description: `Activity ${String(i + 1)}`,
    }));

    const profile = createFiscalProfile({
      ruc: RUC,
      legalName: 'Juan Perez',
      taxpayerType: 'persona_fisica',
      economicActivities: nine,
    });

    expect(profile.economicActivities).toHaveLength(9);
  });

  it('rejects an economic activity code that is not 1-8 alphanumeric characters', () => {
    expect(() =>
      createFiscalProfile({
        ruc: RUC,
        legalName: 'Juan Perez',
        taxpayerType: 'persona_fisica',
        economicActivities: [{ code: '123456789', description: 'Too long' }],
      }),
    ).toThrow(InvalidFiscalProfileError);

    expect(() =>
      createFiscalProfile({
        ruc: RUC,
        legalName: 'Juan Perez',
        taxpayerType: 'persona_fisica',
        economicActivities: [{ code: '47-11', description: 'Invalid char' }],
      }),
    ).toThrow(InvalidFiscalProfileError);
  });

  it('rejects an empty economic activity description', () => {
    expect(() =>
      createFiscalProfile({
        ruc: RUC,
        legalName: 'Juan Perez',
        taxpayerType: 'persona_fisica',
        economicActivities: [{ code: '47111', description: '  ' }],
      }),
    ).toThrow(InvalidFiscalProfileError);
  });
});
