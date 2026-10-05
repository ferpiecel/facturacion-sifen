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

/** siRecepDE (§9.1, schemas 3-4), modelled on the MT §7.4 response example. */
export const deAutorizadoXml = envelope(
  `<ns2:rRetEnviDe xmlns:ns2="${NS}"><ns2:rProtDe><ns2:id>${CDC_A}</ns2:id>` +
    '<ns2:dFecProc>2026-10-02T12:00:00</ns2:dFecProc><ns2:dDigVal>abc=</ns2:dDigVal><ns2:gResProc>' +
    '<ns2:dEstRes>Aprobado</ns2:dEstRes><ns2:dProtAut>1234567890</ns2:dProtAut>' +
    '<ns2:dCodRes>0260</ns2:dCodRes><ns2:dMsgRes>Autorización del DE satisfactoria</ns2:dMsgRes>' +
    '</ns2:gResProc></ns2:rProtDe></ns2:rRetEnviDe>',
);

export const deRechazadoXml = envelope(
  `<rRetEnviDe xmlns="${NS}"><rProtDe><dEstRes>Rechazado</dEstRes><gResProc>` +
    '<dCodRes>0160</dCodRes><dMsgRes>XML malformado</dMsgRes></gResProc></rProtDe></rRetEnviDe>',
);

/** siConsDE (§9.4, schemas 10-11). */
export const DE_XML = `<rDE xmlns="${NS}"><DE Id="${CDC_A}">uno</DE></rDE>`;
export const consDEEncontradoXml = envelope(
  `<rResEnviConsDe xmlns="${NS}"><dFecProc>2026-10-02T12:00:00</dFecProc><dCodRes>0422</dCodRes>` +
    `<dMsgRes>CDC encontrado</dMsgRes><xContenDE><rContDe>${DE_XML}<dProtAut>1234567890</dProtAut></rContDe></xContenDE></rResEnviConsDe>`,
);
export const consDEInexistenteXml = envelope(
  `<rResEnviConsDe xmlns="${NS}"><dFecProc>2026-10-02T12:00:00</dFecProc><dCodRes>0420</dCodRes>` +
    '<dMsgRes>CDC inexistente</dMsgRes></rResEnviConsDe>',
);

/** siConsRUC (§9.6, schemas 16-17). */
export const consRUCEncontradoXml = envelope(
  `<rResEnviConsRUC xmlns="${NS}"><dCodRes>0502</dCodRes><dMsgRes>RUC encontrado</dMsgRes>` +
    '<xContRUC><rContRUC><dRUCCons>80069563</dRUCCons><dRazCons>Empresa SA</dRazCons>' +
    '<dCodEstCons>ACT</dCodEstCons><dDesEstCons>Activo</dDesEstCons><dRUCFactElec>S</dRUCFactElec>' +
    '</rContRUC></xContRUC></rResEnviConsRUC>',
);
export const consRUCInexistenteXml = envelope(
  `<rResEnviConsRUC xmlns="${NS}"><dCodRes>0500</dCodRes><dMsgRes>RUC inexistente</dMsgRes></rResEnviConsRUC>`,
);

/** siRecepEvento (§9.5, schema 14). */
export const eventosXml = envelope(
  `<ns2:rRetEnviEventoDe xmlns:ns2="${NS}"><ns2:dFecProc>2026-10-02T12:00:00</ns2:dFecProc>` +
    '<ns2:gResProcEVe><ns2:dEstRes>Aprobado</ns2:dEstRes><ns2:dProtAut>1111111111</ns2:dProtAut>' +
    '<ns2:id>77</ns2:id><ns2:gResProc><ns2:dCodRes>0600</ns2:dCodRes><ns2:dMsgRes>Evento registrado correctamente</ns2:dMsgRes></ns2:gResProc></ns2:gResProcEVe>' +
    '<ns2:gResProcEVe><ns2:dEstRes>Rechazado</ns2:dEstRes><ns2:id>78</ns2:id><ns2:gResProc>' +
    '<ns2:dCodRes>4003</ns2:dCodRes><ns2:dMsgRes>El DE ya fue cancelado</ns2:dMsgRes></ns2:gResProc></ns2:gResProcEVe>' +
    '</ns2:rRetEnviEventoDe>',
);
