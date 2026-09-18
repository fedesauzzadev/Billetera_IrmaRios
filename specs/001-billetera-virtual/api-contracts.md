# Contratos API + Eventos (backend Next.js para V0)

Base local: `http://localhost:3000/api/v1` | Prod V0: tu URL Vercel + mismo path. Auth MVP: `Authorization: Bearer <JWT mock>` (seed imprime tokens) o `x-demo-user: <alias>` en local. CorrID: `X-Correlation-Id` (opcional, se genera si falta). CORS abierto a `*` en dev para V0. Contrato máquina: `apps/web/openapi.yaml` (importable en V0).

## 1. Convenciones

- POST financieros exigen `Idempotency-Key: <uuidv4>`.
- Errores formato RFC 7807:
  ```json { "type": "https://api.billetera.local/errors/insufficient-funds", "title": "Fondos insuficientes", "status": 422, "code": "INSUFFICIENT_FUNDS", "detail": "...", "correlation_id": "uuid" }
  ```
- Códigos: `400 VALIDATION_ERROR`, `401 UNAUTHENTICATED`, `403 FORBIDDEN|FRAUD_REJECTED`, `404 ACCOUNT_NOT_FOUND`, `409 CONCURRENT_MODIFICATION|IDEMPOTENT_IN_FLIGHT`, `422 INSUFFICIENT_FUNDS|IDEMPOTENCY_KEY_REUSE|ACCOUNT_FROZEN`, `429 RATE_LIMITED`, `503 SERVICE_UNAVAILABLE`.
- Reintento seguro solo en `409 IN_FLIGHT`, `429`, `500`, `503`. Nunca reintentar con key nueva.

## 2. Escrituras

### POST /api/v1/transfers — Transferencia P2P (Route Handler Next.js)

Headers: `Idempotency-Key*`, `X-Correlation-Id`.

```jsonc
// Request
{ "source_account_id": "uuid", "dest_alias": "irma.mp", "amount": "1500.00", "currency": "ARS", "memo": "cena" }
// 201 Response
{ "transfer_id": "uuid", "status": "COMPLETED", "amount": "1500.00", "source_balance_after": "13730.50", "created_at": "..." }
// Replay 200 + header Idempotent-Replayed: true -> mismo body original
```

### POST /api/v1/payments/qr

```jsonc
{ "source_account_id": "uuid", "qr_payload": "mp://pay/merchant123?amount=2500", "amount": "2500.00", "currency": "ARS" }
```

### POST /api/v1/topup | POST /api/v1/withdrawals

```jsonc
// topup
{ "account_id": "uuid", "amount": "5000.00", "currency": "ARS", "method": "CARD", "card_token": "tok_..." }
// estados: 202 { "operation_id": "uuid", "status": "PENDING" } -> webhook/mock completa a COMPLETED
```

## 3. Lecturas

### GET /api/v1/accounts/{id}/balance

```jsonc
// 200 (headers: X-Cache: HIT|MISS, X-Stale: true si degradado)
{ "account_id": "uuid", "balance": "15230.50", "currency": "ARS", "updated_at": "..." }
```

### GET /api/v1/accounts/{id}/transactions?cursor=&limit=20&type=

```jsonc
{
  "data": [ { "transfer_id": "uuid", "type": "P2P_OUT", "amount": "-1500.00", "counterparty": "Irma Ríos", "created_at": "..." } ],
  "next_cursor": "eyJjcmVhdGVkX2F0IjoiLi4uIn0=",
  "has_more": true
}
```

### GET /api/v1/transfers/{id}

Devuelve cabecera + ambos asientos (para conciliación y soporte).

## 4. Eventos Redpanda/Kafka (resumen, ver `LEARN-OUTBOX-KAFKA.md`)

| Tópico | Key | Uso |
|---|---|---|
| `transfer.completed.v1` | `account_id` | Actualiza Redis + Mongo |
| `topup.completed.v1` | `account_id` | Acreditación externa confirmada |
| `payment.completed.v1` | `merchant_account_id` | Pago QR + comisión |
| `account.frozen.v1` | `account_id` | Invalida caché, bloquea escritura |

Schema Registry (Avro/JSON Schema) obligatorio desde fase 2; compatibilidad BACKWARD.

## 5. Ejemplos cURL

```bash
# Transferencia idempotente
curl -X POST $BASE/v1/transfers \
 -H "Authorization: Bearer $JWT" -H "Idempotency-Key: $(uuidgen)" \
 -H "Content-Type: application/json" \
 -d '{"source_account_id":"...","dest_alias":"irma.mp","amount":"1500.00","currency":"ARS"}'

# Saldo (observa X-Cache / X-Stale)
curl -i $BASE/v1/accounts/.../balance -H "Authorization: Bearer $JWT"
```

## 6. Webhooks salientes (fase 2)

`POST {merchant_webhook}` con firma HMAC `X-Signature: sha256=...`, reintentos exponenciales 1m/5m/30m, DLQ tras 8 intentos.
