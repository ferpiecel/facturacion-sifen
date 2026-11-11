import { HttpException, HttpStatus } from '@nestjs/common';

/** Stable machine codes of `/v1/received-documents` errors (body `code`). */
export type ReceptionUploadErrorCode =
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'unsupported_source'
  | 'extraction_failed'
  | 'empty_upload'
  | 'invalid_request'
  | 'storage_unavailable'
  | 'service_unavailable'
  | 'not_found'
  | 'version_conflict'
  | 'invalid_state'
  | 'validation_failed'
  | 'invalid_correction';

/** The API's `{ statusCode, message }` envelope plus a stable `code` (and optional extras). */
export function receptionProblem(
  status: HttpStatus,
  code: ReceptionUploadErrorCode,
  message: string,
  extra: object = {},
): HttpException {
  return new HttpException({ statusCode: status, code, message, ...extra }, status);
}
