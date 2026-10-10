# Verificación en vivo contra EODHD (Fase 1)

Rellenar con evidencia de payloads reales capturados en `fixtures/eodhd/` (que no se suben al repo). Una fila por pregunta de `PLAN.md` §1.3.

- **Fecha de captura:**
- **Plan de la API key / endpoints cubiertos:**
- **Endpoints cuya ruta difiere de la de referencia del plan:**

## Resumen

| Id | Pregunta | Veredicto | Impacto en el modelo |
|---|---|---|---|
| ★ C1 | CIK y LEI a nivel de empresa | | |
| C2 | ISIN por símbolo | | |
| C3 | Fecha de presentación en fundamentales | | |
| C4 | Divisa de estados vs. cotización | | |
| C5 | Sub-bolsa de los símbolos `US` | | |
| C6 | Cobertura de deslistadas | | |
| C7 | Formato de splits y dividendos | | |
| C8 | Id estable de InsiderTransactions | | |
| C9 | Id estable de holder (`holder_ref`) | | |
| C10 | Escala de rating de analistas | | |
| C11 | Bloque ETF | | |
| C12 | Earnings | | |
| C13 | News | | |
| C14 | `symbol-change-history` | | |
| C15 | Etiquetas de sector / industria | | |
| C16 | Valores de `Type` | | |
| C17 | Acciones en circulación | | |

## Detalle

Para cada pregunta: ruta exacta en el JSON, valor de ejemplo (símbolo + valor), cobertura por región (EEUU / Europa / Canadá) y consecuencia para el modelo.

### ★ C1 — CIK y LEI a nivel de empresa

| Símbolo | CIK (ruta, valor) | LEI (ruta, valor) |
|---|---|---|
| AAPL.US | | |
| GOOGL.US | | |
| GOOG.US | | |
| KO.US | | |
| META.US | | |
| JPM.US | | |
| O.US | | |
| VTI.US | | |
| SAP.XETRA | | |
| ITX.MC | | |
| SHEL.LSE | | |
| SHOP.TO | | |

¿GOOGL y GOOG comparten CIK?:

Conclusión para `identity_source`:

### C2 … C17

(una subsección por pregunta)
