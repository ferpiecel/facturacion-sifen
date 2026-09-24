# Exploration: offline PoC with the TIPS libraries (HU-E0-04, offline part)

Spike evidence: engram `sifen/tips-libs-spike`. Decision: engram `architecture/tips-libs-decision`.

## Spike results (tech lead verified)

| Check | Result |
|---|---|
| xmlgen 1.0.283 FE tipo 1 + QR → `validateXml(…,'siRecepDE')` | Valid. `gCamFuFD` (QR) is required by `rDE`, so the QR must be added before validating |
| Signature (xmlsign 1.0.28) | exc-c14n, rsa-sha256, sha256, KeyInfo only X509Certificate, Reference URI = `#<DE Id>` |
| Transforms | 2 (enveloped-signature + exc-c14n), the same as the official example XML. NT 016 lists one (occurrence 1-1). **Open question D8** |
| dSisFact | Always emitted. NT 010 removed it, but the published DE_v150.xsd still **requires** it (1-1). **Open question D7**: follow the runtime XSD |
| QR test base URL | `https://ekuatia.set.gov.py/consultas-test/qr?` (NT 010) |
| dBasExe (NT 013), D2 test literal | Present |
| Library traits | CJS with TS types, MIT, no native deps, no network. **xmlsign shells out to a JVM unless `signByNodeJS=true`** |

## Decisions carried into the proposal

- **Ports (plan §5.1)**: `DeXmlBuilder`, `XmlSigner` and `QrGenerator` live in the framework-free contracts package `@sifen/sifen-gateway`, next to `SifenGateway`.
- **Adapters**: new package `@sifen/sifen-tips` wraps xmlgen, xmlsign (always `signByNodeJS: true`, never the JVM) and qrgen. No TIPS type leaks through the ports.
- **Offline PoC**: an end-to-end test in `@sifen/sifen-tips` that builds a test FE, signs it with a self-signed dev certificate generated at test time (never committed), adds the QR with the generic CSC (IdCSC 0001), validates it with `@sifen/sifen-xsd`, sends it through `FakeSifenGateway`, and asserts the signature structure (algorithms, KeyInfo, Reference URI).
- **ADR-0015** (amends ADR-0002): use TIPS xmlgen, qrgen and xmlsign (Node mode) behind ports. Where the official documents diverge, follow what SIFEN validates at runtime (the XSD). Record D7 and D8 for confirmation in sifen-test, and name the fallback (own signer) if the double transform is rejected.
- **Out of scope**: real SIFEN calls, setapi, KuDE, the persistence and emission use cases (E5).

## Size

About 350–500 hand-written lines → likely 2 PRs: ports + ADR, then adapters + PoC test.
