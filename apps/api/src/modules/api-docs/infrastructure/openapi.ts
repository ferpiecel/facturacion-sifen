import { z } from 'zod';
import { DOCUMENT_STATUSES } from '@sifen/db';
import { createDocumentSchema } from '../../emission/infrastructure/http/create-document.request.js';
import {
  createCreditNoteSchema,
  createDebitNoteSchema,
} from '../../emission/infrastructure/http/credit-note.request.js';
import { createSelfInvoiceSchema } from '../../emission/infrastructure/http/self-invoice.request.js';
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

const geoCodeParam = (name: string, what: string) => ({
  name,
  in: 'query',
  required: true,
  description: `${what}, as listed by the geography endpoints`,
  schema: { type: 'integer', minimum: 1, maximum: 99999 },
});

/** `{ items: [{ code, [parent], name }] }` of the geography endpoints. */
const geoList = (parent?: string) => ({
  type: 'object',
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['code', ...(parent ? [parent] : []), 'name'],
        properties: {
          code: { type: 'integer' },
          ...(parent ? { [parent]: { type: 'integer' } } : {}),
          name: { type: 'string' },
        },
      },
    },
  },
});

const secured = (scopes: string[]) => ({
  security: [{ apiKey: [] }],
  'x-required-scopes': scopes,
});

