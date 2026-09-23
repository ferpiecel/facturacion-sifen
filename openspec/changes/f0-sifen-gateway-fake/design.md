# Design: SIFEN gateway port and in-process fake

## Technical Approach

New ESM package `@sifen/sifen-gateway` (no runtime dependencies) that mirrors `packages/sifen-xsd` exactly: `module/moduleResolution: nodenext`, `erasableSyntaxOnly`, `rewriteRelativeImportExtensions`, build `rootDir: src`, own `tsconfigRootDir` in `eslint.config.js`, scripts `build/typecheck/lint/depcruise/test`, devDependencies `@sifen/config`, `@types/node`, `dependency-cruiser`, `typescript`, `vitest` at the same pinned versions. The port copies plan §5.1 names. The fake is a scripted, synchronous-resolving implementation.

## Architecture Decisions

| Topic | Options | Decision / rationale |
|---|---|---|
| `dCodRes` type | `string` / closed union / `SifenCode \| (string & {})` | Open union: autocompletes verified codes and still accepts real codes the adapter will see later. |
| Catalog | enum / `as const` object | `SIFEN_CODES` `as const` (enums break `erasableSyntaxOnly`). Only 0160, 0260, 0300, 0301, 0360, 0361, 0362, 0364, 0420, 0422, with MT/Guía JSDoc. |
| Scripted failure | discriminated `{kind}` / `T \| Error` | `Scripted<T> = T \| Error`: an `Error` entry rejects the promise immediately. No timers. |
| Defaults | all ops / verified ops only | Built-in defaults for ops with a verified success code (enviarLote 0300, consultarLote 0362 empty, enviarDESincronico 0260, consultarDE 0422). `enviarEventos` and `consultarRUC` have no verified code, so an unscripted call rejects with `Error('no response configured')`. |
| Error classes | parameter properties / explicit fields | Explicit fields (parameter properties are not erasable syntax). |
| Events limit | reject in fake / type-level | Fake rejects `RangeError` when `eventos.length` is 0 or > 15. The call is still recorded. |
| Depcruise scope | package-local config / root rule + `--base-dir` | Root rule `sifen-gateway-framework-free`, `from: (^|/)packages/sifen-gateway/src/`, `to: FW`. The package script runs `depcruise --config ../../.dependency-cruiser.cjs --base-dir ../.. packages/sifen-gateway/src` so paths contain `packages/`. |

## Data Flow

    test ──enqueue/setDefault──> FakeSifenGateway
    test ──op(args)──> record call ──> queue[op].shift() ?? default[op]
                                   └─> Error ? reject : resolve(response)

## File Changes

| File | Action |
|---|---|
| `packages/sifen-gateway/{package.json,tsconfig.json,tsconfig.build.json,eslint.config.js,vitest.config.ts}` | Create (copied conventions; no `vendor/`, no `scripts/`) |
| `src/port.ts` | `SifenGateway`, `SifenOperation`, `SifenResultOf<K>` |
| `src/types.ts` | `Cdc`, `toCdc`, result types |
| `src/codes.ts` | `SIFEN_CODES`, `SifenCode` |
| `src/errors.ts` | `SifenTimeoutError`, `SifenTransportError` |
| `src/fake/fake-sifen-gateway.ts` | Fake + call recording |
| `src/fake/scenarios.ts` | Response builders for verified codes |
| `src/index.ts` | Barrel |
| `test/*.spec.ts` | Unit tests |
| `.dependency-cruiser.cjs` | Add rule |
| `apps/api/test/fixtures/boundaries/packages/sifen-gateway/src/framework-import.ts` | Imports `@nestjs/common` |
| `apps/api/test/architecture/boundaries.spec.ts` | New case |

## Interfaces / Contracts

```ts
declare const cdcBrand: unique symbol;
export type Cdc = string & { readonly [cdcBrand]: true };
export function toCdc(value: string): Cdc; // /^\d{44}$/ else RangeError

export interface SifenRespuesta { dCodRes: SifenCode | (string & {}); dMsgRes: string }
export interface SifenResultadoDE { cdc: Cdc; dEstRes: string; mensajes: SifenRespuesta[] }
export interface SifenLoteReceipt extends SifenRespuesta { dProtConsLote: string | null }
export interface SifenLoteResult extends SifenRespuesta { resultados: SifenResultadoDE[] }
export interface SifenProtocoloDE extends SifenRespuesta { dEstRes: string | null; dProtAut: string | null }
export interface SifenConsDE extends SifenRespuesta { xmlDE: string | null }
export interface SifenEventosResult extends SifenRespuesta { resultados: SifenResultadoEvento[] } // { id: string; dEstRes: string; mensajes }
export interface SifenConsRUC extends SifenRespuesta { contribuyente: { ruc: string; razonSocial: string; estado: string; facturadorElectronico: boolean } | null }

export type SifenOperation = keyof SifenGateway;
export type SifenCall = { [K in SifenOperation]: { operation: K; args: Parameters<SifenGateway[K]> } }[SifenOperation];

export class FakeSifenGateway implements SifenGateway {
  enqueue<K extends SifenOperation>(op: K, ...responses: Scripted<SifenResultOf<K>>[]): this;
  setDefault<K extends SifenOperation>(op: K, response: Scripted<SifenResultOf<K>>): this;
  get calls(): readonly SifenCall[];                 // arrays copied on record
  callsTo<K extends SifenOperation>(op: K): Parameters<SifenGateway[K]>[];
  reset(): void;
}
// SifenTimeoutError / SifenTransportError: { name; operation: SifenOperation }, cause via ErrorOptions
```

Scenario builders: `loteRecibido(nro)`, `loteNoEncolado(msg)`, `loteInexistente()`, `loteEnProcesamiento()`, `loteConcluido(resultados)`, `consultaExtemporanea()`, `deAutorizado(dProtAut)`, `cdcEncontrado(xml)`, `cdcInexistente()`, `xmlMalformado<K>(op)`. RUC blocked is scripted by the test with an explicit `contribuyente.estado`.

## Testing Strategy (strict TDD, red commit before green)

| Order | Test | Layer |
|---|---|---|
| 1 | `codes.spec`: catalog values exact | Unit |
| 2 | `types.spec`: `toCdc` accepts 44 digits, rejects others | Unit |
| 3 | `errors.spec`: `instanceof`, `name`, `operation`, `cause` | Unit |
| 4 | `boundaries.spec`: fixture flags `sifen-gateway-framework-free` | Architecture |
| 5 | `fake.spec` per op: defaults, queue FIFO then default, each verified code, timeout/transport rejection, 15-event limit, missing default for eventos/RUC, call recording with copied args, `reset` | Unit |

## PR Split

| PR | Content | Est. lines |
|---|---|---|
| 1 | Scaffolding, port, types, codes, errors, index, tests 1–4, depcruise rule | ~330 |
| 2 (stacked, draft) | Fake, scenarios, tests 5 | ~370 |

## Threat Matrix

N/A: no routing, shell, subprocess, VCS/PR automation, executable-file classification or process-integration boundary.

## Migration / Rollout

No migration required.

## Open Questions

- [ ] `--base-dir` path semantics must be confirmed in apply by adding a temporary forbidden import to `src` and seeing `pnpm depcruise` fail. Fallback: a package-local config that `extends` the root config and adds `from: ^src/`.
- [ ] Consulta RUC and event codes are unverified. Add them when E6 verifies them.
