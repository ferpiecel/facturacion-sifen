import { z } from 'zod';
import { DOCUMENT_STATUSES } from '@sifen/db';
import { createDocumentSchema } from '../../emission/infrastructure/http/create-document.request.js';
import {
  createCreditNoteSchema,
  createDebitNoteSchema,
} from '../../emission/infrastructure/http/credit-note.request.js';
import { createRemissionSchema } from '../../emission/infrastructure/http/remission.request.js';
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
            'Accept an invoice (FE), a credit note (NCE), a debit note (NDE), a self-invoice (AFE) or a remission note (NRE) for emission',
          description:
            'The body is an FE unless `type` is `NCE` (credit note) or `NDE` (debit note), both associated to an approved FE whose receiver they take, or `AFE` (self-invoice: the issuer buys from a seller who is not a contribuyente; the receiver is the issuer, there is no VAT and the seller constancia is mandatory) or `NRE` (remission note: goods in transit, with the motive, the kilometres, the places, the vehicle and the carrier; items carry a quantity and no price, and the document has no totals; motive 7 only to the issuer own RUC, 2606). ' +
            'From the day before the active certificate expires (`CERTIFICATE_EMISSION_BLOCK_DAYS`) the request answers 422 with `code: certificate_expiring` and `notAfter`, before any number is used. ' +
            'A credit note answers 422 with the rule of the failed check (for example `credit-note-sum-exceeds-invoice`, 2417) before any number is used. ' +
            'Returns 202 once the document is persisted with its CDC; signing and transmission to SIFEN are asynchronous. ' +
            'With `?wait=true`, a tenant that has synchronous transmission enabled gets the response held until SIFEN settles the document (up to `SYNC_WAIT_TIMEOUT_MS`, 30 s by default) and receives 200 with the final document; if the wait ends first, or the tenant has no synchronous transmission, the usual 202 comes back. Sending is still driven by the worker cycle, so the wait is bounded by `TRANSMISSION_CYCLE_INTERVAL_MS`. ' +
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
            {
              name: 'wait',
              in: 'query',
              required: false,
              description:
                'Only `true` has an effect: hold the response for a tenant with synchronous transmission until the document is final.',
              schema: { type: 'string', enum: ['true'] },
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
                    ref('CreateRemissionRequest'),
                  ],
                },
              },
            },
          },
          responses: {
            '200': json(
              'Final document (only with `?wait=true` for a tenant with synchronous transmission)',
              ref('Document'),
            ),
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
      '/v1/documents/{id}/correct': {
        post: {
          operationId: 'correctDocument',
          tags: ['Documents'],
          summary: 'Correct a rejected document and send it again',
          description:
            'Takes the full corrected body of a document SIFEN rejected (same shape as `POST /v1/documents`; the `type` cannot change). ' +
            'When the correction keeps the establishment, the point and the associated CDC and the 72 h window of the issue date is open, the document keeps its number and CDC and is queued again (`202 { document_id, cdc }` with the same ids); the previous body and SIFEN messages are kept in the correction history. ' +
            'Otherwise the corrected body is issued as a new document (new number, new date: the response carries the new `document_id` and `cdc`) and the old number is voided (webhook `document.number_voided`); if that voiding is refused (for example 4066) the replacement stays, the correction is recorded and the response adds `void: { status: "refused", errors }`, the same on every retry. ' +
            'Only a `rejected` document that was not reissued before can be corrected (409 `document_not_correctable`). ' +
            'Retrying with the same `Idempotency-Key` and body returns the same response; the same key with another body is a 409. Remission notes (NRE) are not correctable (422). While a reissue holds the document (in flight, or refused and not yet completed) another `Idempotency-Key` gets 409 `document_not_correctable`: retry with the same key and body.',
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
            '202': json('Accepted', ref('CorrectionAccepted')),
            '400': problem('Missing or malformed Idempotency-Key, or id is not a UUID'),
            '401': UNAUTHORIZED,
            '403': FORBIDDEN,
            '404': NOT_FOUND,
            '409': problem(
              'Idempotency-Key reused with another body, or the document is not rejected',
            ),
            '422': problem(
              'Validation failed, the type changed, or the body is a remission note (NRE), which cannot be corrected',
              'ValidationProblem',
            ),
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
      '/v1/documents/{id}/nominate': {
        post: {
          operationId: 'nominateDocument',
          tags: ['Documents'],
          summary: 'Name the receiver of an FE issued to an unnamed receiver',
          description:
            'Asynchronous like the cancellation: 202 once the nomination event is stored; the worker signs it with the tenant certificate and sends it to SIFEN (NT 014, 015, 027). ' +
            'Only an approved FE (type 1) issued to an unnamed receiver ("Sin Nombre") can be nominated, once: a rejected nomination may be requested again. ' +
            'The receiver is a `taxpayer` (RUC with its check digit and taxpayer type) or a `non-taxpayer` (document type 1 to 5 and number); the operation type B2B is only for taxpayers. ' +
            'The 422 body carries `errors[0].rule` (`nominate-requires-fe` 4454, `document-not-approved` 4002, `nominate-receiver-named` 4469, `reason-length` or `schema`) and, when SIFEN defines one, `sifenCode`. ' +
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
            content: { 'application/json': { schema: ref('NominateDocumentRequest') } },
          },
          responses: {
            '202': json('Accepted', ref('EventAccepted')),
            '400': problem('Missing or malformed Idempotency-Key, or id is not a UUID'),
            '401': UNAUTHORIZED,
            '403': FORBIDDEN,
            '404': NOT_FOUND,
            '409': problem(
              'Idempotency-Key reused with another body, or the document already has a nomination (4453)',
            ),
            '422': problem(
              'The receiver or the reason is invalid, or a nomination rule refuses it',
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
      '/v1/receiver-events': {
        post: {
          operationId: 'registerReceiverEvent',
          tags: ['Receiver events'],
          summary: 'Register a conformity, disconformity, unawareness or receipt notice over a CDC',
          description:
            'The tenant acts as the RECEIVER of a DE/DTE issued by someone else. Asynchronous: 202 once the event is stored; the worker signs it with the tenant certificate and sends it to SIFEN with the other events. ' +
            'Allowed within 45 days (configurable) of the issue date of a DE or of the approval of a DTE (`approvedAt`, NT 019), at most one event per kind (a partial conformity may precede the total one), and not after an unawareness. An event that contradicts the last one is a correction (`receiver-event-needs-correction`). ' +
            'The 422 body carries `errors[].rule`, `sifenCode` when SIFEN defines one and, for an expired window, the `deadline`; an event of that kind already registered is a 409. ' +
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
            content: { 'application/json': { schema: ref('ReceiverEventRequest') } },
          },
          responses: {
            '202': json('Accepted', ref('ReceiverEventAccepted')),
            '400': problem('Missing or malformed Idempotency-Key'),
            '401': UNAUTHORIZED,
            '403': FORBIDDEN,
            '409': problem(
              'Idempotency-Key reused with another body, or the CDC already has an event of that kind',
            ),
            '422': problem(
              'The request is invalid or a window or compatibility rule refuses it',
              'ValidationProblem',
            ),
            '503': problem('The tenant ran out of event ids'),
          },
        },
      },
      '/v1/receiver-events/{id}/correct': {
        post: {
          operationId: 'correctReceiverEvent',
          tags: ['Receiver events'],
          summary: 'Correct a receiver event SIFEN approved by registering the opposite one',
          description:
            'The body is the replacement event (same fields and CDC as `ReceiverEventRequest`) plus `correctionReason` (5 to 500 characters). ' +
            'Only a conformity, disconformity or unawareness SIFEN approved can be corrected: once, while it is the last conclusive event of the CDC, within 15 days (configurable) of its approval, by the opposite kind; a correction cannot be corrected. ' +
            '422 `errors[].rule` names the failed rule (`correction-window-expired` carries `deadline`); a second correction is a 409. Same `Idempotency-Key` and body return the same response; another body is a 409.',
          ...secured(['documents:write']),
          parameters: [
            idParam('Receiver event'),
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
            content: { 'application/json': { schema: ref('ReceiverEventCorrectionRequest') } },
          },
          responses: {
            '202': json('Accepted', ref('ReceiverEventCorrectionAccepted')),
            '400': problem('id is not a UUID, or missing or malformed Idempotency-Key'),
            '401': UNAUTHORIZED,
            '403': FORBIDDEN,
            '404': problem('The tenant has no such receiver event'),
            '409': problem(
              'Idempotency-Key reused with another body, or the event was already corrected',
            ),
            '422': problem(
              'The request is invalid or a correction rule refuses it',
              'ValidationProblem',
            ),
          },
        },
      },
      '/v1/documents/{id}/kude': {
        get: {
          operationId: 'downloadKude',
          tags: ['Documents'],
          summary:
            'Download the KuDE (PDF) of an FE, an AFE, an NCE, an NDE or an NRE, available once the document is signed',
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
            '422': problem('The document type has no KuDE layout yet (for example a retention)'),
            '500': problem('The KuDE could not be generated'),
          },
        },
      },
      '/v1/ruc/{ruc}': {
        get: {
          operationId: 'lookupRuc',
          tags: ['Registry'],
          summary: 'Looks a RUC up in the SIFEN registry (siConsRUC), with a cache',
          description:
            'Validates a receiver by RUC. Answers are cached for RUC_CACHE_TTL_SECONDS (default one day); `cached` tells whether this one came from the cache. Any valid API key works, no scope is needed.',
          security: [{ apiKey: [] }],
          parameters: [
            {
              name: 'ruc',
              in: 'path',
              required: true,
              description: 'RUC without the check digit, 5 to 8 digits',
              schema: { type: 'string', pattern: '^[0-9]{5,8}$' },
            },
          ],
          responses: {
            '200': json('The taxpayer', ref('RucLookup')),
            '400': problem('The RUC is not 5 to 8 digits'),
            '401': UNAUTHORIZED,
            '404': problem('SIFEN has no such RUC'),
            '502': problem('SIFEN refused or could not answer the query'),
            '503': problem('No SIFEN adapter or database is available in this deployment'),
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
        CreateRemissionRequest: z.toJSONSchema(createRemissionSchema, {
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
        CorrectionAccepted: {
          type: 'object',
          required: ['document_id', 'cdc'],
          properties: {
            document_id: { type: 'string', format: 'uuid' },
            cdc: { type: 'string', pattern: '^[0-9]{44}$' },
            void: {
              type: 'object',
              description:
                'Only when the old number of a reissue could not be voided: the replacement stays live and the correction is recorded',
              required: ['status', 'errors'],
              properties: {
                status: { type: 'string', enum: ['refused'] },
                errors: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      field: { type: 'string' },
                      rule: { type: 'string' },
                      sifenCode: { type: 'string' },
                      message: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
        CancelDocumentRequest: {
          type: 'object',
          required: ['reason'],
          properties: { reason: { type: 'string', minLength: 5, maxLength: 500 } },
        },
        NominationReceiver: {
          type: 'object',
          required: ['kind', 'name', 'country', 'operationType'],
          properties: {
            kind: { type: 'string', enum: ['taxpayer', 'non-taxpayer'] },
            ruc: { type: 'string', description: 'taxpayer: RUC with check digit, 12345678-9' },
            taxpayerType: {
              type: 'integer',
              enum: [1, 2],
              description: 'taxpayer: 1 natural, 2 legal',
            },
            documentType: { type: 'integer', minimum: 1, maximum: 5, description: 'non-taxpayer' },
            documentNumber: { type: 'string', description: 'non-taxpayer' },
            operationType: {
              type: 'string',
              enum: ['B2B', 'B2C', 'B2F'],
              description: 'B2B only for a taxpayer',
            },
            name: { type: 'string', minLength: 4, maxLength: 255 },
            tradeName: { type: 'string' },
            country: { type: 'string', pattern: '^[A-Za-z]{3}$' },
            address: { type: 'string' },
            houseNumber: { type: 'string' },
            departmentCode: { type: 'integer' },
            districtCode: { type: 'integer' },
            cityCode: { type: 'integer' },
            phone: { type: 'string' },
            mobile: { type: 'string' },
            email: { type: 'string', format: 'email' },
            customerCode: { type: 'string' },
          },
        },
        NominateDocumentRequest: {
          type: 'object',
          required: ['receiver', 'reason'],
          properties: {
            receiver: ref('NominationReceiver'),
            reason: { type: 'string', minLength: 5, maxLength: 500 },
          },
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
        ReceiverEventRequest: {
          type: 'object',
          required: ['kind', 'cdc', 'issuedAt'],
          properties: {
            kind: {
              type: 'string',
              enum: ['conformity', 'disconformity', 'unawareness', 'receipt_notice'],
            },
            cdc: { type: 'string', pattern: '^[0-9]{44}$', description: 'CDC of the DE/DTE' },
            issuedAt: { type: 'string', description: 'dFecEmi, AAAA-MM-DDThh:mm:ss (Asunción)' },
            approvedAt: {
              type: 'string',
              description: 'SIFEN approval of a DTE (ISO instant); the 45 days count from it',
            },
            conformityType: { type: 'string', enum: ['total', 'partial'] },
            estimatedReceiptAt: {
              type: 'string',
              description: 'Required for a partial conformity (GCO004)',
            },
            reason: { type: 'string', minLength: 5, maxLength: 500 },
            receivedAt: {
              type: 'string',
              description: 'dFecRecep, required for an unawareness and a receipt notice',
            },
            totalPyg: { type: 'number', minimum: 0, description: 'Total in guaraníes (notice)' },
          },
        },
        ReceiverEventCorrectionRequest: {
          allOf: [
            ref('ReceiverEventRequest'),
            {
              type: 'object',
              required: ['correctionReason'],
              properties: { correctionReason: { type: 'string', minLength: 5, maxLength: 500 } },
            },
          ],
        },
        ReceiverEventCorrectionAccepted: {
          type: 'object',
          required: ['event_id', 'corrects_event_id', 'kind', 'cdc', 'status'],
          properties: {
            event_id: { type: 'string', format: 'uuid' },
            corrects_event_id: { type: 'string', format: 'uuid' },
            kind: { type: 'string' },
            cdc: { type: 'string', pattern: '^[0-9]{44}$' },
            status: { type: 'string', enum: ['pending'] },
          },
        },
        ReceiverEventAccepted: {
          type: 'object',
          required: ['event_id', 'kind', 'cdc', 'status'],
          properties: {
            event_id: { type: 'string', format: 'uuid' },
            kind: { type: 'string' },
            cdc: { type: 'string', pattern: '^[0-9]{44}$' },
            status: { type: 'string', enum: ['pending'] },
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
        RucLookup: {
          type: 'object',
          required: ['ruc', 'cached', 'taxpayer'],
          properties: {
            ruc: { type: 'string' },
            cached: { type: 'boolean' },
            taxpayer: {
              type: 'object',
              required: ['legal_name', 'status', 'electronic_invoicer'],
              properties: {
                legal_name: { type: 'string' },
                status: {
                  type: 'string',
                  description: 'ACT, SUS, SAD, BLQ, CAN or CDE (MT v150 schema 17)',
                },
                electronic_invoicer: { type: 'boolean' },
              },
            },
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
