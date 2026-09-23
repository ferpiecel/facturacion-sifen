# Exploration: SIFEN gateway port and in-process fake (HU-E0-05)

Background research: engram `sdd/f0-sifen-mock-xsd/explore`.

## Decisions carried into the proposal (tech lead)

- **Scope of HU-E0-05 in this change**: the `SifenGateway` port contract and a deterministic in-process fake (`FakeSifenGateway`) with configurable scenarios that return the real SIFEN codes. The HTTP SOAP mock in docker-compose is deferred until a real SOAP adapter exists to test against (E6). HU-E0-05 remains partially delivered.
- **Port source**: `docs/plan/plan-desarrollo-v1.1.md` §5.1 defines six operations: `enviarLote` (0300/0301), `consultarLote` (0360/0361/0362/0364), `enviarDESincronico`, `consultarDE` (0420/0422), `enviarEventos` (≤ 15), and `consultarRUC`.
- **Placement**: a new framework-free package `packages/sifen-gateway`, exporting the port interface, result types, response codes and the fake. It is shared because both `apps/api` and the future `apps/workers` (transmission, ADR-0007) consume it. It must not depend on NestJS or any other framework, so hexagonal `application/` layers can import it (ADR-0003).
- **Fake behavior**: scenario-driven per call (approve, reject with a code and message, lote still processing 0361, lote does not exist 0360, lote not queued 0301, RUC blocked, timeout, and a transport error). The fake records calls so tests can assert on them. It is deterministic, with no timers and no real sleeping; a timeout is simulated by a rejected promise of a typed error.
- **Codes**: take them from the Manual Técnico v150 and the Guía de Mejores Prácticas 2024. Only cite codes verifiable in `docs/referencia/dnit/` text; if a code's meaning is uncertain, leave it out.

## Size

About 250–350 hand-written lines. Split the port and types from the fake if the budget is exceeded.

## Risks

- The port shape in the plan uses Spanish names and `bigint` `dId`. Keep the plan's names, since the domain language is Spanish, SIFEN terms included.
- The codes in the plan must match the official documents. Verify them against the MT text before coding them.

## Verified response codes (orchestrator, from MT v150 and Guía de Mejores Prácticas 2024 text)

| Code | Meaning | Operation |
|---|---|---|
| 0300 | Lote recibido con éxito (dCodRes=0300) | enviarLote |
| 0301 | Lote no encolado para procesamiento; the lote will NOT be processed (see "Lote no encolado" in the Guía 2024) | enviarLote |
| 0360 | Número de lote inexistente | consultarLote |
| 0361 | Lote en procesamiento | consultarLote |
| 0362 | Procesamiento de lote concluido; the response carries per-DE results (gResProc, 1–100) | consultarLote |
| 0364 | Consulta extemporánea de lote: queries are allowed up to 48 h after sending | consultarLote |
| 0420 | CDC inexistente (also returned when the certificate's RUC lacks permission) | consultarDE |
| 0422 | CDC encontrado | consultarDE |
| 0260 | Autorización del DE satisfactoria (sync reception) | enviarDESincronico |
| 0160 | XML malformado (generic input validation) | any |

Plain-text sources for sub-agents: the scratchpad extractions `Manual Técnico Versión 150.pdf.txt` and `guia-mejores-practicas-envio-de-2024-10.pdf.txt`. The originals are in `docs/referencia/dnit/`.
