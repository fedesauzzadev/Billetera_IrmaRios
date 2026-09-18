# Modelo de datos — Write + Read (Next.js + Prisma + Docker gratuito)

> Implementación: `apps/web/prisma/schema.prisma` (PostgreSQL). Read models en Mongo/Redis vía workers. Bus: Redpanda (Kafka API).

## 1. Write Model — PostgreSQL (autoridad financiera)

### 1.1 `accounts` (snapshot transaccional, no calculado)

```sql
CREATE TABLE accounts (
  id            UUID PRIMARY KEY,
  user_id       UUID NOT NULL UNIQUE,
  currency      CHAR(3) NOT NULL DEFAULT 'ARS',
  balance       NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  status        TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','FROZEN','CLOSED')),
  version       BIGINT NOT NULL DEFAULT 0,          -- OCC
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON accounts (user_id);
```

> `balance` es snapshot mantenido por TX. Jamás se deriva con SUM en request path.

### 1.2 `transfers` (cabecera de la operación atómica)

```sql
CREATE TABLE transfers (
  id              UUID PRIMARY KEY,
  source_account  UUID NOT NULL REFERENCES accounts(id),
  dest_account    UUID NOT NULL REFERENCES accounts(id),
  amount          NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  currency        CHAR(3) NOT NULL,
  status          TEXT NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('PENDING','COMPLETED','FAILED')),
  idempotency_key UUID NOT NULL,
  correlation_id  UUID NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (source_account <> dest_account)
);
```

### 1.3 `ledger_entries` (append-only, inmutable)

```sql
CREATE TABLE ledger_entries (
  entry_id      BIGGENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transfer_id   UUID NOT NULL REFERENCES transfers(id),
  account_id    UUID NOT NULL REFERENCES accounts(id),
  direction     TEXT NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount        NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  balance_after NUMERIC(18,2) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON ledger_entries (account_id, entry_id DESC);
-- Prohibido UPDATE/DELETE vía trigger o RLS (solo INSERT + SELECT).
```

### 1.4 `outbox` (patrón transaccional)

```sql
CREATE TABLE outbox (
  event_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate     TEXT NOT NULL,          -- 'transfer'
  aggregate_id  UUID NOT NULL,          -- transfer_id
  topic         TEXT NOT NULL,          -- 'transfer.completed.v1'
  payload       JSONB NOT NULL,
  headers       JSONB NOT NULL DEFAULT '{}',  -- correlation_id, causation_id
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  dispatched_at TIMESTAMPTZ NULL
);
CREATE INDEX ON outbox (dispatched_at, created_at) WHERE dispatched_at IS NULL;
```

### 1.5 `idempotency_keys`

```sql
CREATE TABLE idempotency_keys (
  key           UUID PRIMARY KEY,
  account_id    UUID NOT NULL,
  request_hash  TEXT NOT NULL,          -- hash del body para detectar reuso indebido
  status        TEXT NOT NULL DEFAULT 'IN_PROGRESS' CHECK (status IN ('IN_PROGRESS','COMPLETED','FAILED')),
  response_code INT NULL,
  response_body JSONB NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '24 hours'
);
```

**Regla:** misma key + distinto `request_hash` → 422 `IDEMPOTENCY_KEY_REUSE`.

### 1.6 Ejemplo de TX (OCC)

```sql
BEGIN;
-- 1. Idempotencia
INSERT INTO idempotency_keys(key, account_id, request_hash)
VALUES (:k, :src, :h) ON CONFLICT (key) DO NOTHING RETURNING *;
-- si conflicto y COMPLETED -> devolver response_body cacheada.

-- 2. OCC débito
UPDATE accounts SET balance = balance - :m, version = version + 1, updated_at = now()
WHERE id = :src AND version = :v_src AND balance >= :m AND status='ACTIVE';
-- rowcount 0 -> 422 sin fondos o 409 versión (discriminar con SELECT previo).

-- 3. OCC crédito
UPDATE accounts SET balance = balance + :m, version = version + 1, updated_at = now()
WHERE id = :dst AND version = :v_dst AND status='ACTIVE';

-- 4. Cabecera + asientos + outbox
INSERT INTO transfers ...;
INSERT INTO ledger_entries ... (DEBIT balance_after), (CREDIT balance_after);
INSERT INTO outbox (aggregate, aggregate_id, topic, payload, headers) VALUES (...);
UPDATE idempotency_keys SET status='COMPLETED', response_code=201, response_body=:json WHERE key=:k;
COMMIT;
```

## 2. Read Model — MongoDB (desnormalizado para la app)

### 2.1 `account_views` (un doc por cuenta)

```jsonc
{
  "_id": "acc_123",
  "account_id": "uuid",
  "balance": 15230.50,
  "currency": "ARS",
  "version": 418,              // última version proyectada (arbitra orden)
  "updated_at": "2026-09-18T12:00:00Z",
  "recent": [                  // últimos 20, embebidos para primera pantalla
    { "transfer_id": "uuid", "type": "P2P_OUT", "counterparty": "Irma Ríos", "amount": -1500.00, "created_at": "..." }
  ]
}
```

### 2.2 `movements` (historial completo, shard por account_id)

```jsonc
{
  "_id": "uuid (transfer_id + account_id)",
  "account_id": "uuid",
  "transfer_id": "uuid",
  "type": "P2P_IN | P2P_OUT | TOPUP | QR_PAY | WITHDRAWAL",
  "amount": -1500.00,          // signado para la vista
  "balance_after": 15230.50,
  "counterparty": { "name": "Irma Ríos", "alias": "irma.mp" },
  "event_id": "uuid",          // deduplicación projector
  "created_at": "2026-09-18T12:00:00Z"
}
```

Índices: `{account_id:1, created_at:-1}`, `{event_id:1}` unique.

## 3. Caché — Redis (saldo hot)

```text
KEY  balance:{account_id}
VAL  JSON { "balance": 15230.50, "version": 418, "updated_at": "..." }
TTL  120s (refrescado por evento)
```

Actualización por evento (Lua, solo si version mayor):

```lua
local cur = redis.call('GET', KEYS[1])
if cur then
  local c = cjson.decode(cur)
  if tonumber(c.version) >= tonumber(ARGV[2]) then return 0 end
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', 120)
return 1
```

## 4. Eventos Kafka

**`transfer.completed.v1`** (key = `source_account` o `account_id` afectado; se emiten 2 proyecciones o un evento con ambos lados):

```jsonc
{
  "event_id": "uuid",
  "event_type": "transfer.completed.v1",
  "occurred_at": "2026-09-18T12:00:00Z",
  "transfer_id": "uuid",
  "currency": "ARS",
  "amount": "1500.00",
  "source": { "account_id": "uuid", "balance_after": "13730.50", "version": 419 },
  "destination": { "account_id": "uuid", "balance_after": "21000.00", "version": 88 },
  "correlation_id": "uuid",
  "idempotency_key": "uuid"
}
```

Headers Kafka: `correlation_id`, `event_id`, `content-type=application/json`.

**Reglas projector:** upsert por `event_id` en `processed_events`; `version` como árbitro (ignorar si menor); commit offset solo tras persistir.

## 5. Sharding

- **PG:** hash(`account_id`) % 16 particiones (pg_partman). Todas las filas de una transferencia comparten partición lógica si se colocalizan por `source_account` (diseño futuro Citus colocation).
- **Kafka:** 12+ particiones, `key=account_id` → orden por cuenta.
- **Mongo:** shard key `{account_id:1, created_at:-1}`.
- **Redis:** cluster, slot por `balance:{id}`.
