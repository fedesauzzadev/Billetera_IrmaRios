# ADR-001: CQRS + Event-Driven

**Estado:** Aceptado | **Fecha:** 2026-09-18

## Contexto
Lecturas 10-20x superiores a escrituras. Escrituras exigen ACID; lecturas exigen p95 <150ms.

## Decisión
Separar modelos: escritura en PostgreSQL transaccional, lectura en Mongo+Redis alimentados por Kafka. Ninguna lectura masiva toca el primario.

## Consecuencias
- (+) Lectura escala independiente; escritura protegida.
- (+) Evolución de vistas sin migrar ledger.
- (−) Consistencia eventual en lectura (<2s) — aceptada y comunicada en UX.
- (−) Complejidad operativa (Kafka, projectors, DLQ, reconciliación).
