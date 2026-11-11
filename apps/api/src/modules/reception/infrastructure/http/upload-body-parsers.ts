import multipart from '@fastify/multipart';
import { HttpStatus } from '@nestjs/common';
import type { FastifyAdapter } from '@nestjs/platform-fastify';
import { receptionProblem } from './reception-http-errors.js';
import type { ReceptionUploadConfig } from './reception-upload-config.js';

/** Raw upload media types; the handler still sniffs the bytes (a PDF may arrive as octet-stream). */
const RAW_UPLOAD_TYPES = [
  'application/xml',
  'text/xml',
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/octet-stream',
];

/**
 * Teaches the HTTP adapter the upload encodings of `POST /v1/received-documents`: raw bodies as
 * Buffers (own limit, above the global 1 MiB JSON cap) and `multipart/form-data` with a single
 * file capped at the same size. Every other route keeps Fastify's default behaviour.
 */
export function registerReceptionUploadParsers(
  adapter: FastifyAdapter,
  config: ReceptionUploadConfig,
): void {
  const tooLarge = () =>
    receptionProblem(
      HttpStatus.PAYLOAD_TOO_LARGE,
      'payload_too_large',
      'The upload exceeds the maximum allowed size',
    );
  adapter.getInstance().addContentTypeParser(RAW_UPLOAD_TYPES, (request, payload, done) => {
    // Own parser (not `parseAs`) so an oversized body answers with the reception error code.
    if (Number(request.headers['content-length'] ?? 0) > config.maxBytes) {
      done(tooLarge(), undefined);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    payload.on('data', (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > config.maxBytes) {
        rejected = true;
        done(tooLarge(), undefined);
        return;
      }
      chunks.push(chunk);
    });
    payload.on('end', () => {
      if (!rejected) done(null, Buffer.concat(chunks));
    });
    payload.on('error', (error: Error) => {
      if (rejected) return;
      rejected = true;
      done(error, undefined);
    });
  });
  // The plugin's types target the default Fastify server; the adapter's are the generic ones.
  void adapter.register(multipart as never, {
    limits: { fileSize: config.maxBytes, files: 1, fields: 4, parts: 5 },
  });
}
