-- 004_dividend_clave: la clave natural de DIVIDEND pasa de (security_id, ex_date, period) NULLS NOT DISTINCT
-- a (security_id, ex_date). Decisión: docs/modelo/decisiones-modelo.md §5.5 (propuesta P5).
-- period es una etiqueta del proveedor que puede completarse más tarde (viene NULL en 10-56 % de las filas),
-- así que no puede formar parte de la clave: si cambiara, el dividendo duplicaría fila.
-- Dos dividendos con la misma fecha ex no caben: el escritor (Fase 3) no escribe esa fecha y emite
-- DIVIDEND_SAME_EX_DATE. La 003 ya estaba publicada, por eso el cambio va en una migración nueva.
ALTER TABLE dividend DROP CONSTRAINT dividend_security_id_ex_date_period_key;
ALTER TABLE dividend ADD CONSTRAINT dividend_security_id_ex_date_key UNIQUE (security_id, ex_date);
