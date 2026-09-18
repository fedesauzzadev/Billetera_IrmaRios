# ADR-002: PostgreSQL (u Oracle) como Ledger

**Estado:** Aceptado | **Fecha:** 2026-09-18

## Contexto
Necesitamos ACID multiobjeto (débito+crédito+outbox atómicos), constraints (`balance>=0`) y réplica sincrónica RPO=0.

## Decisión
PostgreSQL 16 (alternativa válida: Oracle) con EF Core. OCC vía `version` + `CHECK(balance>=0)` como defensa final.

## Alternativas descartadas
- Mongo/Dynamo como autoridad: sin transacciones multodocumento robustas al inicio, riesgo de doble gasto.
- MySQL async: RPO>0 inaceptable para dinero.

## Consecuencias
- (+) Garantía financiera + ecosistema (Patroni, pg_partman, Debezium).
- (−) Sharding manual futuro por hash; hot accounts requieren serialización selectiva.
