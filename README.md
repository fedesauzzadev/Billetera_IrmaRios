# Billetera Virtual tipo MercadoPago — Spec SDD

> **Proyecto:** Billetera_IrmaRios
> **Metodología:** Spec-Driven Development (SDD)
> **Fecha:** 2026-09-18 (rev. 2026-09-19: stack Next.js didáctico + Docker gratuito)
> **Estado:** Draft v1.1
> **Idioma:** Español
> **Stack didáctico 100% gratuito:** Next.js 14 App Router (TypeScript) + PostgreSQL 16 + Redpanda (Kafka-compatible) + MongoDB 7 Community + Redis 7 / Valkey — todo dockerizado. Backend API-first listo para front en V0.

## Problema central

Asimetría lectura/escritura:

- **Lecturas (90%+):** ver saldo, ver movimientos. Requieren bajísima latencia y alta disponibilidad.
- **Escrituras (<10%):** pagar, transferir, fondear. Requieren **consistencia transaccional absoluta (ACID)** para evitar doble gasto.

## Solución propuesta (resumen)

**CQRS + Arquitectura orientada a eventos:**

- **Comandos (escritura):** Next.js Route Handlers (`POST /api/v1/transfers`) + Prisma + PostgreSQL + Idempotency-Key + Optimistic Concurrency + Patrón Outbox + Redpanda (Kafka).
- **Consultas (lectura):** Workers Node (`outbox-relay`, `balance-projector`, `history-projector`) + MongoDB desnormalizado + Redis para saldo hot.
- **Outbox didáctico:** relay por polling en TypeScript (fase 1, fácil de aprender) con opción Debezium/Kafka Connect en fase 2. Ver `apps/web/LEARN-OUTBOX-KAFKA.md`.
- **Todo dockerizado:** un solo `docker compose up` levanta PG + Redpanda + Mongo + Redis + app Next.js + workers. Nada que instalar salvo Docker. Todo OSS/gratuito.
- **Backend para V0:** API REST con OpenAPI (`apps/web/openapi.yaml`), CORS abierto a tu front V0, seed demo y colección REST. Ver `apps/web/README-BACKEND.md`.

## Estructura de la spec

```text
./
├── README.md                          <- este archivo (índice)
├── docker-compose.yml                 <- todo dockerizado: pg + redpanda + mongo + redis + nextjs + workers
├── specs/
│   └── 001-billetera-virtual/
│       ├── spec.md                    <- QUÉ se construye (requerimientos, historias, criterios)
│       ├── plan.md                    <- CÓMO se construye (Next.js + Outbox + Redpanda paso a paso)
│       ├── tasks.md                   <- Desglose ejecutable por fases
│       ├── architecture.md            <- Vista C4 + CQRS + flujos + escalabilidad
│       ├── data-model.md              <- Modelo Ledger + Outbox + Read Models + Redis (Prisma)
│       ├── api-contracts.md           <- Contratos REST + eventos Kafka + errores (listo V0)
│       ├── non-functional.md          <- NFRs, SLOs, resiliencia, seguridad, sharding
│       ├── observability-runbook.md   <- Correlación, métricas, alertas, runbooks
│       └── adr/
│           ├── ADR-001-cqrs-event-driven.md
│           ├── ADR-002-postgres-ledger.md
│           ├── ADR-003-mongo-redis-lectura.md
│           └── ADR-004-outbox-debezium-kafka.md
└── apps/
    └── web/                           <- backend Next.js (API-first para V0)
        ├── README-BACKEND.md          <- cómo levantar con Docker + cómo conecta V0
        ├── LEARN-OUTBOX-KAFKA.md      <- guía didáctica Outbox + Kafka/Redpanda
        ├── openapi.yaml               <- contrato para importar en V0
        ├── Dockerfile
        ├── package.json
        ├── prisma/schema.prisma       <- ledger + outbox + idempotencia
        ├── src/app/api/v1/...        <- Route Handlers (transfers, balance, transactions...)
        ├── src/lib/...               <- prisma, mongo, redis, kafka, utils
        ├── workers/...               <- outbox-relay + projectors (Node didáctico)
        └── scripts/...               <- seed + tests manuales
```

## Cómo usar este spec (flujo SDD)

1. Leer `specs/001-billetera-virtual/spec.md` → validar alcance y criterios de aceptación.
2. Leer `plan.md` + `architecture.md` → validar decisiones técnicas.
3. Ejecutar `tasks.md` por fases (T1 → T7). Cada tarea tiene criterio de done.
4. Usar `api-contracts.md` + `data-model.md` como contrato para implementar.
5. Usar `observability-runbook.md` para operar.

## Principios de diseño (no negociables)

1. **No doble gasto.** Toda escritura pasa por el Ledger transaccional.
2. **Idempotencia end-to-end.** `Idempotency-Key` obligatorio en POST financieros.
3. **Eventos como fuente de verdad para lectura.** Nada actualiza Mongo/Redis salvo vía Kafka.
4. **Escrituras stateless + transaccionales.** Lecturas cacheables + degradables.
5. **Observabilidad desde día 1.** `correlation_id` de Gateway a Kafka.

## Glosario rápido

| Término | Significado |
|---|---|
| Ledger | Libro contable append-only donde cada débito/crédito es inmutable |
| CQRS | Separación de modelos de escritura y lectura |
| Outbox | Tabla en la misma TX que el Ledger para publicar eventos sin dual-write |
| Idempotency-Key | UUID v4 generado por el cliente para deduplicar reintentos |
| OCC | Optimistic Concurrency Control (columna `version`) |
| Graceful Degradation | Si historial cae, saldo y pago siguen funcionando |

---
*Siguiente paso: abrir `specs/001-billetera-virtual/spec.md`.*
