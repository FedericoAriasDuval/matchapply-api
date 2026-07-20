-- ============================================================================
-- 005 · Panel de Talento con consentimiento (B2B2C)
--
-- LA REGLA QUE GOBIERNA TODO ESTE ARCHIVO:
-- el usuario decide, y su decisión tiene efecto AHORA. No hay caché, no hay job
-- nocturno, no hay "se actualiza en 24hs". Si alguien se da de baja, deja de
-- verse en la próxima consulta.
--
-- POR QUÉ SE RENOMBRA EN VEZ DE AGREGAR UNA COLUMNA NUEVA:
-- `users.is_discoverable` ya existía con exactamente este propósito ("opt-in
-- talent pool (B2B)"). Agregar `is_visible_to_companies` al lado habría dejado
-- DOS banderas para la misma decisión, y ese es el peor bug posible en una
-- función de privacidad: el día que una se actualiza y la otra no, alguien que
-- se dio de baja sigue apareciendo en el panel. Una sola fuente de verdad.
-- El rename preserva el valor de quienes ya habían tildado la casilla.
-- ============================================================================

-- El rename va condicionado para poder correrse dos veces sin explotar (un
-- `alter ... rename` sobre una columna que ya no existe aborta la migración
-- entera, y con ella todo lo que viene abajo).
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_name = 'users' and column_name = 'is_discoverable') then
    alter table users rename column is_discoverable to is_visible_to_companies;
  end if;
end $$;

-- Y por si alguien llega acá con una base sin ninguna de las dos.
alter table users add column if not exists is_visible_to_companies boolean not null default false;

-- Cuándo aceptó. Sirve para dos cosas concretas: probar el consentimiento si
-- alguien lo reclama, y no mostrar como "nuevo" a alguien que está hace meses.
alter table users add column if not exists visible_since timestamptz;

-- A quien ya estaba visible antes de esta migración le ponemos la fecha de hoy:
-- es lo único honesto que podemos afirmar, porque antes no se guardaba.
update users set visible_since = now() where is_visible_to_companies = true and visible_since is null;

-- El panel filtra SIEMPRE por esta condición, así que el índice es parcial:
-- ocupa solo lo que se consulta.
create index if not exists users_visible_idx
  on users (visible_since desc)
  where is_visible_to_companies = true;


-- ---------------------------------------------------------------------------
-- Empresas. Hoy se dan de alta A MANO (no hay auto-registro a propósito: cada
-- empresa que entra al panel mira datos de personas reales, así que la puerta
-- la abre un humano). `api_key_hash` guarda el hash, nunca la clave.
-- ---------------------------------------------------------------------------
create table if not exists companies (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  sector        text,                      -- "Fintech", "Salud"… es lo ÚNICO que ve el candidato
  size_label    text,                      -- "11-50", "200+"… idem
  contact_email text not null,
  api_key_hash  text not null unique,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);

create index if not exists companies_active_idx on companies (is_active) where is_active = true;


-- ---------------------------------------------------------------------------
-- El interés de una empresa en un candidato. ACÁ vive el permiso: mientras el
-- status no sea 'accepted', la empresa NO puede ver ni el nombre.
--
-- El unique (company_id, user_id) es deliberado: una empresa pide UNA vez. Sin
-- eso, un "no" se podría convertir en acoso a fuerza de reintentos.
-- ---------------------------------------------------------------------------
create table if not exists company_interests (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  status      text not null default 'pending' check (status in ('pending','accepted','rejected')),
  message     text,                        -- opcional, lo escribe la empresa; se muestra al candidato
  created_at  timestamptz not null default now(),
  resolved_at timestamptz,
  unique (company_id, user_id)
);

create index if not exists ci_user_pending_idx on company_interests (user_id, created_at desc) where status = 'pending';
create index if not exists ci_company_idx      on company_interests (company_id, created_at desc);
