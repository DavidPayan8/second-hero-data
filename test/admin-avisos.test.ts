import { describe, expect, test } from 'vitest';
import { avisoDe, type FilaAviso } from '../src/admin/avisos.js';

const f = (isin: string, country: string | null, matchedType: string | null = 'Common Stock'): FilaAviso => ({ lei: 'L', isin, matchedType, country });

describe('avisoDe', () => {
  test('Santander ES: la acción española es sugerida y el ADR de EEUU es revisar con motivo ADR', () => {
    const es = f('ES0113900J37', 'ES');
    const us = f('US05964H1059', 'ES');
    expect(avisoDe(es, [us]).aviso).toBe('sugerido');
    const r = avisoDe(us, [es]);
    expect(r.aviso).toBe('revisar');
    expect(r.motivo).toContain('ADR');
  });
  test('doble clase (Volvo A y B) -> revisar con motivo otra clase', () => {
    const a = f('SE0000115420', 'SE');
    const b = f('SE0000115446', 'SE');
    for (const r of [avisoDe(a, [b]), avisoDe(b, [a])]) {
      expect(r.aviso).toBe('revisar');
      expect(r.motivo).toContain('otra clase');
    }
  });
  test('prefijo distinto del país del informe (Ariston NL en IT) -> revisar con motivo prefijo', () => {
    const r = avisoDe(f('NL0015000N33', 'IT'), []);
    expect(r.aviso).toBe('revisar');
    expect(r.motivo).toContain('prefijo');
  });
  test('acción preferente con prefijo correcto y sin hermanas -> revisar', () => {
    expect(avisoDe(f('ES0171996095', 'ES', 'Preferred Stock'), []).aviso).toBe('revisar');
  });
  test('país desconocido -> revisar', () => {
    expect(avisoDe(f('ES0178430E18', null), []).aviso).toBe('revisar');
  });
  test('valor de EEUU en un informe de EEUU no es ADR', () => {
    expect(avisoDe(f('US0378331005', 'US'), []).aviso).toBe('sugerido');
  });
});
