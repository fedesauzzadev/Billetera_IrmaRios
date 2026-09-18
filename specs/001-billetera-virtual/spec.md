# SPEC-001: Billetera Virtual tipo MercadoPago

**Versión:** 1.1 | **Estado:** Draft | **Fecha:** 2026-09-19
**Metodología:** SDD — este documento define el QUÉ. El CÓMO está en `plan.md`.
**Restricciones didácticas del usuario:** 1) Next.js en todo lo posible (aprender), 2) todo dockerizado (solo instalar Docker), 3) backend API-first para front en V0, 4) todo gratuito/OSS.

## 1. Visión y alcance

Construir una billetera virtual con:

- Cuenta con saldo, transferencias P2P, pagos a comercios, fondeo/retiro.
- Historial de movimientos y saldo en tiempo (casi) real.
- Consistencia financiera absoluta en escrituras + lecturas masivas de baja latencia.

### In scope (MVP)

- Next.js 14 App Router (TypeScript) como backend único: Route Handlers `/api/v1/*` + middleware (auth mock, rate-limit, correlation-id) + workers Node en el mismo repo.
- Alta de cuenta billetera por usuario (1 cuenta ARS por defecto, extensible multi-moneda).
- Fondeo (mock), transferencia P2P por alias, pago QR a comercio (mock), retiro (mock).
- Consulta de saldo + historial paginado + detalle de movimiento.
- Idempotencia, ledger ACID (Prisma + PostgreSQL), proyección a lectura vía Outbox Relay didáctico → Redpanda (Kafka) → Mongo + Redis.
- Todo levantable con `docker compose up` (Postgres 16-alpine, Redpanda, Mongo 7, Redis 7, app). Sin Oracle, sin cloud pago, sin K8s obligatorio.
- Contrato OpenAPI + CORS + seed para conectar front V0.
- Observabilidad base didáctica (logs JSON con correlation_id, endpoint `/api/health`, métricas mínimas).

### Out of scope (fase 2)

- Rendimientos/inversiones, cripto, préstamos, multi-moneda real, conciliación bancaria real, KYC biométrico, backoffice admin.
- Front en este repo (lo harás en V0 contra este backend).
- Debezium/Kafka Connect, Kubernetes/OpenShift, Oracle, gateway pago (Kong/APIM): se documentan como evolución, no MVP.

## 2. Usuarios y actores

| Actor | Descripción |
|---|---|
| Titular | Persona con cuenta que consulta saldo/movimientos y ordena pagos |
| Comercio | Receptor de pagos QR, con liquidación en su cuenta |
| Sistema antifraude (stub) | Scoring síncrono/async de riesgo antes de confirmar |
| Banco/Procesador (mock) | Fondeo/retiro externo simulado |
| Operador/SRE | Monitorea SLOs, ejecuta runbooks |

## 3. Historias de usuario (con criterios de aceptación)

### HU-01 — Ver saldo
**Como** titular **quiero** ver mi saldo en <200ms p95 **para** decidir si pago.
- CA1: `GET /v1/accounts/{id}/balance` responde desde Redis si hay hit, sino desde MongoDB y repuebla caché.
- CA2: Si MongoDB cae, responde último saldo cacheado con header `X-Stale: true` (degradación elegante).
- CA3: Nunca calcula saldo con SUM en caliente; usa snapshot + proyección.

### HU-02 — Ver movimientos
**Como** titular **quiero** ver mis últimos movimientos paginados.
- CA1: `GET /v1/accounts/{id}/transactions?cursor=&limit=` paginación por cursor, orden desc.
- CA2: Latencia p95 <300ms. Si servicio de historial cae, saldo y pagos siguen operativos.
- CA3: Cada ítem muestra lo que la app necesita sin JOINs (modelo desnormalizado).

### HU-03 — Transferir P2P (CRÍTICA)
**Como** titular **quiero** transferir a otro usuario sin riesgo de doble débito.
- CA1: `POST /v1/transfers` exige `Idempotency-Key: <uuidv4>`. Reintento con misma key → misma respuesta, sin segundo débito (código 200 + header `Idempotent-Replayed: true`).
- CA2: Fondos insuficientes → 422 `INSUFFICIENT_FUNDS`, sin cambios en ledger.
- CA3: Dos débitos concurrentes sobre mismo saldo usan OCC: uno gana, otro reintenta o falla con 409 `CONCURRENT_MODIFICATION`.
- CA4: La operación es atómica: o se persisten débito+crédito+outbox, o nada.
- CA5: Evento `TransferCompleted` publicado exactamente-una-vez-efectiva vía Outbox+Kafka.

### HU-04 — Pagar a comercio (QR)
Igual que HU-03 + comisión opcional. Requiere idempotencia y atomicidad. Error de fraude → 403 `FRAUD_REJECTED`.

