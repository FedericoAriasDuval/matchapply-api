-- 011 · Contadores de uso por ACCIÓN y por VENTANA (rediseño de cuotas 31/07).
--
-- Reemplaza al contador diario único (usage_daily.cv_adaptations) por el modelo nuevo:
--   Free = de por vida (no resetea)   → period = 'life'
--   Plus = mes calendario (resetea 1°) → period = 'AAAA-MM'
--   Pro  = sin tope                    → no se escribe fila
-- Solo se cuentan 'diagnostic' (POST /cv/parse) y 'tailor' (POST /cv/:id/tailor);
-- carta y entrevista son ilimitadas (solo candado de tier), no tienen fila acá.
--
-- usage_daily NO se toca ni se borra (datos históricos). Los contadores nuevos
-- arrancan en cero porque la tabla es nueva → "desde cero para todos", como se decidió.
create table if not exists usage_counters (
  user_id  uuid not null references users(id) on delete cascade,
  action   text not null,           -- 'diagnostic' | 'tailor'
  period   text not null,           -- 'life' (de por vida) | 'AAAA-MM' (mensual)
  n        int  not null default 0,
  primary key (user_id, action, period)
);
