-- Seed: VALIDATION_RULE (catálogo de reglas). Idempotente, pero con DO NOTHING a propósito: el catálogo existe para
-- apagar una regla o cambiar su severidad en producción sin desplegar, y un seed que se relance no debe revertir esos
-- cambios operativos. Una regla nueva entra por seed; modificar una existente es un UPDATE deliberado.
-- Códigos y severidades: modelo-entidades-validacion.md (tabla de productores) y PLAN.md Fase 4. VENUE_UNMAPPED y
-- ASSET_TYPE_UNMAPPED son nuevos (decisión D6) QUOTE_CURRENCY_MISSING (D7) y LISTING_REAPPEARED (D8): structural, warning; PRICE_REVISED (P13): data_quality, warning. La lógica de cada regla vive en el código.
INSERT INTO validation_rule (rule_code, description, category, default_severity, enabled) VALUES
  ('ACCOUNTING_BALANCE',       'Activo = Pasivo + Patrimonio dentro de tolerancia. DESACTIVADA hasta resolver D4: FUNDAMENTALS no guarda el pasivo total.', 'data_quality', 'error',   false),
  ('CURRENCY_COHERENCE',       'La divisa de FUNDAMENTALS y la quote_currency del listing tienen camino de conversión en FX_RATES.',                         'data_quality', 'error',   true),
  ('YOY_JUMP',                 'Ingresos o acciones con una variación de más del 200 % frente al mismo periodo del año anterior.',                          'data_quality', 'warning', true),
  ('SECOND_SOURCE_MISMATCH',   'El cruce con una segunda fuente (SEC EDGAR) no cuadra dentro de tolerancia.',                                               'data_quality', 'warning', true),
  ('STALENESS',                'Los últimos fundamentales o el último precio superan el umbral de antigüedad.',                                             'data_quality', 'warning', true),
  ('CORPORATE_EVENT_CHANGED',  'Un dividendo o split ya guardado llega con otro valor: se actualiza y el finding guarda el valor anterior y el nuevo.',    'data_quality', 'warning', true),
  ('IDENTITY_ISOLATED',        'Company sin CIK ni LEI: creada aislada, pendiente de revisión o fusión.',                                                   'structural',   'warning', true),
  ('IDENTITY_RELINK_CONFLICT', 'Un identificador (ISIN, CIK, LEI) contradice un enlace existente: no se re-enlaza en silencio.',                            'structural',   'error',   true),
  ('HOLDER_UNMAPPED',          'Holder sin holder_ref: la identidad cae al nombre normalizado.',                                                            'structural',   'warning', true),
  ('SECTOR_UNMAPPED',          'Etiqueta de sector o industria del proveedor sin mapeo (aplica a COMPANY y a ETF_ALLOCATION.bucket).',                      'structural',   'warning', true),
  ('VENUE_UNMAPPED',           'Símbolo de un agregado cuya sub-bolsa no tiene MIC en SOURCE_VENUE_MAP: el listing queda con exchange_id NULL.',           'structural',   'warning', true),
  ('QUOTE_CURRENCY_MISSING',  'Símbolo en alcance sin Currency en exchange-symbol-list: no se crea el listing (la divisa de cotización no se inventa ni se toma de EXCHANGE.default_currency).', 'structural', 'warning', true),
  ('LISTING_REAPPEARED',      'Un listing delisted vuelve a aparecer en la lista de activos: no se reactiva solo, se avisa para revisión.', 'structural', 'warning', true),
  ('PRICE_REVISED',           'El proveedor revisa un precio ya guardado (o el volumen de una sesión fuera de las últimas N): se acepta la revisión y el finding guarda el valor anterior y el nuevo.', 'data_quality', 'warning', true),
  ('ASSET_TYPE_UNMAPPED',      'El Type del proveedor no se mapea a ningún ASSET_TYPE: el valor no se ingiere.',                                             'structural',   'warning', true),
  ('DIVIDEND_SAME_EX_DATE',    'Una respuesta trae dos o más dividendos con la misma fecha ex para un valor: esa fecha no se escribe hasta revisarla.',     'structural',   'warning', true)
ON CONFLICT (rule_code) DO NOTHING;
