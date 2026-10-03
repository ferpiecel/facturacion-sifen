/** Handcrafted SOAP 1.2 responses modelled on Manual Técnico v150 §9.2-9.3 (schemas 6 and 8). */
const NS = 'http://ekuatia.set.gov.py/sifen/xsd';
export const CDC_A = '01800695631001001000000612021112917595714694';
export const CDC_B = '01800695631001001000000722021112917595714695';

export const envelope = (body: string, prefix = 'env'): string =>
  `<?xml version="1.0" encoding="UTF-8"?><${prefix}:Envelope xmlns:${prefix}="http://www.w3.org/2003/05/soap-envelope">` +
  `<${prefix}:Header/><${prefix}:Body>${body}</${prefix}:Body></${prefix}:Envelope>`;

export const loteRecibidoXml = envelope(
  `<ns2:rResEnviLoteDe xmlns:ns2="${NS}"><ns2:dFecProc>2026-10-02T10:00:00-03:00</ns2:dFecProc>` +
    '<ns2:dCodRes>0300</ns2:dCodRes><ns2:dMsgRes>Lote recibido con éxito</ns2:dMsgRes>' +
    '<ns2:dProtConsLote>47353</ns2:dProtConsLote><ns2:dTpoProces>15</ns2:dTpoProces></ns2:rResEnviLoteDe>',
);

export const loteNoEncoladoXml = envelope(
  `<rResEnviLoteDe xmlns="${NS}"><dCodRes>0301</dCodRes><dMsgRes>Lote no encolado &amp; rechazado</dMsgRes>` +
    '<dTpoProces>0</dTpoProces></rResEnviLoteDe>',
  'soap',
);

const proc = (
  cdc: string,
  estado: string,
  protocolo: string | null,
  msgs: [string, string][],
): string =>
  `<ns2:gResProcLote><ns2:id>${cdc}</ns2:id><ns2:dEstRes>${estado}</ns2:dEstRes>` +
  (protocolo === null ? '' : `<ns2:dProtAut>${protocolo}</ns2:dProtAut>`) +
  msgs
    .map(
      ([c, m]) =>
        `<ns2:gResProc><ns2:dCodRes>${c}</ns2:dCodRes><ns2:dMsgRes>${m}</ns2:dMsgRes></ns2:gResProc>`,
    )
    .join('') +
  '</ns2:gResProcLote>';

export const loteConcluidoXml = envelope(
  `<ns2:rResEnviConsLoteDe xmlns:ns2="${NS}"><ns2:dFecProc>2026-10-02T10:01:00-03:00</ns2:dFecProc>` +
    '<ns2:dCodResLot>0362</ns2:dCodResLot><ns2:dMsgResLot>Procesamiento de lote concluido</ns2:dMsgResLot>' +
    proc(CDC_A, 'Aprobado', '1234567890', [['0260', 'Autorización del DE satisfactoria']]) +
    proc(CDC_B, 'Rechazado', null, [['1000', 'CDC no corresponde con las informaciones del XML']]) +
    '</ns2:rResEnviConsLoteDe>',
);

export const loteEnProcesamientoXml = envelope(
  `<rResEnviConsLoteDe xmlns="${NS}"><dFecProc></dFecProc><dCodResLot>0361</dCodResLot>` +
    '<dMsgResLot>Lote en procesamiento</dMsgResLot></rResEnviConsLoteDe>',
);

export const fault12Xml = envelope(
  '<env:Fault><env:Code><env:Value>env:Receiver</env:Value></env:Code>' +
    '<env:Reason><env:Text xml:lang="en">Internal error</env:Text></env:Reason></env:Fault>',
);

export const fault11Xml =
  '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault>' +
  '<faultcode>s:Client</faultcode><faultstring>Bad request</faultstring></s:Fault></s:Body></s:Envelope>';
