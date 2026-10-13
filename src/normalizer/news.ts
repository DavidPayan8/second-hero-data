import { withActor } from '../db/withActor.js';
import { isObj, text } from './values.js';

// Noticias (modelo-noticias.md): subsistema aparte, sin findings ni auditoría. Upsert de NEWS por url (clave natural, tal cual); un
// refetch actualiza en silencio fecha, titular, tags, símbolos y sentimiento. NEWS_SECURITY solo crece: los símbolos EODHD se
// resuelven por LISTING.provider_symbol -> SECURITY y los que no resuelven (índices, materias primas, privadas...) se ignoran sin
// finding. `content` no se guarda (decisión 3). Una noticia sin url, fecha o titular no se crea (decisión 1 y 2).
export interface NewsInput { rawPayloadId: string; body: unknown }

export interface NewsSummary {
  payloads: number;
  articles: number;
  inserted: number;
  updated: number;
  unchanged: number;
  skippedIncomplete: number; // sin url, fecha o titular válidos
  linksAdded: number;
}
export const emptyNewsSummary = (): NewsSummary => ({ payloads: 0, articles: 0, inserted: 0, updated: 0, unchanged: 0, skippedIncomplete: 0, linksAdded: 0 });

interface Article { url: string; published_at: string; headline: string; symbols: string[] | null; tags: string[] | null; pol: string | null; neg: string | null; neu: string | null; pos: string | null }

const strings = (v: unknown): string[] | null => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null);

export async function writeNews(input: NewsInput): Promise<NewsSummary> {
  if (!Array.isArray(input.body)) throw new Error('se esperaba una lista de noticias');
  const s = emptyNewsSummary();
  s.payloads = 1;
  const byUrl = new Map<string, Article>();
  for (const a of input.body) {
    s.articles++;
    if (!isObj(a)) { s.skippedIncomplete++; continue; }
    const url = text(a.link), headline = text(a.title), at = text(a.date);
    const t = at === null ? NaN : Date.parse(at);
    if (!url || !headline || Number.isNaN(t)) { s.skippedIncomplete++; continue; }
    const sent = isObj(a.sentiment) ? a.sentiment : {};
    byUrl.set(url, { url, published_at: new Date(t).toISOString(), headline, symbols: strings(a.symbols), tags: strings(a.tags),
      pol: text(sent.polarity), neg: text(sent.neg), neu: text(sent.neu), pos: text(sent.pos) });
  }
  if (!byUrl.size) return s;
  const rows = JSON.stringify([...byUrl.values()]);
  return withActor('normalizer', `noticias desde raw_payload ${input.rawPayloadId}`, async (c) => {
    const rec = `jsonb_to_recordset($1::jsonb) AS i(url text, published_at timestamptz, headline text, symbols jsonb, tags jsonb, pol numeric, neg numeric, neu numeric, pos numeric)`;
    const arr = (x: string) => `CASE WHEN i.${x} IS NULL OR jsonb_typeof(i.${x}) <> 'array' THEN NULL ELSE ARRAY(SELECT jsonb_array_elements_text(i.${x})) END`;
    const up = await c.query<{ inserted: boolean }>(
      `INSERT INTO news (url, published_at, headline, symbols, tags, sentiment_polarity, sentiment_neg, sentiment_neu, sentiment_pos)
       SELECT i.url, i.published_at, i.headline, ${arr('symbols')}, ${arr('tags')}, i.pol, i.neg, i.neu, i.pos FROM ${rec}
       ON CONFLICT (url) DO UPDATE SET published_at = EXCLUDED.published_at, headline = EXCLUDED.headline, symbols = EXCLUDED.symbols, tags = EXCLUDED.tags,
         sentiment_polarity = EXCLUDED.sentiment_polarity, sentiment_neg = EXCLUDED.sentiment_neg, sentiment_neu = EXCLUDED.sentiment_neu, sentiment_pos = EXCLUDED.sentiment_pos
       WHERE (news.published_at, news.headline, news.symbols, news.tags, news.sentiment_polarity, news.sentiment_neg, news.sentiment_neu, news.sentiment_pos)
         IS DISTINCT FROM (EXCLUDED.published_at, EXCLUDED.headline, EXCLUDED.symbols, EXCLUDED.tags, EXCLUDED.sentiment_polarity, EXCLUDED.sentiment_neg, EXCLUDED.sentiment_neu, EXCLUDED.sentiment_pos)
       RETURNING (xmax = 0) AS inserted`, [rows]);
    s.inserted = up.rows.filter((r) => r.inserted).length;
    s.updated = up.rows.filter((r) => !r.inserted).length;
    s.unchanged = byUrl.size - up.rowCount!;
    // NEWS_SECURITY: solo crece. Varios listings de la misma security colapsan en una fila.
    const link = await c.query(
      `INSERT INTO news_security (news_id, security_id)
       SELECT DISTINCT n.news_id, l.security_id FROM ${rec}
       JOIN news n ON n.url = i.url
       CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(i.symbols) = 'array' THEN i.symbols ELSE '[]'::jsonb END) AS sym(code)
       JOIN listing l ON l.provider_symbol = sym.code
       ON CONFLICT DO NOTHING`, [rows]);
    s.linksAdded = link.rowCount ?? 0;
    return s;
  });
}
