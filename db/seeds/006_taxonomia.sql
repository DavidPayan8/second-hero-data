-- Seed: SECTOR e INDUSTRY (D3, decisiones-modelo-taxonomia.md §4.b, aprobada por David el 2026-10-14). Once sectores y 38 industrias,
-- con códigos y nombres propios. Idempotente: ON CONFLICT DO NOTHING, así que relanzarlo no toca nada ni escribe en dimension_audit.
-- SOURCE_SECTOR_MAP no tiene seed: espera las etiquetas reales del universo.
INSERT INTO sector (code, name) VALUES
  ('energy',            'Energía'),
  ('materials',         'Materiales'),
  ('industrials',       'Industria'),
  ('consumer_cyclical', 'Consumo cíclico'),
  ('consumer_staples',  'Consumo básico'),
  ('health_care',       'Salud'),
  ('financials',        'Finanzas'),
  ('real_estate',       'Inmobiliario'),
  ('technology',        'Tecnología'),
  ('communication',     'Comunicaciones'),
  ('utilities',         'Servicios públicos')
ON CONFLICT (code) DO NOTHING;

INSERT INTO industry (sector_id, code, name)
SELECT s.sector_id, v.industry_code, v.industry_name
FROM (VALUES
  ('energy',            'oil_gas',                  'Petróleo y gas'),
  ('energy',            'energy_services',          'Servicios energéticos y transporte'),
  ('energy',            'coal_other_fuels',         'Carbón y otros combustibles'),
  ('materials',         'chemicals',                'Química'),
  ('materials',         'metals_mining',            'Metales y minería'),
  ('materials',         'construction_materials',   'Materiales de construcción'),
  ('materials',         'packaging_paper',          'Envases, papel y madera'),
  ('industrials',       'aerospace_defense',        'Aeroespacial y defensa'),
  ('industrials',       'machinery_equipment',      'Maquinaria y equipos'),
  ('industrials',       'construction_engineering', 'Construcción e ingeniería'),
  ('industrials',       'transport_logistics',      'Transporte y logística'),
  ('industrials',       'business_services',        'Servicios a empresas'),
  ('consumer_cyclical', 'autos',                    'Automoción'),
  ('consumer_cyclical', 'retail',                   'Distribución minorista'),
  ('consumer_cyclical', 'travel_leisure',           'Viajes, ocio y restauración'),
  ('consumer_cyclical', 'apparel_durables',         'Moda, lujo y bienes duraderos'),
  ('consumer_staples',  'food_beverage_tobacco',    'Alimentación, bebidas y tabaco'),
  ('consumer_staples',  'household_personal',       'Hogar y cuidado personal'),
  ('consumer_staples',  'staples_retail',           'Supermercados y distribución básica'),
  ('health_care',       'pharma_biotech',           'Farmacia y biotecnología'),
  ('health_care',       'medical_devices',          'Tecnología y equipos médicos'),
  ('health_care',       'health_services',          'Servicios sanitarios'),
  ('financials',        'banking',                  'Banca'),
  ('financials',        'insurance',                'Seguros'),
  ('financials',        'capital_markets',          'Mercados de capitales y gestión de activos'),
  ('financials',        'specialty_finance',        'Financiación especializada'),
  ('real_estate',       'reits',                    'REITs / SOCIMIs'),
  ('real_estate',       'real_estate_operating',    'Promoción y gestión inmobiliaria'),
  ('technology',        'software',                 'Software'),
  ('technology',        'hardware_devices',         'Hardware y dispositivos'),
  ('technology',        'semiconductors',           'Semiconductores'),
  ('technology',        'it_services',              'Servicios TI'),
  ('communication',     'telecom',                  'Telecomunicaciones'),
  ('communication',     'media_entertainment',      'Medios y entretenimiento'),
  ('communication',     'internet_platforms',       'Internet y plataformas'),
  ('utilities',         'electric_utilities',       'Eléctricas'),
  ('utilities',         'gas_water_multi',          'Gas, agua y multiservicios'),
  ('utilities',         'renewable_power',          'Generación renovable')
) AS v (sector_code, industry_code, industry_name)
JOIN sector s ON s.code = v.sector_code
ON CONFLICT (code) DO NOTHING;
