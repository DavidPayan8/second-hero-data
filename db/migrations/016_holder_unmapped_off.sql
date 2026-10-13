-- 016: HOLDER_UNMAPPED pasa a enabled = false (decisión de David, 2026-10-13). EODHD no da ids de holder, así que la regla
-- saltaría en cada fila de Holders. La regla sigue en el catálogo. El seed (DO NOTHING) ya la crea apagada en una base nueva;
-- este UPDATE deliberado apaga la que ya existe en una base con el seed anterior (en una base nueva aún no hay fila y no hace nada).
UPDATE validation_rule SET enabled = false WHERE rule_code = 'HOLDER_UNMAPPED';
