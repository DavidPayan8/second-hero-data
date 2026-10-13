// Tolerancias y umbrales de la capa de validación (PLAN.md D5). ÚNICO sitio: ninguna regla lleva números propios.
// PROVISIONAL hasta que David confirme los valores.
export const VALIDATION_CONFIG = {
  // ACCOUNTING_BALANCE (desactivada, D4): |Activo - Pasivo - Patrimonio| / Activo.
  accountingBalanceTolerance: 0.01,
  // SECOND_SOURCE_MISMATCH: |valor del proveedor - valor SEC| / |valor SEC|.
  secTolerance: 0.005,
  // SECOND_SOURCE_MISMATCH: días de diferencia admitidos entre el cierre de EODHD (fin de mes) y el de la SEC (ejercicios de 52/53 semanas, p. ej. AAPL 2025-09-27 frente a 2025-09-30).
  secPeriodWindowDays: 7,
  // YOY_JUMP: variación relativa frente al mismo periodo del año anterior (2 = 200 %), en valor absoluto.
  yoyJumpRatio: 2,
  // Desfase admitido, en días, al buscar el periodo del año anterior (los cierres fiscales de 52/53 semanas se mueven unos días).
  yoyPeriodWindowDays: 15,
  // YOY_JUMP: solo se evalúan periodos con period_end en los últimos N años (lo que el screener enseña). Antes, el aviso no se emite
  // y el runner cierra el que hubiera abierto (decisiones-modelo-validacion.md 7).
  yoyRecentYears: 3,
  // STALENESS: último reported_at de FUNDAMENTALS (días naturales) y último precio (días hábiles = lunes a viernes; sin calendario de festivos).
  stalenessFundamentalsDays: 200,
  stalenessPriceBusinessDays: 5,
} as const;
