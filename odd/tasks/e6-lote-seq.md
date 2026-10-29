# e6-lote-seq: orden de lotes sin depender del reloj

Objetivo: el orden y la propiedad de los documentos entre lotes (`stillCarries`, `recoverableInLote`, ensamblado) no
dependen del reloj de la base de datos; si el reloj retrocede, un documento no se atribuye al lote equivocado
(ADR-0007/0008, hardening E6; PR #264 corrigió solo el caso del lote viejo). El reloj sigue valiendo para plazos (72 h, 48 h).

Diseño: `lotes.seq` (identity, backfill por `created_at,id`) y `documents.resent_after_seq` (marca de agua que fija un
trigger al estampar `resent_at`: el mayor `seq` de los lotes que llevan el documento; inmutable). Un lote con
`seq <= resent_after_seq` ya dejó atrás el documento.

TDD: Vitest (`pnpm exec vitest run`), strict, fuente: openspec/config.yaml. Delegación: inline (un solo escritor, 1 PR).

## Tareas
- [x] T1 RED: tests de skew (lote viejo adelantado, lote nuevo con `created_at` retrocedido) en assembly y recovery store. Ruta: inline.
- [x] T2 Migración 0070 (seq, resent_after_seq, trigger, backfill, rollback) + `packages/db/test/lote-seq.spec.ts`; RLS coverage verde.
- [x] T3 GREEN: `stillCarries` y `recoverableInLote` por secuencia; el estampado ya no usa `greatest(now(), ...)`.
- [ ] T4 verify + push + PR.

## Checks
`vitest run src/modules/transmission` (495 pass), `packages/db` lote-seq + rls-coverage, `pnpm verify` en el push.

## Notas
Fuera de alcance: los `orderBy(createdAt/updatedAt)` de selección de trabajo (equidad, no propiedad) y los plazos.
