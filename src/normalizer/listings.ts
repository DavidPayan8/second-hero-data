import type pg from 'pg';
import { withActor } from '../db/withActor.js';
import { PROVIDER } from '../eodhd/provider.js';
import { emitFinding } from './findings.js';

// ------------------------------------------------------------------------------------------------------------------
// D2 (provisional, un único sitio): Type de EODHD -> ASSET_TYPE. Es la decisión de qué entra en el screener.
// Tipos conocidos que NO están en alcance se saltan sin finding (solo se cuentan); un Type que no está en ninguna de
// las dos listas es un tipo nuevo del proveedor: no se ingiere y se emite ASSET_TYPE_UNMAPPED (un finding por payload).
// Vocabulario visto en exchange-symbol-list/US (docs/verificacion-eodhd.md C16).
// ------------------------------------------------------------------------------------------------------------------
export const TYPE_TO_ASSET_TYPE: Record<string, string> = { 'Common Stock': 'common_stock', ETF: 'etf' };
export const KNOWN_OUT_OF_SCOPE_TYPES = new Set(['FUND', 'Mutual Fund', 'INDEX', 'Unit', 'UNIT', 'Warrant', 'Preferred Stock', 'Notes', 'ETC', 'BOND']);

// Mes de cierre fiscal: General.FiscalYearEnd viene como nombre del mes en inglés.
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export interface SymbolRecord {
  Code?: string | null;
  Name?: string | null;
  Country?: string | null;
  Exchange?: string | null;
  Currency?: string | null;
  Type?: string | null;
  Isin?: string | null;
}

export interface ListingsInput {
  rawPayloadId: string;
  runId: string;
  code: string; // código de bolsa del proveedor (LSE, US...)
  delisted: boolean;
  records: SymbolRecord[];
}

export interface ListingsSummary {
  symbols: number;
  created: number;
  updated: number;
  unchanged: number;
  securitiesCreated: number;
  companiesCreated: number;
  skippedVirtual: number;
  skippedOutOfScope: number;
  skippedNoFundamentals: number;
  skippedMultiListing: number;
  skippedNoCode: number;
  unknownTypes: number;
  currencyMissing: number;
  venueUnmapped: number;
  relinkConflicts: number;
  isolated: number;
}

const emptySummary = (): ListingsSummary => ({
  symbols: 0, created: 0, updated: 0, unchanged: 0, securitiesCreated: 0, companiesCreated: 0, skippedVirtual: 0, skippedOutOfScope: 0,
  skippedNoFundamentals: 0, skippedMultiListing: 0, skippedNoCode: 0, unknownTypes: 0, currencyMissing: 0, venueUnmapped: 0, relinkConflicts: 0, isolated: 0,
});

interface ExistingListing {
  listing_id: string;
  security_id: string;
  exchange_id: string | null;
  ticker: string;
  quote_currency: string;
  status: string;
  isin: string | null;
  asset_type_id: string;
}

const clean = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
// Un identificador de emisor "todo ceros" no identifica a nadie.
const cleanId = (v: unknown): string | null => { const s = clean(v); return s && !/^0+$/.test(s) ? s : null; };

// Último fundamentals 2xx del símbolo en raw_payload (solo se lee el cuerpo si existe).
async function latestFundamentals(c: pg.PoolClient, providerSymbol: string): Promise<{ General: Record<string, unknown> } | null> {
  const r = await c.query<{ body: Buffer }>(
    `SELECT b.body FROM raw_payload r JOIN payload_blob b USING (content_hash)
     WHERE r.endpoint = 'fundamentals/{symbol}' AND r.provider_symbol = $1 AND r.http_status BETWEEN 200 AND 299 AND b.body IS NOT NULL
     ORDER BY r.raw_payload_id DESC LIMIT 1`,
    [providerSymbol],
  );
  if (!r.rowCount) return null;
  const j = JSON.parse(new TextDecoder('utf-8').decode(r.rows[0]!.body)) as { General?: Record<string, unknown> };
  return j.General && typeof j.General === 'object' ? { General: j.General } : null;
}

type CompanyResolution = { companyId: string; created: boolean; isolated: boolean } | { conflict: Record<string, unknown> };

