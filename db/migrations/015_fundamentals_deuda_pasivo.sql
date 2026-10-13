-- 015: fundamentals + short_term_debt, long_term_debt y total_liabilities (decisiones-modelo.md §2.0, P14, 2026-10-13).
-- short_term_debt y long_term_debt son primitivos del proveedor (Balance_Sheet.shortTermDebt y longTermDebt). total_debt sigue siendo
-- el total que da el proveedor (shortLongTermDebtTotal); el escritor NUNCA lo rellena con la suma de las dos nuevas.
-- total_liabilities (Balance_Sheet.totalLiab) lo necesita ACCOUNTING_BALANCE (D4): Activo = Pasivo + Patrimonio.
-- Todas nullable: dato del proveedor que puede faltar sin que la fila deje de significar algo.
ALTER TABLE fundamentals
  ADD COLUMN short_term_debt   numeric,
  ADD COLUMN long_term_debt    numeric,
  ADD COLUMN total_liabilities numeric;
