# ADR-003: MongoDB + Redis para lectura

**Estado:** Aceptado | **Fecha:** 2026-09-18

## Contexto
La app abre saldo/historial constantemente. JOINs o SUM en caliente colapsan en picos.

## Decisión
- MongoDB: documentos desnormalizados con el formato exacto de la app (cero JOINs).
- Redis: saldo de cuentas hot en memoria, TTL + actualización por evento con árbitro `version`.

## Consecuencias
- (+) p95 <150ms, absorbe 10x tráfico sin tocar PG.
- (+) Degradación elegante (stale) si Mongo cae.
- (−) Doble almacenamiento + necesidad de reconciliación periódica PG↔Mongo↔Redis.
