-- 004 — la columna data pasa de jsonb a text.
--
-- El CV entra a la base CIFRADO (AES-256-GCM, ver crypto.js): lo que se guarda
-- es texto cifrado, no JSON. Con jsonb, Postgres rechazaba el insert con
-- "invalid input syntax for type json" y guardar un CV era imposible.
-- Nunca se noto porque la llamada al LLM fallaba antes (bug de temperature,
-- arreglado el 16/07/2026): al arreglar esa capa, quedo expuesta esta.
--
-- Idempotente: el migrate re-corre todos los .sql en cada deploy.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'cv_documents' and column_name = 'data' and data_type = 'jsonb'
  ) then
    alter table cv_documents alter column data type text using data::text;
  end if;
end $$;
