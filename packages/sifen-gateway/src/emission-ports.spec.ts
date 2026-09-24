import { describe, expectTypeOf, it } from 'vitest';
import type {
  Ambiente,
  DeXmlBuilder,
  FacturaPocInput,
  LoadedCertificate,
  QrConfig,
  QrGenerator,
  XmlSigner,
} from './emission-ports.ts';

describe('emission ports type contract', () => {
  it('Ambiente is the SIFEN environment union', () => {
    expectTypeOf<Ambiente>().toEqualTypeOf<'test' | 'prod'>();
  });

  it('LoadedCertificate carries a PKCS#12 buffer and its password', () => {
    expectTypeOf<LoadedCertificate>().toEqualTypeOf<{
      readonly p12: Uint8Array;
      readonly password: string;
    }>();
  });

  it('QrConfig carries the CSC identity and target environment', () => {
    expectTypeOf<QrConfig>().toEqualTypeOf<{
      readonly idCsc: string;
      readonly csc: string;
      readonly ambiente: Ambiente;
    }>();
  });

  it('FacturaPocInput is a domain-free params/data envelope', () => {
    expectTypeOf<FacturaPocInput>().toEqualTypeOf<{
      readonly params: Readonly<Record<string, unknown>>;
      readonly data: Readonly<Record<string, unknown>>;
    }>();
  });

  it('DeXmlBuilder.buildParaSifen takes a FacturaPocInput and returns XML', () => {
    expectTypeOf<DeXmlBuilder['buildParaSifen']>().toEqualTypeOf<
      (input: FacturaPocInput) => Promise<string>
    >();
  });

  it('XmlSigner.sign takes XML and a LoadedCertificate and returns signed XML', () => {
    expectTypeOf<XmlSigner['sign']>().toEqualTypeOf<
      (xml: string, cert: LoadedCertificate) => Promise<string>
    >();
  });

  it('QrGenerator.addQr takes signed XML and QrConfig and returns XML with the QR', () => {
    expectTypeOf<QrGenerator['addQr']>().toEqualTypeOf<
      (signedXml: string, config: QrConfig) => Promise<string>
    >();
  });
});
