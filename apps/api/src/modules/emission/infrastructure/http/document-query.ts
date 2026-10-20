import { HttpException, HttpStatus } from '@nestjs/common';
import { KUDE_FORMATS, parseKudeFormat, type KudeFormat } from '../../domain/kude-model.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CDC = /^[0-9]{44}$/;

function badRequest(message: string): HttpException {
  return new HttpException({ statusCode: HttpStatus.BAD_REQUEST, message }, HttpStatus.BAD_REQUEST);
}

/** @throws HttpException 400 when the path parameter is not a UUID. */
export function parseDocumentId(raw: string): string {
  if (!UUID.test(raw)) throw badRequest('Document id must be a UUID');
  return raw;
}

/** @throws HttpException 400 when `cdc` is missing, repeated or not 44 digits. */
export function parseCdcQuery(raw: unknown): string {
  if (typeof raw !== 'string' || !CDC.test(raw)) {
    throw badRequest('Query parameter cdc is required: 44 digits');
  }
  return raw;
}

/** @throws HttpException 400 when `format` is present but not `letter`, `ticket-80` or `ticket-58`. */
export function parseKudeFormatQuery(raw: unknown): KudeFormat {
  if (raw === undefined) return 'letter';
  const format = parseKudeFormat(raw);
  if (format === undefined) {
    throw badRequest(`Query parameter format must be one of: ${KUDE_FORMATS.join(', ')}`);
  }
  return format;
}
