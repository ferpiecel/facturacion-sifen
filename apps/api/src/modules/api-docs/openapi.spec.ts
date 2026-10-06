import { readFileSync } from 'node:fs';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants.js';
import { RequestMethod } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../../app.module.js';
import { IS_PUBLIC_KEY } from '../identity/infrastructure/decorators/public.decorator.js';
import { REQUIRED_SCOPES_KEY } from '../identity/infrastructure/decorators/require-scopes.decorator.js';
import { buildOpenApiDocument } from './openapi.js';

type Ctor = new (...args: never[]) => unknown;
const METHODS: Record<number, string> = {
  [RequestMethod.GET]: 'get',
  [RequestMethod.POST]: 'post',
  [RequestMethod.PATCH]: 'patch',
  [RequestMethod.PUT]: 'put',
  [RequestMethod.DELETE]: 'delete',
};

/** Every controller reachable from AppModule, so a new controller cannot hide from the spec. */
function controllers(module: Ctor, seen = new Set<Ctor>()): Ctor[] {
  if (seen.has(module)) return [];
  seen.add(module);
  const own = (Reflect.getMetadata('controllers', module) as Ctor[] | undefined) ?? [];
  const imported = (Reflect.getMetadata('imports', module) as unknown[] | undefined) ?? [];
  return [
    ...own,
    ...imported
      .filter((entry): entry is Ctor => typeof entry === 'function')
      .flatMap((child) => controllers(child, seen)),
  ];
}

interface Route {
  key: string;
  scopes: string[];
}

/** Integrator routes: everything behind the API key guard (not `@Public()`). */
function integratorRoutes(): Route[] {
  return controllers(AppModule as Ctor)
    .filter((controller) => !Reflect.getMetadata(IS_PUBLIC_KEY, controller))
    .flatMap((controller) => {
      const base = String(Reflect.getMetadata(PATH_METADATA, controller));
      return Object.getOwnPropertyNames(controller.prototype)
        .map((name) => (controller.prototype as Record<string, unknown>)[name])
        .filter(
          (handler): handler is () => unknown =>
            typeof handler === 'function' && Reflect.hasMetadata(METHOD_METADATA, handler),
        )
        .filter((handler) => !Reflect.getMetadata(IS_PUBLIC_KEY, handler))
        .map((handler) => {
          const sub = String(Reflect.getMetadata(PATH_METADATA, handler));
          const path = `/${[base, sub === '/' ? '' : sub].filter(Boolean).join('/')}`.replace(
            /:(\w+)/g,
            '{$1}',
          );
          const method = METHODS[Reflect.getMetadata(METHOD_METADATA, handler) as number];
          const scopes = (Reflect.getMetadata(REQUIRED_SCOPES_KEY, handler) ??
            Reflect.getMetadata(REQUIRED_SCOPES_KEY, controller) ??
            []) as string[];
          return { key: `${method.toUpperCase()} ${path}`, scopes };
        });
    });
}

const spec = buildOpenApiDocument();
const operations = Object.entries(spec.paths).flatMap(([path, item]) =>
  Object.entries(item as Record<string, { 'x-required-scopes'?: string[] }>).map(
    ([method, operation]) => ({
      key: `${method.toUpperCase()} ${path}`,
      scopes: operation['x-required-scopes'] ?? [],
      operation: operation as Record<string, unknown>,
    }),
  ),
);

describe('OpenAPI document', () => {
  it('documents every integrator route and nothing else', () => {
    const routes = integratorRoutes();
    expect(routes.length).toBeGreaterThanOrEqual(10);
    expect(operations.map((o) => o.key).sort()).toEqual(routes.map((r) => r.key).sort());
  });

  it('declares the same API key scopes as the guard enforces', () => {
    const expected = Object.fromEntries(integratorRoutes().map((r) => [r.key, r.scopes]));
    expect(Object.fromEntries(operations.map((o) => [o.key, o.scopes]))).toEqual(expected);
  });

  it('never exposes the portal /auth or /health routes', () => {
    expect(Object.keys(spec.paths).filter((p) => !p.startsWith('/v1/'))).toEqual([]);
  });

  it('is a structurally valid OpenAPI 3.1 document', () => {
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.components.securitySchemes.apiKey).toMatchObject({ type: 'http', scheme: 'bearer' });
    const ids = operations.map((o) => o.operation.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    const json = JSON.stringify(spec);
    for (const [, ref] of json.matchAll(/"\$ref":"#\/components\/([^"]+)"/g)) {
      const [section, name] = ref.split('/');
      expect(
        (spec.components as unknown as Record<string, Record<string, unknown>>)[section]?.[name],
        ref,
      ).toBeDefined();
    }
    for (const { key, operation } of operations) {
      expect(operation.responses, key).toBeDefined();
      expect(operation.security, key).toEqual([{ apiKey: [] }]);
      expect(Object.keys(operation.responses as object), key).toContain('401');
    }
  });

  it('derives the create-document request body from the validation schema', () => {
    const body = (spec.components.schemas as Record<string, { required?: string[] }>)
      .CreateDocumentRequest;
    expect(body.required).toEqual(
      expect.arrayContaining(['establishment', 'expeditionPoint', 'items', 'receiver']),
    );
  });

  it('matches the checked-in docs/api/openapi.json', () => {
    const file = new URL('../../../../../docs/api/openapi.json', import.meta.url);
    expect(
      JSON.parse(readFileSync(file, 'utf8')),
      'regenerate: pnpm --filter @sifen/api openapi',
    ).toEqual(JSON.parse(JSON.stringify(spec)));
  });
});