// resolver_company() de modelo-entidades-identidad.md: CIK -> LEI -> isolated. Nunca por nombre.
async function resolveCompany(c: pg.PoolClient, g: Record<string, unknown>): Promise<CompanyResolution> {
  const cik = cleanId(g.CIK);
  const lei = cleanId(g.LEI);
  type Co = { company_id: string; cik: string | null; lei: string | null };
  let company: Co | undefined;
  if (cik) company = (await c.query<Co>('SELECT company_id, cik, lei FROM company WHERE cik = $1', [cik])).rows[0];
  if (!company && lei) company = (await c.query<Co>('SELECT company_id, cik, lei FROM company WHERE lei = $1', [lei])).rows[0];

  if (company) {
    // Un identificador nuevo que contradice el enlace existente no se re-enlaza en silencio.
    if (company.cik && cik && company.cik !== cik) return { conflict: { reason: 'cik', existing_cik: company.cik, incoming_cik: cik } };
    if (company.lei && lei && company.lei !== lei) return { conflict: { reason: 'lei', existing_lei: company.lei, incoming_lei: lei } };
    // Enriquecer un identificador que faltaba, si no lo usa otra empresa.
    if (!company.cik && cik) {
      if ((await c.query('SELECT 1 FROM company WHERE cik = $1', [cik])).rowCount) return { conflict: { reason: 'cik_in_use', incoming_cik: cik } };
      await c.query('UPDATE company SET cik = $2 WHERE company_id = $1', [company.company_id, cik]);
    }
    if (!company.lei && lei) {
      if ((await c.query('SELECT 1 FROM company WHERE lei = $1', [lei])).rowCount) return { conflict: { reason: 'lei_in_use', incoming_lei: lei } };
      await c.query('UPDATE company SET lei = $2 WHERE company_id = $1', [company.company_id, lei]);
    }
    return { companyId: company.company_id, created: false, isolated: false };
  }

  const identitySource = cik ? 'cik' : lei ? 'lei' : 'isolated';
  const country = clean(g.CountryISO);
  const month = MONTHS.indexOf(clean(g.FiscalYearEnd) ?? '') + 1;
  const created = await c.query<{ id: string }>(
    `INSERT INTO company (legal_name, lei, cik, identity_source, country_iso, fiscal_year_end_month)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING company_id AS id`,
    [clean(g.Name), lei, cik, identitySource, country && /^[A-Z]{2}$/.test(country) ? country : null, month > 0 ? month : null],
  );
  return { companyId: created.rows[0]!.id, created: true, isolated: identitySource === 'isolated' };
}

