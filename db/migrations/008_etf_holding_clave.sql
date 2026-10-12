-- 008_etf_holding_clave: la clave única de ETF_HOLDING lleva prefijo por tipo de identificador.
-- La 007 usaba COALESCE(constituent_symbol, constituent_isin, constituent_name) sin prefijos, de modo que un
-- constituyente solo con símbolo X y otro solo con nombre X el mismo día chocaban. Los prefijos 'sym:', 'isin:' y
-- 'name:' separan los tres espacios de identificadores. Siguen siendo solo identificadores del proveedor: la
-- resolución a constituent_security_id no forma parte de la clave.
-- La 007 ya estaba publicada, por eso el cambio va en una migración nueva. Si hubiera filas que antes eran distintas
-- y ahora colisionan, o al revés, el CREATE UNIQUE INDEX fallaría y la migración se revertiría (hoy la tabla está vacía).
DROP INDEX etf_holding_key_idx;
CREATE UNIQUE INDEX etf_holding_key_idx ON etf_holding (
  security_id,
  as_of_date,
  (COALESCE('sym:' || constituent_symbol, 'isin:' || constituent_isin, 'name:' || constituent_name))
);
