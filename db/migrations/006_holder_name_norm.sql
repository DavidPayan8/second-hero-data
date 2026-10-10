-- 006_holder_name_norm: holder_name_norm() colapsa también los espacios internos.
-- Decisión: docs/modelo/decisiones-modelo-ownership.md §2.b. La normalización absorbe variaciones de FORMA
-- (mayúsculas, puntuación, espacios), no equivalencias de significado como Inc = Incorporated.
-- La 005 ya estaba publicada, por eso el cambio va en una migración nueva.
CREATE OR REPLACE FUNCTION holder_name_norm(text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  RETURN upper(btrim(regexp_replace(regexp_replace($1, '[[:punct:]]', '', 'g'), '\s+', ' ', 'g')));

-- El índice único de holder_position guarda valores calculados con la versión anterior de la función: cambiar una
-- función IMMUTABLE sin reindexar lo deja inconsistente. Si hubiera filas que antes eran distintas y ahora
-- colisionan, el REINDEX falla y la migración se revierte entera (hoy la tabla está vacía: aún no hay ingesta).
REINDEX INDEX holder_position_key_idx;