// Escritor de listings desde exchange-symbol-list. Lee solo lo que ya está en raw_payload (el replay se lo entrega) y es
// idempotente: una segunda pasada no cambia recuentos ni deja filas nuevas en dimension_audit.
// Orden por símbolo: tipo (fuera de alcance se salta antes de resolver nada) -> divisa -> identidad -> venue.
export async function writeListings(input: ListingsInput): Promise<ListingsSummary> {
  return withActor('normalizer', `listings desde raw_payload ${input.rawPayloadId}`, async (c) => {
    const s = emptySummary();
    const { code: providerCode } = input;

    const se = (await c.query<{ kind: string; default_mic: string | null }>('SELECT kind, default_mic FROM source_exchange WHERE provider = $1 AND provider_code = $2', [PROVIDER, providerCode])).rows[0];
    if (se?.kind === 'virtual') { s.skippedVirtual = input.records.length; s.symbols = input.records.length; return s; }

    const venueMap = new Map((await c.query<{ l: string; mic: string }>('SELECT provider_venue_label AS l, mic FROM source_venue_map WHERE provider = $1 AND provider_code = $2', [PROVIDER, providerCode])).rows.map((r) => [r.l, r.mic]));
    const exchangeByMic = new Map((await c.query<{ mic: string; id: string }>('SELECT mic, exchange_id AS id FROM exchange')).rows.map((r) => [r.mic, r.id]));
    const assetTypeId = new Map((await c.query<{ code: string; id: string }>('SELECT code, asset_type_id AS id FROM asset_type')).rows.map((r) => [r.code, r.id]));
    const suffix = `.${providerCode}`;
    const existing = new Map<string, ExistingListing>((await c.query<ExistingListing & { provider_symbol: string }>(
      `SELECT l.provider_symbol, l.listing_id, l.security_id, l.exchange_id, l.ticker, l.quote_currency, l.status, sec.isin, sec.asset_type_id
       FROM listing l JOIN security sec USING (security_id) WHERE right(l.provider_symbol, $1) = $2`, [suffix.length, suffix],
    )).rows.map((r) => [r.provider_symbol, r]));

    const status = input.delisted ? 'delisted' : 'active';
    const unknownTypes: Record<string, number> = {};
    const missingCurrency: string[] = [];
    // Conflictos que no cuelgan de ninguna fila (el símbolo aún no existe): un único finding por payload, agregado y ordenado,
    // porque una clave de objetivo por payload no puede llevar varios findings abiertos de la misma regla.
    const payloadConflicts: Record<string, unknown>[] = [];

    // Pre-pase: un mismo ISIN con dos tipos en alcance distintos (acción y ETF) dentro del payload es contradictorio.
    // Se detecta antes de crear nada para que el resultado no dependa del orden de la lista.
    const typesByIsin = new Map<string, { types: Set<string>; symbols: string[] }>();
    for (const rec of input.records) {
      const t = clean(rec.Type); const tc = t ? TYPE_TO_ASSET_TYPE[t] : undefined; const i = clean(rec.Isin); const cd = clean(rec.Code);
      if (!tc || !i || !cd) continue;
      const g = typesByIsin.get(i) ?? { types: new Set<string>(), symbols: [] };
      g.types.add(tc); g.symbols.push(`${cd}.${providerCode}`); typesByIsin.set(i, g);
    }
    const mixedIsins = new Map([...typesByIsin].filter(([, g]) => g.types.size > 1));
    for (const [isinValue, g] of [...mixedIsins].sort(([x], [y]) => x.localeCompare(y))) {
      payloadConflicts.push({ reason: 'isin_asset_type', isin: isinValue, symbols: [...g.symbols].sort() });
    }

    const conflict = async (table: string, key: Record<string, unknown>, detail: Record<string, unknown>) => {
      s.relinkConflicts++;
      await emitFinding(c, { ruleCode: 'IDENTITY_RELINK_CONFLICT', targetTable: table, targetKey: key, detail, detectedByRun: input.runId });
    };
    const venueFinding = async (listingId: string, providerSymbol: string, label: string | null) => {
      s.venueUnmapped++;
      await emitFinding(c, { ruleCode: 'VENUE_UNMAPPED', targetTable: 'listing', targetKey: { listing_id: Number(listingId) }, detail: { provider_symbol: providerSymbol, provider_code: providerCode, venue_label: label }, detectedByRun: input.runId });
    };

    for (const rec of input.records) {
      s.symbols++;
      // 1. Tipo -> ASSET_TYPE, antes que nada.
      const type = clean(rec.Type);
      const assetTypeCode = type ? TYPE_TO_ASSET_TYPE[type] : undefined;
      if (!assetTypeCode) {
        if (!type || KNOWN_OUT_OF_SCOPE_TYPES.has(type)) s.skippedOutOfScope++;
        else { s.unknownTypes++; unknownTypes[type] = (unknownTypes[type] ?? 0) + 1; }
        continue;
      }
      const ticker = clean(rec.Code);
      if (!ticker) { s.skippedNoCode++; continue; }
      const providerSymbol = `${ticker}.${providerCode}`;

      // 2. La divisa de cotización sale del campo Currency del símbolo; sin ella no se crea el listing.
      const currency = clean(rec.Currency);
      if (!currency) { s.currencyMissing++; missingCurrency.push(providerSymbol); continue; }

      const isin = clean(rec.Isin);
      const atId = assetTypeId.get(assetTypeCode)!;

      // 3. Venue: SOURCE_EXCHANGE.kind -> default_mic, o SOURCE_VENUE_MAP para el agregado. Sin mapa, exchange_id NULL.
      const label = clean(rec.Exchange);
      const mic = se?.kind === 'single' ? se.default_mic : se?.kind === 'aggregate' && label ? venueMap.get(label) ?? null : null;
      const exchangeId = mic ? exchangeByMic.get(mic) ?? null : null;

      // 4. Identidad. Camino rápido por provider_symbol, comprobando siempre el ISIN entrante.
      const ex = existing.get(providerSymbol);
      if (ex) {
        if (isin && ex.isin && isin !== ex.isin) {
          await conflict('listing', { listing_id: Number(ex.listing_id) }, { provider_symbol: providerSymbol, reason: 'isin', existing_isin: ex.isin, incoming_isin: isin });
          continue;
        }
        if (ex.asset_type_id !== atId) {
          await conflict('listing', { listing_id: Number(ex.listing_id) }, { provider_symbol: providerSymbol, reason: 'asset_type', incoming_type: type });
          continue;
        }
        if (isin && !ex.isin) {
          if ((await c.query('SELECT 1 FROM security WHERE isin = $1', [isin])).rowCount) {
            await conflict('listing', { listing_id: Number(ex.listing_id) }, { provider_symbol: providerSymbol, reason: 'isin_in_use', incoming_isin: isin });
            continue;
          }
          await c.query('UPDATE security SET isin = $2 WHERE security_id = $1', [ex.security_id, isin]);
          ex.isin = isin;
        }
        // Un venue que deja de resolverse no borra el que ya se conocía.
        const newExchange = exchangeId ?? ex.exchange_id;
        // El estado solo avanza de active a delisted: una captura vieja de la lista de activos no resucita un símbolo que ya
        // salió en la de deslistados (y así repasar ambas listas no hace oscilar el estado). Una recotización real se haría a mano.
        const newStatus = ex.status === 'delisted' ? 'delisted' : status;
        if (ex.ticker !== ticker || ex.quote_currency !== currency || ex.status !== newStatus || ex.exchange_id !== newExchange) {
          await c.query('UPDATE listing SET ticker = $2, quote_currency = $3, status = $4, exchange_id = $5 WHERE listing_id = $1', [ex.listing_id, ticker, currency, newStatus, newExchange]);
          Object.assign(ex, { ticker, quote_currency: currency, status: newStatus, exchange_id: newExchange });
          s.updated++;
        } else s.unchanged++;
        if (newExchange === null) await venueFinding(ex.listing_id, providerSymbol, label);
        continue;
      }

      if (isin && mixedIsins.has(isin)) { s.relinkConflicts++; continue; } // ISIN contradictorio dentro del payload: no se ingiere ninguno

      // Símbolo nuevo. D1 (provisional): una security = un símbolo en v1; una segunda cotización de la misma security no se ingiere.
      let securityId: string | undefined;
      if (isin) {
        const sec = (await c.query<{ security_id: string; asset_type_id: string }>('SELECT security_id, asset_type_id FROM security WHERE isin = $1', [isin])).rows[0];
        if (sec) {
          if ((await c.query('SELECT 1 FROM listing WHERE security_id = $1', [sec.security_id])).rowCount) { s.skippedMultiListing++; continue; }
          if (sec.asset_type_id !== atId) { await conflict('security', { security_id: Number(sec.security_id) }, { provider_symbol: providerSymbol, reason: 'asset_type', incoming_type: type }); continue; }
          securityId = sec.security_id;
        }
      } else if (exchangeId && (await c.query('SELECT 1 FROM listing WHERE exchange_id = $1 AND ticker = $2', [exchangeId, ticker])).rowCount) {
        s.skippedMultiListing++; continue; // sin ISIN, el fallback (MIC, ticker) apunta a una cotización que ya existe
      }

      if (!securityId) {
        let companyId: string | null = null;
        if (assetTypeCode === 'common_stock') {
          // Una acción solo se crea con un fundamentals de ese símbolo a la vista: el CIK/LEI viene en General, no en la lista.
          const fund = await latestFundamentals(c, providerSymbol);
          if (!fund) { s.skippedNoFundamentals++; continue; }
          const res = await resolveCompany(c, fund.General);
          if ('conflict' in res) { s.relinkConflicts++; payloadConflicts.push({ provider_symbol: providerSymbol, ...res.conflict }); continue; }
          companyId = res.companyId;
          if (res.created) s.companiesCreated++;
          if (res.isolated) {
            s.isolated++;
            await emitFinding(c, { ruleCode: 'IDENTITY_ISOLATED', targetTable: 'company', targetKey: { company_id: Number(companyId) }, detail: { provider_symbol: providerSymbol }, detectedByRun: input.runId });
          }
        }
        securityId = (await c.query<{ id: string }>('INSERT INTO security (company_id, asset_type_id, isin) VALUES ($1, $2, $3) RETURNING security_id AS id', [companyId, atId, isin])).rows[0]!.id;
        s.securitiesCreated++;
      }

      const listingId = (await c.query<{ id: string }>(
        `INSERT INTO listing (security_id, exchange_id, ticker, provider_symbol, quote_currency, is_primary_listing, status)
         VALUES ($1, $2, $3, $4, $5, true, $6) RETURNING listing_id AS id`,
        [securityId, exchangeId, ticker, providerSymbol, currency, status],
      )).rows[0]!.id;
      existing.set(providerSymbol, { listing_id: listingId, security_id: securityId, exchange_id: exchangeId, ticker, quote_currency: currency, status, isin, asset_type_id: atId });
      s.created++;
      if (exchangeId === null) await venueFinding(listingId, providerSymbol, label);
    }

    // Hallazgos agregados por payload (el objetivo es la fila de raw_payload que los trajo).
    const target = { raw_payload_id: Number(input.rawPayloadId) };
    if (s.unknownTypes) {
      const types = Object.fromEntries(Object.entries(unknownTypes).sort(([a], [b]) => a.localeCompare(b)));
      await emitFinding(c, { ruleCode: 'ASSET_TYPE_UNMAPPED', targetTable: 'raw_payload', targetKey: target, detail: { types }, detectedByRun: input.runId });
    }
    if (payloadConflicts.length) {
      const items = [...payloadConflicts].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
      await emitFinding(c, { ruleCode: 'IDENTITY_RELINK_CONFLICT', targetTable: 'raw_payload', targetKey: target, detail: { conflicts: items }, detectedByRun: input.runId });
    }
    if (s.currencyMissing) {
      await emitFinding(c, { ruleCode: 'QUOTE_CURRENCY_MISSING', targetTable: 'raw_payload', targetKey: target, detail: { count: missingCurrency.length, sample: [...missingCurrency].sort().slice(0, 20) }, detectedByRun: input.runId });
    }
    return s;
  });
}
