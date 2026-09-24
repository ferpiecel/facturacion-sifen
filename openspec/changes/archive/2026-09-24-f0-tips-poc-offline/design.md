# Design: Offline PoC with the TIPS libraries (HU-E0-04, offline part)

## Technical Approach

Hexagonal split. Three new ports live in `@sifen/sifen-gateway` (framework-free, TIPS-free). A new package `@sifen/sifen-tips` holds thin adapters, one per port, that wrap `facturacionelectronicapy-xmlgen`, `-xmlsign` and `-qrgen`. An offline e2e test in `@sifen/sifen-tips` chains builder → signer → QR → `@sifen/sifen-xsd` → `FakeSifenGateway`.

## Architecture Decisions

| Topic | Options | Tradeoff | Decision |
|---|---|---|---|
| Port sync/async | sync `string` vs `Promise<string>` | TIPS APIs are Promise-based; plan §5.1 is async | `Promise<string>` for all three |
| Builder input | full domain `DocumentoElectronico` vs PoC input type | Domain model belongs to E5 | `FacturaPocInput`: opaque, domain-free `{ params; data }` records (`Readonly<Record<string, unknown>>`) passed through to xmlgen. Replaced by the domain model in E5 |
| `buildParaReceptor` | now vs later | Not needed offline | Deferred to E5 (documented deviation from plan §5.1) |
| `QrGenerator` shape | plan `buildUrl` vs `addQr` | qrgen returns the XML with `gCamFuFD`, which `rDE` requires before XSD validation | `addQr(signedXml, QrConfig) → Promise<string>`. Plan §5.1 updated in PR1 |
| CJS interop | named imports vs default import | TIPS packages are CJS; named exports are unreliable under `nodenext` | `import xmlgen from '…'` (default) and call its members. Apply reads the `node_modules` typings first and keeps each wrapper under ~40 lines |
| Signing mode | JVM vs Node | JVM spawns a process and needs Java in CI | Always `signByNodeJS: true`, hard-coded, not configurable |
| Dev certificate | `node-forge` / `selfsigned` / `openssl` via `child_process` | `node:crypto` cannot build X.509. `selfsigned` outputs PEM only and wraps forge anyway. `openssl` needs a system binary and breaks the no-subprocess guard | `node-forge` (exact version pinned, devDependency only). It builds a self-signed RSA-2048 cert and exports PKCS#12 in memory. Nothing is written to disk |

## Data Flow

    FacturaPocInput ─→ TipsDeXmlBuilder ─→ xml
    xml + devCert  ─→ TipsXmlSigner (signByNodeJS) ─→ signedXml
    signedXml + QrConfig ─→ TipsQrGenerator ─→ xmlWithQr
    xmlWithQr ─→ sifen-xsd validateXml('siRecepDE') ─→ valid
    xmlWithQr ─→ FakeSifenGateway.enviarDESincronico ─→ scripted 0260

## File Changes

| File | Action | Description |
|---|---|---|
| `packages/sifen-gateway/src/emission-ports.ts` | Create | `DeXmlBuilder`, `XmlSigner`, `QrGenerator`, `LoadedCertificate`, `QrConfig`, `Ambiente`, `FacturaPocInput` |
| `packages/sifen-gateway/src/index.ts` | Modify | Type-only re-exports |
| `packages/sifen-gateway/src/emission-ports.test.ts` | Create | Type-level contract test (`expectTypeOf`) |
| `packages/sifen-tips/{package.json,tsconfig*.json,eslint/vitest config}` | Create | Mirrors `@sifen/sifen-xsd` conventions. Deps: the 3 TIPS libs (exact pins), `@sifen/sifen-gateway`. devDeps: `@sifen/sifen-xsd`, `node-forge`, `@types/node-forge` |
| `packages/sifen-tips/src/{de-xml-builder,xml-signer,qr-generator,index}.ts` | Create | Thin adapters |
| `packages/sifen-tips/src/*.test.ts` | Create | Unit tests with `vi.mock` of each TIPS module |
| `packages/sifen-tips/test/support/dev-certificate.ts` | Create | forge-based test-time p12 |
| `packages/sifen-tips/test/support/no-subprocess-guard.ts` | Create | child_process tripwire |
| `packages/sifen-tips/test/poc-offline.e2e.test.ts` | Create | PoC flow |
| `docs/adr/0015-tips-libs-emision.md`, `docs/adr/README.md`, `docs/adr/0002-*.md` | Create/Modify | ADR, index, "Enmendado por 0015" |
| `.dependency-cruiser.cjs` | Modify | Only `sifen-tips` may import `facturacionelectronicapy-*` |