const dateTime = { type: 'string', format: 'date-time' };
const nullableDateTime = { type: ['string', 'null'], format: 'date-time' };

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
          summary:
            'Accept an invoice (FE), a credit note (NCE), a debit note (NDE) or a self-invoice (AFE) for emission',
          description:
            'The body is an FE unless `type` is `NCE` (credit note) or `NDE` (debit note), both associated to an approved FE whose receiver they take, or `AFE` (self-invoice: the issuer buys from a seller who is not a contribuyente; the receiver is the issuer, there is no VAT and the seller constancia is mandatory). ' +
            'A credit note answers 422 with the rule of the failed check (for example `credit-note-sum-exceeds-invoice`, 2417) before any number is used. ' +
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
            content: {
              'application/json': {
                schema: {
                  oneOf: [
                    ref('CreateDocumentRequest'),
                    ref('CreateCreditNoteRequest'),
                    ref('CreateDebitNoteRequest'),
                    ref('CreateSelfInvoiceRequest'),
                  ],
                },
              },
            },
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
      '/v1/documents/{id}/cancel': {
        post: {
          operationId: 'cancelDocument',
          tags: ['Documents'],
          summary: 'Request the cancellation of an approved document',
          description:
            'Asynchronous like emission: 202 once the cancellation event is stored; the worker signs it with the tenant certificate and sends it to SIFEN, and the document becomes `cancelled` (webhook `document.cancelled`) when SIFEN registers it. ' +
            'Only a document SIFEN holds as approved can be cancelled, within 48 hours of its approval for an FE and 168 hours for an AFE, NCE, NDE or NRE (MT v150 11.6.1, 4009 and 4010); a document with live associated documents is refused and they are listed (cancel them first, from the last to the first). ' +
            'A receiver having confirmed the document does not block it (NT 025). The 422 body carries `errors[0].rule` (`document-not-approved`, `cancel-window-expired`, `has-live-associated-documents`, `cancel-document-type-unsupported`, `approval-instant-unknown`) and, when SIFEN defines one, `sifenCode`. ' +
            'Retrying with the same `Idempotency-Key` and body returns the same response; the same key with another body is a 409.',
          ...secured(['documents:write']),
          parameters: [
            idParam('Document'),
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
            content: { 'application/json': { schema: ref('CancelDocumentRequest') } },
          },
          responses: {
            '202': json('Accepted', ref('EventAccepted')),
            '400': problem('Missing or malformed Idempotency-Key, or id is not a UUID'),
            '401': UNAUTHORIZED,
            '403': FORBIDDEN,
            '404': NOT_FOUND,
            '409': problem(
              'Idempotency-Key reused with another body, or the document already has a cancellation (4003)',
            ),
            '422': problem(
              'The reason is invalid or a cancellation rule refuses it',
              'ValidationProblem',
            ),
            '503': problem('The tenant ran out of event ids'),
          },
        },
      },
      '/v1/numbering/inutilize': {
        post: {
          operationId: 'inutilizeNumbers',
          tags: ['Numbering'],
          summary: 'Request the voiding of a range of numbers that will not be used',
          description:
            'Asynchronous: 202 once the voiding event is stored; the worker signs it and sends it to SIFEN, and the rejected documents inside the range become `number_voided` (webhook `document.number_voided`) when SIFEN registers it. ' +
            "The range has at most 1000 numbers (MT v150 11.6.2, 4067), belongs to the tenant's timbrado, establishment and point (4052, 4054, 4055), holds only numbers already issued, and holds no document SIFEN may know (4065: only rejected documents and gaps can be voided) nor numbers already being voided (4066). " +
            'The 422 body carries `errors[].rule`, `sifenCode` when SIFEN defines one, and the offending `numbers` for 4065. ' +
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
            content: { 'application/json': { schema: ref('InutilizeRequest') } },
          },
          responses: {
            '202': json('Accepted', ref('VoidingAccepted')),
            '400': problem('Missing or malformed Idempotency-Key'),
            '401': UNAUTHORIZED,
            '403': FORBIDDEN,
            '409': problem('Idempotency-Key reused with another body'),
            '422': problem(
              'The request is invalid or a voiding rule refuses it',
              'ValidationProblem',
            ),
            '503': problem('The tenant ran out of event ids'),
          },
        },
      },
      '/v1/documents/{id}/kude': {
        get: {
          operationId: 'downloadKude',
          tags: ['Documents'],
          summary:
            'Download the KuDE (PDF) of an FE, an AFE, an NCE or an NDE, available once the document is signed',
          ...secured(['documents:read']),
          description:
            'Paper layout by `format`: `letter` (A4, default), `ticket-80` or `ticket-58` (paper roll of 80 or 58 mm, for thermal printers; MT v150 13.6).',
          parameters: [
            idParam('Document'),
            {
              name: 'format',
              in: 'query',
              required: false,
              description: 'Paper layout of the KuDE',
              schema: {
                type: 'string',
                enum: ['letter', 'ticket-80', 'ticket-58'],
                default: 'letter',
              },
            },
          ],
          responses: {
            '200': {
              description: 'The KuDE',
              content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } },
            },
            '400': problem('id is not a UUID or format is not a known layout'),
            '401': UNAUTHORIZED,
            '403': FORBIDDEN,
            '404': NOT_FOUND,
            '409': problem('The document is not signed yet'),
            '422': problem('The document type has no KuDE layout yet (an NDE, AFE or NRE)'),
            '500': problem('The KuDE could not be generated'),
          },
        },
      },
      '/v1/geo/departments': {
        get: {
          operationId: 'listGeoDepartments',
          tags: ['Geography'],
          summary: 'Departments of the DNIT geographic table (Tabla 2.1)',
          description:
            'Public reference data: any valid API key works, no scope is needed (ADR-0017).',
          security: [{ apiKey: [] }],
          responses: {
            '200': json('All departments', ref('GeoDepartmentList')),
            '401': UNAUTHORIZED,
          },
        },
      },
      '/v1/geo/districts': {
        get: {
          operationId: 'listGeoDistricts',
          tags: ['Geography'],
          summary: 'Districts of one department',
          security: [{ apiKey: [] }],
          parameters: [geoCodeParam('departmentCode', 'Department code')],
          responses: {
            '200': json('The districts of the department', ref('GeoDistrictList')),
            '400': problem('departmentCode missing or not a code of 1 to 5 digits'),
            '401': UNAUTHORIZED,
            '404': problem('The department is not in the table'),
          },
        },
      },
      '/v1/geo/cities': {
        get: {
          operationId: 'listGeoCities',
          tags: ['Geography'],
          summary: 'Cities of one district',
          security: [{ apiKey: [] }],
          parameters: [geoCodeParam('districtCode', 'District code')],
          responses: {
            '200': json('The cities of the district', ref('GeoCityList')),
            '400': problem('districtCode missing or not a code of 1 to 5 digits'),
            '401': UNAUTHORIZED,
            '404': problem('The district is not in the table'),
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
            'API key. Each route needs the scope named in `x-required-scopes` (`documents:read`, `documents:write`, `webhooks:read`, `webhooks:write`); the `/v1/geo` routes need only a valid key.',
        },
      },
      schemas: {
        Problem: {
          type: 'object',
          required: ['statusCode', 'message'],
          properties: { statusCode: { type: 'integer' }, message: { type: 'string' } },
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
        CreateCreditNoteRequest: z.toJSONSchema(createCreditNoteSchema, {
          io: 'input',
          unrepresentable: 'any',
        }),
        CreateDebitNoteRequest: z.toJSONSchema(createDebitNoteSchema, {
          io: 'input',
          unrepresentable: 'any',
        }),
        CreateSelfInvoiceRequest: z.toJSONSchema(createSelfInvoiceSchema, {
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
        CancelDocumentRequest: {
          type: 'object',
          required: ['reason'],
          properties: { reason: { type: 'string', minLength: 5, maxLength: 500 } },
        },
        EventAccepted: {
          type: 'object',
          required: ['event_id', 'document_id', 'status'],
          properties: {
            event_id: { type: 'string', format: 'uuid' },
            document_id: { type: 'string', format: 'uuid' },
            status: { type: 'string', enum: ['pending'] },
          },
        },
        InutilizeRequest: {
          type: 'object',
          required: [
            'timbrado',
            'establishment',
            'expeditionPoint',
            'type',
            'from',
            'to',
            'reason',
          ],
          properties: {
            timbrado: { type: 'string', pattern: '^[0-9]{8}$' },
            establishment: { type: 'string', pattern: '^[0-9]{3}$' },
            expeditionPoint: { type: 'string', pattern: '^[0-9]{3}$' },
            type: { type: 'integer', minimum: 1, maximum: 8, description: 'iTiDE' },
            series: { type: 'string', pattern: '^[A-Z]{2}$' },
            from: { type: 'integer', minimum: 1, maximum: 9999999 },
            to: { type: 'integer', minimum: 1, maximum: 9999999 },
            reason: { type: 'string', minLength: 5, maxLength: 150 },
          },
        },
        VoidingAccepted: {
          type: 'object',
          required: ['event_id', 'status'],
          properties: {
            event_id: { type: 'string', format: 'uuid' },
            status: { type: 'string', enum: ['pending'] },
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
        GeoDepartmentList: geoList(),
        GeoDistrictList: geoList('departmentCode'),
        GeoCityList: geoList('districtCode'),
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
