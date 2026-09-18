# TASKS-001: Plan ejecutable por fases (Next.js + Docker gratuito + V0)

> Marca `[x]` al completar. Todo con `docker compose up`. Backend API-first para V0.

## Fase T1 — Ledger + idempotencia en Next.js (núcleo financiero)

- [ ] **T1.1** Prisma schema: `accounts`, `ledger_entries`, `transfers`, `outbox`, `idempotency_keys` + constraints + índices. `npx prisma migrate dev`.
      DoD: `docker compose up postgres` + migraciones en limpio; `CHECK(balance>=0)` rechaza saldo negativo.
- [ ] **T1.2** `POST /api/v1/transfers` (Route Handler) con `Idempotency-Key` obligatorio.
      DoD: doble POST misma key → 1 débito (script `scripts/test-idempotency.sh`).
- [ ] **T1.3** OCC (`version`) + 409 + reintento con backoff simple (sin Polly, helper TS).
      DoD: 50 transferencias concurrentes (script k6 o `scripts/concurrency.js`) sin doble gasto.
- [ ] **T1.4** Outbox en la misma TX Prisma + `workers/outbox-relay.ts` polling a log (sin Redpanda aún).
      DoD: kill a mitad de TX no deja evento huérfano ni TX sin evento. Leer `LEARN-OUTBOX-KAFKA.md`.

## Fase T2 — Outbox → Redpanda → proyección (corazón didáctico)

- [ ] **T2.1** Redpanda en compose + tópicos `transfer.completed.v1`, `topup.completed.v1`, `payment.completed.v1` (auto-create, key=`account_id`).
      DoD: `docker compose up` levanta PG+Redpanda+app y `rpk topic list` muestra tópicos.
- [ ] **T2.2** `workers/outbox-relay.ts`: `SELECT ... WHERE dispatched_at IS NULL FOR UPDATE SKIP LOCKED` → publish kafkajs → `UPDATE dispatched_at`.
      DoD: `docker stop redpanda` 30s → al volver, pendientes se publican (ver `LEARN-OUTBOX-KAFKA.md` § por qué no dual-write).
- [ ] **T2.3** `workers/balance-projector.ts`: consume, upsert idempotente a Redis+Mongo por `event_id`.
      DoD: reprocesar mismo evento 3x → un solo efecto.
- [ ] **T2.4** `workers/history-projector.ts`: documento desnormalizado en Mongo listo para V0.
      DoD: `GET /api/v1/.../transactions` responde sin JOINs.

## Fase T3 — Lecturas + degradación (para V0)

- [ ] **T3.1** `GET /api/v1/accounts/{id}/balance` (Redis→Mongo→stale + headers `X-Cache`/`X-Stale`).
      DoD: V0 muestra saldo; `docker stop mongo` → sigue con stale.
- [ ] **T3.2** `GET /api/v1/accounts/{id}/transactions` paginado por cursor.
      DoD: V0 lista historial con `next_cursor`.
- [ ] **T3.3** Breaker/timeout simple en Route Handlers + fallback.
      DoD: con Mongo caído, saldo responde stale y pago sigue OK.

## Fase T4 — Borde: middleware + seed + OpenAPI V0

- [ ] **T4.1** `src/middleware.ts`: JWT mock, rate limit, `X-Correlation-Id`.
      DoD: sin token → 401 (o bypass mock documentado); exceso → 429; corrID en logs.
- [ ] **T4.2** Logs JSON + `/api/health` (pg, redpanda, mongo, redis) + `openapi.yaml` + CORS para V0.
      DoD: importar `openapi.yaml` en V0 y listar saldo/historial contra `http://localhost:3000`.
- [ ] **T4.3** Seed demo (`scripts/seed.ts`: 2 usuarios + alias + saldo) + colección REST `scripts/requests.http`.
      DoD: `npm run seed` deja cuentas listas para V0.

## Fase T5 — Fondeo / pago QR / retiro (mock local)

- [ ] **T5.1** `POST /api/v1/topup`, `/api/v1/payments/qr`, `/api/v1/withdrawals` idempotentes.
      DoD: flujo fondeo→transfer→pago→retiro funciona desde V0 o `requests.http`.
- [ ] **T5.2** Antifraude stub local + timeout 300ms.
      DoD: rechazo → 403 sin débito.

## Fase T6 — Endurecimiento didáctico local

- [ ] **T6.1** Pruebas manuales: doble-clic, `docker stop redpanda/mongo/redis`, contención misma cuenta.
      DoD: checklist en `README-BACKEND.md` pasa.
- [ ] **T6.2** Particiones Redpanda (6) + key `account_id` + DLQ `*.dlq.v1`.
      DoD: script muestra cuentas distintas en particiones distintas (`rpk`).
- [ ] **T6.3** Límites CPU/mem en compose + probes `/api/health` + restart policies.
      DoD: `docker compose ps` todo `healthy`.

## Fase T7 — Release MVP

- [ ] **T7.1** Runbooks (ver `observability-runbook.md`) + rollback por migraciones reversibles.
      DoD: deploy canary 10% → 50% → 100% sin errores 5xx >0.5%.
- [ ] **T7.2** Checklist entrevista/demo: doble-clic, reintento de red, Hot Sale simulado, caída de historial.
      DoD: demo de 10 min pasa sin intervención manual.

---

### Matriz de trazabilidad (historia → tareas)

| HU | Tareas |
|---|---|
| HU-01 saldo | T2.3, T3.1, T4.1 |
| HU-02 historial | T2.4, T3.2, T3.3 |
| HU-03 transferencia | T1.1–T1.4, T2.1–T2.2 |
| HU-04 pago QR | T5.1–T5.2 |
| HU-05/06 fondeo/retiro | T5.1 |
