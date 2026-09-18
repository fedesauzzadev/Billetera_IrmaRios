# No funcionales, SLOs, resiliencia y despliegue (Docker local gratuito)

> MVP local: objetivos didácticos, no 99.99%. K8s/Prometheus como fase 2 documentada.

## 1. SLOs / SLIs

| SLI | SLO | Ventana |
|---|---|---|
| Disponibilidad lectura (saldo) | 99.9% | 30d |
| Disponibilidad escritura (transfer) | 99.95% | 30d |
| Latencia saldo (hit Redis) | p95 <150ms | 7d |
| Latencia saldo (miss) | p95 <300ms | 7d |
| Latencia transferencia | p95 <800ms | 7d |
| Frescura lectura (evento→visible) | p95 <2s | 7d |
| Tasa error 5xx escritura | <0.5% | 7d |
| Hit-rate Redis saldo | >85% | 7d |
| Lag Kafka projector | p95 <2000 msgs | 5m |

Error budget: si se quema >50% en 7d → congelar features, solo reliability.

## 2. Throughput y capacidad (MVP → Hot Sale)

| Escenario | Escrituras/s | Lecturas/s | Plan |
|---|---|---|---|
| Normal | 500 | 5k | 3 réplicas TX, 5 query, PG 4vCPU/16GB |
| Pico Hot Sale | 5k | 50k | HPA x5, pre-warm Redis top 100k cuentas, PG 16vCPU + réplica sync |
| Hot account | 200/s misma cuenta | — | Serialización por cuenta + OCC backoff 10-50ms |

Pruebas k6: `saldo.js` (10k rps), `transfer.js` (1k rps, keys únicas), `contencion.js` (100 hilos, misma cuenta).

## 3. Resiliencia (patrones obligatorios)

- **Timeout:** fraude 300ms, Mongo 200ms, Redis 100ms, PG statement_timeout 2s.
- **Circuit Breaker (Polly):** 20% fallos en 30s → abre 30s → half-open 5 req.
- **Bulkhead:** pools separados: PG write (50), PG read (20), Mongo (100), Redis (200).
- **Rate limit Gateway:** 20 escrit/min + 200 lect/min por usuario; 1000 rps global con burst; 429 + `Retry-After`.
- **Load shedding:** si CPU TX >85% 2m → 503 con `Retry-After: 5` antes que OOM.
- **DLQ:** eventos que fallan 5x van a `*.dlq.v1` con reintento manual y replay tool.

## 4. Sharding y particionamiento

- **PostgreSQL:** partición por `hashtext(account_id::text) % 16`. Script de re-balance. Futura migración a Citus si >1B filas.
- **Kafka:** 12 particiones mínimo en tópicos hot; key=`account_id`.
- **MongoDB:** shard `{account_id:1}`; chunks pre-divididos para top merchants.
- **Redis:** cluster 3+3; `maxmemory-policy noeviction` para saldos (evicción solo por TTL) + memoria separada para sesiones.

## 5. Seguridad

- OWASP ASVS L2: validación estricta (`amount` decimal string, no float), JWT RS256 (`exp` 15m + refresh), scope `wallet:write`.
- PII (email, alias, CVU) cifrada AES-256-GCM a nivel columna; claves en Vault.
- Auditoría append-only `audit_log (who, what, account, corrID, at)`.
- Pentest + `npm audit`/`dotnet list package --vulnerable` en CI; imágenes firmadas (cosign).

## 6. Despliegue (K8s / OpenShift)

- Stateless + probes: `liveness /healthz`, `readiness /readyz` (chequea PG+Kafka+Redis según rol).
- PDB `minAvailable: 2` para TX y projectors; `RollingUpdate maxUnavailable: 1`.
- HPA ejemplo:
  ```yaml
  # transaction-service: CPU 60% + p95 http >600ms (custom metric)
  # projectors (KEDA): kafka lag >1000
  minReplicas: 3  # TX
  maxReplicas: 20
  ```
- Migraciones EF reversibles + expand/contract para cambios ledger; deploy canary 10→50→100% (Argo Rollouts).
- Backups: PG PITR (WAL-G, RPO=0 sync), Mongo snapshot 6h, Redis RDB+AOF (reconstruible desde Kafka replay de todos modos).

## 7. Costos y trade-offs

- Redis Cluster es el mayor costo fijo → justificado por p95 y por absorber 10x lecturas sin escalar PG.
- Mongo desnormalizado duplica almacenamiento (~2.5x) → ahorra JOINs y protege al primario.
- Debezium añade latencia ~100-300ms a la proyección → aceptable frente a garantía de no-pérdida.
