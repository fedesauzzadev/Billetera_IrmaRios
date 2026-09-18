# Backend Billetera — Next.js + Docker (gratuito) — listo para V0

## 0. Solo necesitas instalar
- **Docker Desktop** (único requisito). Node 20 solo si quieres correr fuera de Docker.

## 1. Levantar todo (1 comando)
```bash
cp apps/web/.env.example apps/web/.env
docker compose up --build
# App: http://localhost:3000/api/health
# Redpanda Console (ver eventos Kafka): http://localhost:18080
# (puertos host 5544 PG / 6381 Redis / 18080-18082 Redpanda: los estándar están ocupados por otros proyectos)
```

## 2. Seed demo (IDs para V0)
```bash
docker compose exec app npm run seed
# Anota: irma.mp -> <id1>, juan.mp -> <id2>
```

## 3. Probar API (o importar en V0)
- Contrato: `apps/web/openapi.yaml` (importar como OpenAPI en V0).
- Base URL en V0: `http://localhost:3000/api/v1` (o tu deploy).
- Env V0 sugerida: `NEXT_PUBLIC_API_URL=http://localhost:3000/api/v1`.
```bash
# Transferencia (reemplaza IDs y genera key nueva por intento)
curl -X POST localhost:3000/api/v1/transfers \
 -H "Content-Type: application/json" -H "Idempotency-Key: $(uuidgen || cat /proc/sys/kernel/random/uuid)" \
 -d '{"source_account_id":"<id-irma>","dest_alias":"juan.mp","amount":"1500.00","currency":"ARS"}'
# Saldo (mira X-Cache / X-Stale)
curl -i localhost:3000/api/v1/accounts/<id-irma>/balance
# Historial
curl localhost:3000/api/v1/accounts/<id-irma>/transactions?limit=20
```

## 4. Cómo conecta tu front V0 (3 pasos)
1. En V0: `NEXT_PUBLIC_API_URL=http://localhost:3000/api/v1`.
2. `fetch(`${API}/accounts/${id}/balance`)` y `fetch(..., {method:"POST", headers:{"Idempotency-Key": crypto.randomUUID()}, body})`.
   - **Regla de oro:** genera la key UNA vez por pago (useRef) y reúsala en reintentos.
3. Para deploy: sube `apps/web` a Vercel (gratis) + Neon/Supabase PG gratis + Upstash Redis/Mongo Atlas gratis; Redpanda -> Upstash Kafka gratis. Cambia solo envs.

## 5. Aprender Next.js aquí (didáctico)
- `src/app/api/v1/transfers/route.ts` = escritura + Prisma TX + outbox (lee los `LEARN:`).
- `src/app/api/v1/accounts/[id]/balance/route.ts` = lectura Redis→Mongo→stale.
- `src/middleware.ts` = mini-gateway (rate-limit + corrID).
- `workers/outbox-relay.ts` = polling Outbox→Redpanda (empieza por `LEARN-OUTBOX-KAFKA.md`).
- `prisma/schema.prisma` = ledger append-only + `version` OCC.

## 6. Troubleshooting
- `docker compose logs -f outbox-relay` si no llegan eventos. `rpk topic list --brokers localhost:19092` (o Console :8080).
- PG: `docker compose exec postgres psql -U billetera -c "SELECT count(*), min(created_at) FROM outbox WHERE dispatched_at IS NULL"`.
- Reset total: `docker compose down -v && docker compose up --build`.

## 7. Túnel Cloudflare rápido (exponer `localhost:3000` a V0)

> El túnel es efímero: cada vez que se reinicia cambia la URL. Después de levantarlo,
> actualiza `NEXT_PUBLIC_API_URL` en V0 con la URL nueva.

```powershell
# 1. Matar túnel viejo si quedó colgado (terminal cerrada, etc.)
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force

# 2. Levantar túnel en segundo plano (log a archivo para no perder la URL)
$cf="$env:TEMP\opencode\cloudflared.exe"
$err="$env:TEMP\opencode\cloudflared-billetera.err"
Remove-Item $err -ErrorAction SilentlyContinue
Start-Process -FilePath $cf -ArgumentList "tunnel --url http://localhost:3000" -RedirectStandardError $err -WindowStyle Hidden

# 3. Esperar y ver la URL pública (copiar/pegar en V0)
Start-Sleep 12
Select-String "https://.*trycloudflare.com" $err | Select-Object -Last 1

# 4. Verificar que responde
Invoke-RestMethod -Uri "<PEGA-LA-URL>/api/health" -TimeoutSec 20 | ConvertTo-Json
```

**Qué pedirle a tu LLM** (copiar/pegar en el chat):

> Levanta el túnel Cloudflare local con la sección 7 de `apps/web/README-BACKEND.md` y pasame la URL pública nueva para poner en V0 como `NEXT_PUBLIC_API_URL=<URL>/api/v1`.