### HU-05 — Fondear cuenta
**Como** titular quiero ingresar dinero desde tarjeta.
- CA1: Idempotente. Estados: `PENDING → COMPLETED | FAILED`.
- CA2: Nunca acredita sin confirmación del procesador (mock).

### HU-06 — Retirar dinero
Igual que fondeo pero débito. Requiere saldo suficiente + OCC.

## 4. Requerimientos funcionales

| ID | Requerimiento |
|---|---|
| RF-01 | Ledger append-only: todo movimiento es un asiento débito/crédito inmutable, nunca UPDATE/DELETE |
| RF-02 | Idempotencia en todos los POST financieros (`Idempotency-Key` persistido con TTL + respuesta cacheada) |
| RF-03 | Concurrencia optimista en cuentas (`version` incrementa por TX) |
| RF-04 | Patrón Outbox transaccional (Prisma TX + tabla `outbox`) con relay didáctico por polling → Redpanda |
| RF-05 | Proyección eventual a MongoDB + Redis vía consumidores `kafkajs` idempotentes |
| RF-06 | Paginación por cursor en historial, filtros por tipo/fecha/estado |
| RF-07 | Auth mock JWT local (didáctico, sin IdP pago) + autorización por dueño de cuenta |
| RF-08 | Rate limiting en middleware Next.js (Memoria/Redis, sin gateway pago) |
| RF-09 | Trazabilidad con `X-Correlation-Id` propagado a logs, DB y headers Redpanda |
| RF-10 | Backend API-first V0: OpenAPI `openapi.yaml`, CORS, seed demo, `docker compose up` único |

## 5. Requerimientos no funcionales (resumen, detalle en `non-functional.md`)

| ID | NFR | Objetivo |
|---|---|---|
| NFR-01 | Latencia lectura saldo | p95 <150ms (hit Redis), <300ms (miss) |
| NFR-02 | Latencia escritura | p95 <800ms end-to-end (sin antifraude externo lento) |
| NFR-03 | Disponibilidad | 99.9% lectura, 99.95% escritura core |
| NFR-04 | Consistencia | Fuerte en escritura (ACID), eventual <2s en lectura |
| NFR-05 | Throughput | 5k escrituras/s sostenidas, 50k lecturas/s pico |
| NFR-06 | Durabilidad | RPO=0 en ledger (replicación sincrónica), RTO<5min |
| NFR-07 | Escalabilidad | Servicios stateless, HPA por CPU/lag Kafka |
| NFR-08 | Seguridad | OWASP ASVS L2, secretos en vault, PII cifrada |

## 6. Reglas de negocio críticas

1. `saldo >= 0` siempre. Constraint CHECK en DB + validación en servicio.
2. `monto > 0`, moneda soportada, `origen != destino`.
3. Débito y crédito del mismo `transfer_id` comparten `atomic_batch_id`.
4. Ningún saldo se deriva de agregaciones en request path; se mantiene `accounts.balance` + `version` como snapshot transaccional.
5. Reintentos del cliente deben reutilizar la misma `Idempotency-Key` (el SDK la genera una vez).

## 7. Criterios de aceptación global (Definition of Done del MVP)

- [ ] Doble POST con misma key → un solo asiento contable (test de doble-clic + test de reintento de red).
- [ ] 100 transferencias concurrentes sobre saldo 1000 con monto 20 → exactamente 50 OK + 50 con 422/409, saldo final 0, suma débitos = suma créditos.
- [ ] Kill del broker a mitad de TX → al recuperarse, el evento aparece en Kafka (outbox) y Mongo/Redis convergen <5s.
- [ ] Caída de MongoDB → saldo sigue servido desde Redis con `X-Stale`.
- [ ] p95 saldo <150ms con 10k rps en prueba de carga (k6).
- [ ] `correlation_id` visible de extremo a extremo en trace.

## 8. Supuestos y riesgos

| Supuesto / Riesgo | Mitigación |
|---|---|
| Relojes desincronizados | Usar `created_at` del Ledger (DB clock) como orden canónico |
| Hot account (comercio grande) | Particionamiento por hash + cola por cuenta + OCC con backoff |
| Dual-write DB→Kafka | Prohibido; solo Outbox + relay polling (fase 1) → Debezium opcional (fase 2) |
| Consumidor duplica evento | Consumidores idempotentes por `event_id` (upsert + tabla processed_events) |
| Fraude | Stub local en Next.js con timeout + breaker simple; rechazo no debita |
| Aprender Next.js | Route Handlers + Server Components didácticos, comentarios `LEARN:` en código, guía `LEARN-OUTBOX-KAFKA.md` |
| Costo | Todo OSS local: Next.js, Prisma, PG, Redpanda, Mongo Community, Redis. Cero servicios pago |
