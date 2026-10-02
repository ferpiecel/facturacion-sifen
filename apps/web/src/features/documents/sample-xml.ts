import { formatXmlDateTime } from './format';
import { SAMPLE_ISSUER, type DocumentRow } from './sample-documents';

const TYPE_NAMES: Record<string, string> = {
  '01': 'Factura electrónica',
  '04': 'Autofactura electrónica',
  '05': 'Nota de crédito electrónica',
  '06': 'Nota de débito electrónica',
};

/** Abridged rDE for the preview; the real signed XML comes from the API. */
export function buildSampleXml(doc: DocumentRow): string {
  const { cdc, receiver } = doc;
  const [issuerBase = '', issuerDv = ''] = SAMPLE_ISSUER.ruc.split('-');
  const [number = '', point = '', est = ''] = doc.number.split('-').reverse();
  const [recBase = '', recDv = ''] = receiver.id.split('-');
  const type = cdc.slice(0, 2);
  const party =
    receiver.kind === 'ruc'
      ? `<dRucRec>${recBase}</dRucRec>\n        <dDVRec>${recDv}</dDVRec>`
      : `<dNumIDRec>${receiver.id.replaceAll('.', '')}</dNumIDRec>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<rDE xmlns="http://ekuatia.set.gov.py/sifen/xsd">
  <dVerFor>150</dVerFor>
  <DE Id="${cdc}">
    <dDVId>${cdc.slice(43)}</dDVId>
    <dSisFact>1</dSisFact>
    <gOpeDE>
      <iTipEmi>1</iTipEmi>
      <dCodSeg>${cdc.slice(34, 43)}</dCodSeg>
    </gOpeDE>
    <gTimb>
      <iTiDE>${String(Number(type))}</iTiDE>
      <dDesTiDE>${TYPE_NAMES[type] ?? ''}</dDesTiDE>
      <dNumTim>${doc.timbrado}</dNumTim>
      <dEst>${est}</dEst>
      <dPunExp>${point}</dPunExp>
      <dNumDoc>${number}</dNumDoc>
    </gTimb>
    <gDatGralOpe>
      <dFeEmiDE>${formatXmlDateTime(doc.issuedAt)}</dFeEmiDE>
      <gEmis>
        <dRucEm>${issuerBase}</dRucEm>
        <dDVEmi>${issuerDv}</dDVEmi>
        <dNomEmi>${SAMPLE_ISSUER.name}</dNomEmi>
      </gEmis>
      <gDatRec>
        ${party}
        <dNomRec>${receiver.name}</dNomRec>
      </gDatRec>
    </gDatGralOpe>
    <Signature xmlns="http://www.w3.org/2000/09/xmldsig#">
      <SignedInfo>
        <CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/>
        <SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/>
        <Reference URI="#${cdc}">
          <DigestValue>...</DigestValue>
        </Reference>
      </SignedInfo>
      <SignatureValue>...</SignatureValue>
    </Signature>
  </DE>
</rDE>`;
}
