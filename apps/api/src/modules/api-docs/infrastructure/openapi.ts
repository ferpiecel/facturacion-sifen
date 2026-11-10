import { z } from 'zod';
import { DOCUMENT_STATUSES } from '@sifen/db';
import { RECEIVED_DOCUMENT_STATUSES } from '../../reception/domain/received-document-status.js';
import { RECEIVED_DOCUMENT_SOURCES } from '../../reception/domain/source.js';
import { createDocumentSchema } from '../../emission/infrastructure/http/create-document.request.js';
import { WEBHOOK_EVENT_TYPES } from '../../webhooks/domain/webhook-event.js';

/**
 * OpenAPI 3.1 description of the integrator API (the routes behind the API key guard).
 *
 * Hand-typed on purpose: `@nestjs/swagger` would put decorators on every controller, while here
 * the request body is derived from the Zod schema the controller validates with, and
 * `openapi.spec.ts` fails when a route, its scopes or the checked-in `docs/api/openapi.json`
 * drift. The portal's `/auth` routes and `/health` are not integrator API and stay out.
 */

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const problem = (description: string, schema = 'Problem') => ({
  description,
  content: { 'application/json': { schema: ref(schema) } },
});
const json = (description: string, schema: object) => ({
  description,
  content: { 'application/json': { schema } },
});

const UNAUTHORIZED = problem('Missing, malformed or revoked API key');
const FORBIDDEN = problem('The API key lacks the required scope');
const NOT_FOUND = problem('Not found (also returned for another tenant`s resource)');

const idParam = (what: string) => ({
  name: 'id',
  in: 'path',
  required: true,
  description: `${what} id (UUID)`,
  schema: { type: 'string', format: 'uuid' },
});

const secured = (scopes: string[]) => ({
  security: [{ apiKey: [] }],
  'x-required-scopes': scopes,
});

const dateTime = { type: 'string', format: 'date-time' };
const nullableDateTime = { type: ['string', 'null'], format: 'date-time' };
const decimalString = { type: ['string', 'null'], examples: ['10000.5'] };

