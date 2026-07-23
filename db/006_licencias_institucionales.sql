-- ============================================================================
-- 006 · Licencias institucionales (B2B mínimo)
--
-- QUÉ RESUELVE: una universidad, un municipio o una consultora paga UNA vez por
-- N personas. Cada persona canjea un código y su cuenta pasa a Pro hasta la
-- fecha en que vence el contrato. No hay panel para la institución, no hay
-- facturación automática y no hay reportes: eso se agrega cuando exista la
-- primera institución que lo pida, no antes.
--
-- POR QUÉ VIAJA SOLA, SIN EL CÓDIGO QUE LA USA: una migración y el código que la
-- necesita nunca salen en el mismo deploy. Si salen juntos, hay una ventana en
-- la que el código nuevo ya está sirviendo y la tabla todavía no existe — eso
-- rompió producción una vez (ver 005). Primero se aplica esto, después se sube
-- el código que lee estas tablas.
--
-- El vencimiento lo hace cumplir src/lib/tier.js: el acceso queda anotado en
-- subscriptions con provider = 'org_license' y current_period_end = valid_until,
-- que es el mismo mecanismo del pase semanal. Una sola forma de vencer para todo
-- el sistema; no dos.
-- ============================================================================

create table if not exists org_licenses (
  id           uuid primary key default gen_random_uuid(),
  -- El código que se le da a la gente. En MAYÚSCULAS y sin ambigüedad: se dicta
  -- por teléfono y se copia de un PDF, así que la comparación se hace siempre
  -- sobre upper(trim(...)) del lado del código.
  code         text not null unique,
  name         text not null,              -- "Universidad de San Andrés" — se le muestra a quien canjea
  -- Dominio de mail autorizado, sin arroba ("udesa.edu.ar"). Si está, SOLO puede
  -- canjear alguien con ese dominio: es lo que impide que el código circule por
  -- WhatsApp y se lo coman 200 desconocidos. Si es null, el código vale para
  -- cualquiera y el único freno es max_users.
  email_domain text,
  max_users    integer not null check (max_users > 0),
  -- Hasta cuándo dura el acceso de TODOS los miembros. Es la fecha del contrato.
  valid_until  timestamptz not null,
  is_active    boolean not null default true,
  notes        text,                       -- interno (nº de orden de compra, contacto)
  created_at   timestamptz not null default now()
);

create index if not exists org_licenses_code_idx on org_licenses (upper(code));


-- ---------------------------------------------------------------------------
-- Quién canjeó qué. El unique sobre user_id es la parte importante: una persona
-- ocupa UN cupo, en UNA licencia. Sin eso, la misma cuenta podría canjear dos
-- códigos y la institución pagaría por asientos que nadie usa.
-- ---------------------------------------------------------------------------
create table if not exists org_license_members (
  license_id  uuid not null references org_licenses(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  redeemed_at timestamptz not null default now(),
  primary key (license_id, user_id),
  unique (user_id)
);

create index if not exists olm_license_idx on org_license_members (license_id);
