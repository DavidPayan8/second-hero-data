-- 014: fx_rates.rate_to_base -> units_per_base (decisiones-modelo.md §6.b, 2026-10-13).
-- La columna guarda ahora la cotización EURxxx del proveedor TAL CUAL: unidades de la divisa por 1 EUR (EURUSD.FOREX ~ 1,12
-- -> USD guarda 1,12; GBX = cotización EURGBP x 100, peniques por 1 EUR). Convertir una cantidad a EUR = DIVIDIR por
-- units_per_base. Antes se guardaba 1 / cierre, un derivado que en numeric redondea y ya no coincide con el payload.
-- EUR (la base) no tiene filas: el materializador usa factor 1 para currency = base.
-- Las filas existentes (si las hay) eran 1 / cierre y no se pueden reconstruir sin redondeo: se borran. Son un hecho
-- derivado de raw_payload y se regeneran con `npm run replay -- --all` (sin red).
DELETE FROM fx_rates;
ALTER TABLE fx_rates RENAME COLUMN rate_to_base TO units_per_base;
ALTER TABLE fx_rates RENAME CONSTRAINT fx_rates_rate_to_base_check TO fx_rates_units_per_base_check;
COMMENT ON COLUMN fx_rates.units_per_base IS 'Unidades de la divisa por 1 EUR (cotización EURxxx del proveedor tal cual). Convertir a EUR = dividir por este valor.';