## Interfaces / Contracts

```ts
export type Ambiente = 'test' | 'prod';
export interface LoadedCertificate { readonly p12: Uint8Array; readonly password: string; }
export interface QrConfig { readonly idCsc: string; readonly csc: string; readonly ambiente: Ambiente; }
export interface FacturaPocInput { readonly params: Readonly<Record<string, unknown>>; readonly data: Readonly<Record<string, unknown>>; }
export interface DeXmlBuilder { buildParaSifen(input: FacturaPocInput): Promise<string>; }
export interface XmlSigner { sign(xml: string, cert: LoadedCertificate): Promise<string>; }
export interface QrGenerator { addQr(signedXml: string, config: QrConfig): Promise<string>; }
```

The adapter converts `p12` to the shape xmlsign expects (Buffer or temp path, per its typings). If a path is required, it uses `os.tmpdir()` + `mkdtemp` and removes the file in `finally`.

## Testing Strategy

| Layer | What | Approach |
|---|---|---|
| Unit | Each adapter forwards arguments. The signer always passes `signByNodeJS: true`. The QR adapter maps `ambiente` to the test or prod URL | `vi.mock` the TIPS module and assert the call arguments (RED first) |
| Contract | Ports import no TIPS or framework modules | depcruise rule + `expectTypeOf` |
| E2E | Full flow is offline. XSD is valid. The fake returns its scripted result. Signature has exc-c14n, rsa-sha256, sha256, only `X509Certificate` in KeyInfo, Reference URI `#<DE Id>` | Real libs. Signature assertions parse the XML with regex or DOM queries |
| No-JVM | Nothing in `child_process` is called | The guard uses `createRequire` to get the `child_process` CJS object. It replaces `spawn`, `spawnSync`, `exec`, `execSync`, `execFile`, `execFileSync` and `fork` with throwing `vi.fn`s, then calls `syncBuiltinESMExports()`. It is installed **before** a dynamic `import()` of the adapters, so references destructured at load time are also trapped. Test asserts zero calls. Restored in `afterAll` |

## Threat Matrix

Every row is N/A. This change adds no routing, shell, VCS, or PR automation, and no executable-file classification. The only process-related concern is the JVM, and the design forbids spawning it. The no-JVM test covers that as a tripwire.

## ADR-0015 outline (Spanish, MADR)

Context: ADR-0002 left xmlsign and qrgen pending, and the spike covered them. Decision: use xmlgen, qrgen and xmlsign (Node mode only) behind ports, with exact version pins. Where the official documents diverge, follow the runtime XSD (ADR-0012). Open questions: D7 (`dSisFact`) and D8 (two transforms), both to confirm in sifen-test and the Prevalidador. Fallback: our own signer behind `XmlSigner`. Consequences: dev certificates are generated at test time and never committed.

## Delivery

| PR | Content | Est. lines |
|---|---|---|
| PR1 | Ports + contract test + index + depcruise rule + ADR-0015 + README/0002 + plan §5.1 | ~220 |
| PR2 (chained) | `@sifen/sifen-tips` adapters, unit tests, support, e2e | ~380 (excluding lockfile) |

If PR2 exceeds 400 lines, split it: PR2a covers the adapters and unit tests, PR2b covers the e2e test and support files.

## Migration / Rollout

No migration required.

## Open Questions

- [ ] Exact xmlgen/qrgen/xmlsign call signatures. Apply confirms them from the typings. This does not block the design.