export function buildOpenApiDocument() {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Facturacion SIFEN API',
      version: '1.0.0',
      description:
        'Electronic invoicing for Paraguay (SIFEN). Authenticate with an API key: `Authorization: Bearer sk_live_...`. ' +
        'Errors use `{ statusCode, message, errors? }`. Webhook payloads and signatures are described in docs/integracion/webhooks.md. ' +
        'Project documentation (PRD, ADRs, plan, operations) is browsable in the [guides](/docs/guides).',
    },
    paths: {
      '/v1/documents': {
        post: {
          operationId: 'createDocument',
          tags: ['Documents'],
          summary: 'Accept an invoice (FE) for emission',
          description:
            'Returns 202 once the document is persisted with its CDC; signing and transmission to SIFEN are asynchronous. ' +
            'Retrying with the same `Idempotency-Key` and body returns the same response; the same key with another body is a 409.',
          ...secured(['documents:write']),
          parameters: [
            {
              name: 'Idempotency-Key',
              in: 'header',
              required: true,
              description: '1 to 255 printable ASCII characters, no spaces',
              schema: { type: 'string', pattern: '^[!-~]{1,255}$' },
            },
          ],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: ref('CreateDocumentRequest') } },
          },
          responses: {
            '202': json('Accepted', ref('DocumentAccepted')),
            '400': problem('Missing or malformed Idempotency-Key'),
            '401': UNAUTHORIZED,
            '403': FORBIDDEN,
            '409': problem('Idempotency-Key reused with another body, or numbering exhausted'),
            '422': problem('Validation failed (shape or fiscal rules)', 'ValidationProblem'),
            '503': problem('Transient numbering collision; retry the request'),
          },
        },
        get: {
          operationId: 'getDocumentByCdc',
          tags: ['Documents'],
          summary: 'Look a document up by CDC',
          ...secured(['documents:read']),
          parameters: [
            {
              name: 'cdc',
              in: 'query',
              required: true,
              description: 'CDC, 44 digits',
              schema: { type: 'string', pattern: '^[0-9]{44}$' },
            },
          ],
          responses: {
            '200': json('The document', ref('Document')),
            '400': problem('cdc missing or not 44 digits'),
            '401': UNAUTHORIZED,
            '403': FORBIDDEN,
            '404': NOT_FOUND,
          },
        },
      },
      '/v1/documents/{id}': {
        get: {
          operationId: 'getDocument',
          tags: ['Documents'],
          summary: 'Get a document by id',
          ...secured(['documents:read']),
          parameters: [idParam('Document')],
          responses: {
            '200': json('The document', ref('Document')),
            '400': problem('id is not a UUID'),
            '401': UNAUTHORIZED,
            '403': FORBIDDEN,
            '404': NOT_FOUND,
          },
        },
      },
      '/v1/documents/{id}/kude': {
        get: {
          operationId: 'downloadKude',
          tags: ['Documents'],
          summary: 'Download the KuDE (PDF), available once the document is signed',
          ...secured(['documents:read']),
          parameters: [idParam('Document')],
          responses: {
            '200': {
              description: 'The KuDE',
              content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } },
            },
            '400': problem('id is not a UUID'),
            '401': UNAUTHORIZED,
            '403': FORBIDDEN,
            '404': NOT_FOUND,
            '409': problem('The document is not signed yet'),
            '500': problem('The KuDE could not be generated'),
          },
        },
      },
      '/v1/received-documents': {
        post: {
          operationId: 'uploadReceivedDocument',
          tags: ['Reception'],
          summary: 'Upload a received SIFEN XML',
          description:
            'Stores the XML and extracts it; the processing contract is asynchronous (202), although a SIFEN XML is read before the answer. ' +
            'The status in the body is `confirmed` when the document passes validation and is addressed to the tenant, `needs_review` otherwise. ' +
            'Send the XML as a raw `application/xml` or `text/xml` body, as a `multipart/form-data` upload with one `file` part, or as JSON `{ "xml": "<...>" }` (JSON is limited to 1 MiB). ' +
            'Content is recognized by its first bytes, not by the declared type. ' +
            'The same bytes, or the same CDC, uploaded again answer 200 with the existing document. ' +
            'PDF, photo and CDC-only requests answer 422 `unsupported_source` for now. ' +
            'The maximum upload size is `RECEPTION_MAX_UPLOAD_BYTES` (default 2 MiB). ' +
            'Errors carry a stable `code`.',
          ...secured(['reception:write']),
          requestBody: {
            required: true,
            content: {
              'application/xml': { schema: { type: 'string' } },
              'text/xml': { schema: { type: 'string' } },
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  required: ['file'],
                  properties: { file: { type: 'string', format: 'binary' } },
                },
              },
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['xml'],
                  properties: { xml: { type: 'string' } },
                },
              },
            },
          },
          responses: {
            '200': {
              ...json('Already received; the existing document', ref('ReceivedDocumentAck')),
              headers: { Location: { schema: { type: 'string' } } },
            },
            '202': {
              ...json('Accepted', ref('ReceivedDocumentAck')),
              headers: { Location: { schema: { type: 'string' } } },
            },
            '401': UNAUTHORIZED,
            '403': FORBIDDEN,
            '413': problem(
              'The upload exceeds the maximum size (`payload_too_large`)',
              'ReceptionProblem',
            ),
            '415': problem(
              'The bytes do not look like XML (`unsupported_media_type`)',
              'ReceptionProblem',
            ),
            '422': problem(
              '`unsupported_source` (PDF, photo, CDC only), `extraction_failed` (stored but unreadable; carries `document_id`), `empty_upload` or `invalid_request`',
              'ReceptionProblem',
            ),
            '503': problem(
              'Document storage is not available (`storage_unavailable`)',
              'ReceptionProblem',
            ),
          },
        },
        get: {
          operationId: 'listReceivedDocuments',
          tags: ['Reception'],
          summary: 'List received documents, newest first, cursor paginated',
          description:
            'Ordered by creation time, newest first. Pass the `next_cursor` of a page as `cursor` to get the next one; it is null on the last page. ' +
            '`issued_from` and `issued_to` are inclusive calendar days; `updated_since` is an inclusive ISO 8601 timestamp for incremental sync.',
          ...secured(['reception:read']),
          parameters: [
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
            },
            {
              name: 'cursor',
              in: 'query',
              description: 'The `next_cursor` of the previous page',
              schema: { type: 'string' },
            },
            {
              name: 'status',
              in: 'query',
              schema: { type: 'string', enum: RECEIVED_DOCUMENT_STATUSES },
            },
            {
              name: 'source',
              in: 'query',
              schema: { type: 'string', enum: RECEIVED_DOCUMENT_SOURCES },
            },
            {
              name: 'issuer_ruc',
              in: 'query',
              description:
                'Issuer RUC, with or without the check digit (`80000001` or `80000001-8`)',
              schema: { type: 'string', pattern: '^[0-9]{5,8}(-[0-9])?$' },
            },
            { name: 'issued_from', in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'issued_to', in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'is_own_receiver', in: 'query', schema: { type: 'boolean' } },
            {
              name: 'cdc_prefix',
              in: 'query',
              description: 'Leading digits of the CDC',
              schema: { type: 'string', pattern: '^[0-9]{1,44}$' },
            },
            { name: 'updated_since', in: 'query', schema: { type: 'string', format: 'date-time' } },
          ],
          responses: {
            '200': json('A page of received documents', ref('ReceivedDocumentPage')),
            '400': problem('A parameter is malformed (`invalid_request`)', 'ReceptionProblem'),
            '401': UNAUTHORIZED,
            '403': FORBIDDEN,
          },
        },
      },
      '/v1/received-documents/{id}': {
        get: {
          operationId: 'getReceivedDocument',
          tags: ['Reception'],
          summary: 'Get a received document with its items and per-field confidences',
          description:
            'Everything an ERP needs to render its own review: extracted fields, items, per-field confidences, `needs_review_reasons` and the artifact link. ' +
            'Field names are provisional until the correction endpoint (PATCH) ships. Money is a decimal string.',
          ...secured(['reception:read']),
          parameters: [idParam('Received document')],
          responses: {
            '200': json('The document', ref('ReceivedDocumentDetail')),
            '400': problem('id is not a UUID (`invalid_request`)', 'ReceptionProblem'),
            '401': UNAUTHORIZED,
            '403': FORBIDDEN,
            '404': problem(
              'Not found, also for another tenant`s document (`not_found`)',
              'ReceptionProblem',
            ),
          },
        },
      },
      '/v1/received-documents/{id}/artifact': {
        get: {
          operationId: 'downloadReceivedArtifact',
          tags: ['Reception'],
          summary: 'Download the stored upload, byte for byte',
          description:
            'Served with the content type recorded at upload and `Content-Disposition: inline`.',
          ...secured(['reception:read']),
          parameters: [idParam('Received document')],
          responses: {
            '200': {
              description: 'The stored bytes',
              content: { '*/*': { schema: { type: 'string', format: 'binary' } } },
            },
            '400': problem('id is not a UUID (`invalid_request`)', 'ReceptionProblem'),
            '401': UNAUTHORIZED,
            '403': FORBIDDEN,
            '404': problem(
              'No such document, or it has no stored artifact (`not_found`)',
              'ReceptionProblem',
            ),
            '503': problem(
              'Document storage is not available (`storage_unavailable`)',
              'ReceptionProblem',
            ),
          },
        },
      },
      '/v1/received-documents/{id}/artifact-url': {
        get: {
          operationId: 'getReceivedArtifactUrl',
          tags: ['Reception'],
          summary: 'A time-limited direct download URL for the stored upload',
          ...secured(['reception:read']),
          parameters: [idParam('Received document')],
          responses: {
            '200': json('The URL', ref('ReceivedArtifactUrl')),
            '400': problem('id is not a UUID (`invalid_request`)', 'ReceptionProblem'),
            '401': UNAUTHORIZED,
            '403': FORBIDDEN,
            '404': problem(
              'No such document, or it has no stored artifact (`not_found`)',
              'ReceptionProblem',
            ),
            '503': problem(
              'Document storage is not available (`storage_unavailable`)',
              'ReceptionProblem',
            ),
          },
        },
      },
      '/v1/webhooks/endpoints': {
        post: {
          operationId: 'createWebhookEndpoint',
          tags: ['Webhooks'],
          summary: 'Register a webhook endpoint; the secret is shown only here and on rotation',
          ...secured(['webhooks:write']),
          requestBody: {
            required: true,
            content: { 'application/json': { schema: ref('WebhookEndpointCreate') } },
          },
          responses: {
            '201': json('Created', ref('WebhookEndpointWithSecret')),
            '401': UNAUTHORIZED,
            '403': FORBIDDEN,
            '422': problem('Validation failed', 'ValidationProblem'),
          },
        },
        get: {
          operationId: 'listWebhookEndpoints',
          tags: ['Webhooks'],
          summary: 'List webhook endpoints',
          ...secured(['webhooks:read']),
          responses: {
            '200': json('Endpoints', { type: 'array', items: ref('WebhookEndpoint') }),
            '401': UNAUTHORIZED,
            '403': FORBIDDEN,
          },
        },
      },
      '/v1/webhooks/endpoints/{id}': {
        patch: {
          operationId: 'updateWebhookEndpoint',
          tags: ['Webhooks'],
          summary: 'Update the url, events or active flag of an endpoint',
          ...secured(['webhooks:write']),
          parameters: [idParam('Endpoint')],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: ref('WebhookEndpointUpdate') } },
          },
          responses: {
            '200': json('Updated', ref('WebhookEndpoint')),
            '401': UNAUTHORIZED,
            '403': FORBIDDEN,
            '404': NOT_FOUND,
            '422': problem('Validation failed', 'ValidationProblem'),
          },
        },
      },
      '/v1/webhooks/endpoints/{id}/rotate-secret': {
        post: {
          operationId: 'rotateWebhookSecret',
          tags: ['Webhooks'],
          summary: 'Rotate the signing secret; the previous one stays valid for a grace period',
          ...secured(['webhooks:write']),
          parameters: [idParam('Endpoint')],
          responses: {
            '200': json('Rotated', ref('WebhookEndpointWithSecret')),
            '401': UNAUTHORIZED,
            '403': FORBIDDEN,
            '404': NOT_FOUND,
            '409': problem('A rotation is already in progress'),
          },
        },
      },
      '/v1/webhooks/deliveries': {
        get: {
          operationId: 'listWebhookDeliveries',
          tags: ['Webhooks'],
          summary: 'Delivery history (no payloads), newest first, cursor paginated',
          ...secured(['webhooks:read']),
          parameters: [
            { name: 'endpoint_id', in: 'query', schema: { type: 'string', format: 'uuid' } },
            {
              name: 'status',
              in: 'query',
              schema: { type: 'string', enum: ['pending', 'failed', 'delivered', 'dead'] },
            },
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
            },
            {
              name: 'cursor',
              in: 'query',
              description: 'The `next_cursor` of the previous page',
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': json('A page of deliveries', ref('WebhookDeliveryPage')),
            '401': UNAUTHORIZED,
            '403': FORBIDDEN,
            '422': problem('Invalid filter', 'ValidationProblem'),
          },
        },
      },
      '/v1/webhooks/deliveries/{id}/replay': {
        post: {
          operationId: 'replayWebhookDelivery',
          tags: ['Webhooks'],
          summary: 'Replay a dead delivery',
          ...secured(['webhooks:write']),
          parameters: [idParam('Delivery')],
          responses: {
            '200': json('The delivery, queued again', ref('WebhookDelivery')),
            '401': UNAUTHORIZED,
            '403': FORBIDDEN,
            '404': NOT_FOUND,
            '409': problem('The delivery is not dead, or its endpoint is inactive'),
          },
        },
      },
    },
    components: {
      securitySchemes: {
        apiKey: {
          type: 'http',
          scheme: 'bearer',
          description:
            'API key. Each route needs the scope named in `x-required-scopes` (`documents:read`, `documents:write`, `webhooks:read`, `webhooks:write`, `reception:read`, `reception:write`).',
        },
      },
      schemas: {
        Problem: {
          type: 'object',
          required: ['statusCode', 'message'],
          properties: { statusCode: { type: 'integer' }, message: { type: 'string' } },
        },
        ReceptionProblem: {
          type: 'object',
          required: ['statusCode', 'code', 'message'],
          properties: {
            statusCode: { type: 'integer' },
            code: {
              type: 'string',
              enum: [
                'payload_too_large',
                'unsupported_media_type',
                'unsupported_source',
                'extraction_failed',
                'empty_upload',
                'invalid_request',
                'storage_unavailable',
                'service_unavailable',
                'not_found',
              ],
            },
            message: { type: 'string' },
            document_id: {
              type: 'string',
              format: 'uuid',
              description: 'Only with `extraction_failed`',
            },
          },
        },
        ReceivedDocumentAck: {
          type: 'object',
          required: ['id', 'status', 'version', 'source'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            status: {
              type: 'string',
              description:
                'Current status; a re-upload returns whatever status the document has reached',
              examples: ['needs_review'],
            },
            version: { type: 'integer', minimum: 1 },
            source: { type: 'string', enum: ['sifen_xml'] },
          },
        },
        ReceivedDocumentSummary: {
          type: 'object',
          required: ['id', 'status', 'source', 'version', 'created_at', 'updated_at'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            status: { type: 'string', enum: RECEIVED_DOCUMENT_STATUSES },
            source: { type: 'string', enum: RECEIVED_DOCUMENT_SOURCES },
            version: { type: 'integer', minimum: 1 },
            needs_review: { type: 'boolean' },
            is_own_receiver: {
              type: 'boolean',
              description: 'False when the receiver RUC is not the tenant`s own',
            },
            document_type: { type: ['integer', 'null'] },
            cdc: { type: ['string', 'null'] },
            issuer: {
              type: 'object',
              properties: { ruc: { type: ['string', 'null'] }, name: { type: ['string', 'null'] } },
            },
            document_number: { type: ['string', 'null'], examples: ['001-001-0000123'] },
            issued_on: { type: ['string', 'null'], format: 'date' },
            currency: { type: 'string' },
            total_amount: decimalString,
            total_vat: decimalString,
            confidence_overall: decimalString,
            confirmed_at: nullableDateTime,
            has_artifact: { type: 'boolean' },
            created_at: dateTime,
            updated_at: dateTime,
          },
        },
        ReceivedDocumentPage: {
          type: 'object',
          required: ['items', 'next_cursor'],
          properties: {
            items: { type: 'array', items: ref('ReceivedDocumentSummary') },
            next_cursor: { type: ['string', 'null'] },
          },
        },
        ReceivedDocumentDetail: {
          type: 'object',
          required: ['id', 'status', 'source', 'version', 'items', 'field_confidences'],
          description:
            'Provisional field names. Money and quantities are decimal strings; confidences are decimal strings in [0, 1].',
          properties: {
            id: { type: 'string', format: 'uuid' },
            status: { type: 'string', enum: RECEIVED_DOCUMENT_STATUSES },
            source: { type: 'string', enum: RECEIVED_DOCUMENT_SOURCES },
            version: { type: 'integer', minimum: 1 },
            needs_review: { type: 'boolean' },
            needs_review_reasons: {
              type: 'array',
              items: { type: 'string' },
              description: 'Machine reason codes; empty unless `needs_review`',
            },
            is_own_receiver: { type: 'boolean' },
            extraction_error_code: { type: ['string', 'null'] },
            extraction_attempts: { type: 'integer' },
            confidence_overall: decimalString,
            document_type: { type: ['integer', 'null'] },
            cdc: { type: ['string', 'null'] },
            timbrado: { type: ['string', 'null'] },
            series: { type: ['string', 'null'] },
            establishment_code: { type: ['string', 'null'] },
            expedition_point_code: { type: ['string', 'null'] },
            document_sequence: { type: ['string', 'null'] },
            document_number: { type: ['string', 'null'] },
            issued_on: { type: ['string', 'null'], format: 'date' },
            currency: { type: 'string' },
            exchange_rate: decimalString,
            issuer: {
              type: 'object',
              properties: {
                ruc: { type: ['string', 'null'] },
                ruc_base: { type: ['string', 'null'] },
                ruc_dv: { type: ['integer', 'null'] },
                legal_name: { type: ['string', 'null'] },
                trade_name: { type: ['string', 'null'] },
                address: { type: ['string', 'null'] },
                economic_activity: { type: ['string', 'null'] },
              },
            },
            receiver: {
              type: 'object',
              properties: {
                ruc: { type: ['string', 'null'] },
                ruc_base: { type: ['string', 'null'] },
                ruc_dv: { type: ['integer', 'null'] },
                legal_name: { type: ['string', 'null'] },
                type: { type: ['integer', 'null'] },
              },
            },
            payment: {
              type: 'object',
              properties: {
                condition: { type: ['string', 'null'], enum: ['cash', 'credit', null] },
                credit_term_days: { type: ['integer', 'null'] },
                method: { type: ['string', 'null'] },
                due_on: { type: ['string', 'null'], format: 'date' },
                paid_on: { type: ['string', 'null'], format: 'date' },
              },
            },
            totals: {
              type: 'object',
              properties: {
                exempt: decimalString,
                zero_rated: decimalString,
                taxable_5: decimalString,
                taxable_10: decimalString,
                vat_5: decimalString,
                vat_10: decimalString,
                total_vat: decimalString,
                discount: decimalString,
                total_amount: decimalString,
                total_pyg: decimalString,
              },
            },
            sifen: {
              type: 'object',
              properties: {
                status: { type: 'string' },
                authorized_at: nullableDateTime,
                protocol_number: { type: ['string', 'null'] },
              },
            },
            items: {
              type: 'array',
              items: {
                type: 'object',
                required: ['position'],
                properties: {
                  position: { type: 'integer', minimum: 1 },
                  description: { type: ['string', 'null'] },
                  product_code: { type: ['string', 'null'] },
                  quantity: decimalString,
                  unit_of_measure: { type: ['string', 'null'] },
                  unit_price: decimalString,
                  discount: decimalString,
                  subtotal: decimalString,
                  vat_rate: { type: ['integer', 'null'], enum: [0, 5, 10, null] },
                  taxable_base: decimalString,
                  vat_amount: decimalString,
                },
              },
            },
            field_confidences: {
              type: 'array',
              items: {
                type: 'object',
                required: ['field', 'confidence'],
                properties: {
                  field: { type: 'string' },
                  confidence: { type: 'string' },
                  extracted_value: { type: ['string', 'null'] },
                  corrected_value: { type: ['string', 'null'] },
                  corrected_by: { type: ['string', 'null'] },
                  corrected_at: nullableDateTime,
                },
              },
            },
            confirmed_at: nullableDateTime,
            confirmed_by: { type: ['string', 'null'] },
            artifact: {
              type: ['object', 'null'],
              properties: {
                id: { type: 'string', format: 'uuid' },
                content_type: { type: ['string', 'null'] },
                size_bytes: { type: 'integer' },
                sha256: { type: 'string' },
                original_name: { type: ['string', 'null'] },
                page_count: { type: ['integer', 'null'] },
              },
            },
            artifact_url: {
              type: ['string', 'null'],
              description:
                'Path of `GET /v1/received-documents/{id}/artifact` (needs the API key); null without artifact',
            },
            created_at: dateTime,
            updated_at: dateTime,
          },
        },
        ReceivedArtifactUrl: {
          type: 'object',
          required: ['url', 'expires_in_seconds'],
          properties: { url: { type: 'string' }, expires_in_seconds: { type: 'integer' } },
        },
        ValidationProblem: {
          type: 'object',
          required: ['statusCode', 'message', 'errors'],
          properties: {
            statusCode: { type: 'integer', const: 422 },
            message: { type: 'string' },
            errors: {
              type: 'array',
              items: {
                type: 'object',
                required: ['field', 'message'],
                properties: {
                  field: { type: 'string' },
                  rule: { type: 'string' },
                  message: { type: 'string' },
                },
              },
            },
          },
        },
        CreateDocumentRequest: z.toJSONSchema(createDocumentSchema, {
          io: 'input',
          unrepresentable: 'any',
        }),
        DocumentAccepted: {
          type: 'object',
          required: ['document_id', 'cdc'],
          properties: {
            document_id: { type: 'string', format: 'uuid' },
            cdc: { type: 'string', pattern: '^[0-9]{44}$' },
          },
        },
        Document: {
          type: 'object',
          required: [
            'document_id',
            'cdc',
            'number',
            'status',
            'environment',
            'issued_at',
            'totals',
          ],
          properties: {
            document_id: { type: 'string', format: 'uuid' },
            cdc: { type: 'string', pattern: '^[0-9]{44}$' },
            number: { type: 'string', examples: ['001-002-0000007'] },
            status: { type: 'string', enum: [...DOCUMENT_STATUSES] },
            environment: { type: 'string', enum: ['test', 'production'] },
            issued_at: dateTime,
            totals: {
              type: 'object',
              required: ['amount', 'currency'],
              properties: {
                amount: { type: 'string', examples: ['110000'] },
                currency: { type: 'string' },
              },
            },
            receiver: {
              type: ['object', 'null'],
              properties: { ruc: { type: 'string' } },
            },
            sifen: {
              type: ['object', 'null'],
              description: 'SIFEN answer; null until transmission stores it',
              properties: { code: { type: 'string' }, message: { type: 'string' } },
            },
            urls: {
              type: 'object',
              properties: {
                xml: { type: ['string', 'null'] },
                kude: { type: ['string', 'null'] },
              },
            },
          },
        },
        WebhookEndpointCreate: {
          type: 'object',
          required: ['url', 'events'],
          properties: {
            url: { type: 'string', format: 'uri', description: 'Public https URL' },
            events: { type: 'array', items: { type: 'string', enum: [...WEBHOOK_EVENT_TYPES] } },
          },
        },
        WebhookEndpointUpdate: {
          type: 'object',
          properties: {
            url: { type: 'string', format: 'uri' },
            events: { type: 'array', items: { type: 'string', enum: [...WEBHOOK_EVENT_TYPES] } },
            active: { type: 'boolean' },
          },
        },
        WebhookEndpoint: {
          type: 'object',
          required: ['id', 'url', 'events', 'active', 'secret_version', 'created_at', 'updated_at'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            url: { type: 'string' },
            events: { type: 'array', items: { type: 'string' } },
            active: { type: 'boolean' },
            secret_version: { type: 'integer' },
            previous_secret_expires_at: nullableDateTime,
            created_at: dateTime,
            updated_at: dateTime,
          },
        },
        WebhookEndpointWithSecret: {
          allOf: [
            ref('WebhookEndpoint'),
            {
              type: 'object',
              required: ['secret'],
              properties: { secret: { type: 'string', description: 'Shown only once' } },
            },
          ],
        },
        WebhookDelivery: {
          type: 'object',
          required: [
            'id',
            'endpoint_id',
            'event_id',
            'event_type',
            'status',
            'attempt_count',
            'created_at',
          ],
          properties: {
            id: { type: 'string', format: 'uuid' },
            endpoint_id: { type: 'string', format: 'uuid' },
            event_id: { type: 'string' },
            event_type: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'failed', 'delivered', 'dead'] },
            attempt_count: { type: 'integer' },
            last_status_code: { type: ['integer', 'null'] },
            last_error: { type: ['string', 'null'] },
            next_attempt_at: nullableDateTime,
            delivered_at: nullableDateTime,
            created_at: dateTime,
          },
        },
        WebhookDeliveryPage: {
          type: 'object',
          required: ['items', 'next_cursor'],
          properties: {
            items: { type: 'array', items: ref('WebhookDelivery') },
            next_cursor: { type: ['string', 'null'] },
          },
        },
      },
    },
  };
}
