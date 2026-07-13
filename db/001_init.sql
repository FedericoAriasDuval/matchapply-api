-- =====================================================================
-- MatchApply — esquema inicial
-- Postgres 14+. Ejecutar con: npm run migrate
-- =====================================================================
create extension if not exists "pgcrypto";           -- gen_random_uuid()
create extension if not exists "citext";             -- emails case-insensitive

-- ---------------------------------------------------------------------
-- USUARIOS
-- La contraseña se guarda SOLO como hash bcrypt (cost 12). Nunca en claro.
-- ---------------------------------------------------------------------
do $$ begin
  create type user_tier as enum ('free', 'pro');
exception when duplicate_object then null; end $$;

create table if not exists users (
  id              uuid primary key default gen_random_uuid(),
  email           citext not null unique,
  password_hash   text   not null,
  name            text   not null,
  tier            user_tier not null default 'free',
  is_verified     boolean not null default false,
  is_discoverable boolean not null default false,   -- opt-in talent pool (B2B)
  failed_logins   int     not null default 0,
  locked_until    timestamptz,
  last_login_at   timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists users_verified_idx on users (is_verified) where is_verified = false;

-- ---------------------------------------------------------------------
-- CÓDIGOS DE VERIFICACIÓN (MFA por email)
-- Se guarda el HASH sha256 del código, nunca el código en claro.
-- Expiración 15 minutos, máximo 5 intentos, cooldown de reenvío.
-- ---------------------------------------------------------------------
do $$ begin
  create type code_purpose as enum ('signup', 'login', 'password_reset');
exception when duplicate_object then null; end $$;

create table if not exists verification_codes (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  purpose      code_purpose not null default 'signup',
  code_hash    text not null,
  expires_at   timestamptz not null,
  attempts     int  not null default 0,
  max_attempts int  not null default 5,
  consumed_at  timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists vcodes_user_idx    on verification_codes (user_id, purpose, consumed_at);
create index if not exists vcodes_expires_idx on verification_codes (expires_at);

-- ---------------------------------------------------------------------
-- SESIONES (refresh tokens rotativos; se guarda solo el hash)
-- ---------------------------------------------------------------------
create table if not exists sessions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  token_hash    text not null unique,
  user_agent    text,
  ip            inet,
  expires_at    timestamptz not null,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists sessions_user_idx on sessions (user_id) where revoked_at is null;

-- ---------------------------------------------------------------------
-- DOCUMENTOS DE CV
-- source_text = el texto exacto recibido del usuario (única fuente de verdad).
-- data        = JSON estructurado devuelto por el LLM y saneado por el servidor.
-- edited      = true si el usuario (pro) lo editó a mano.
-- ---------------------------------------------------------------------
create table if not exists cv_documents (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  title        text not null default 'CV',
  source_text  text not null,
  source_hash  text not null,                       -- sha256 del source_text: cachea el parseo
  lang         text not null default 'es',
  data         jsonb not null,
  edited       boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists cv_user_idx on cv_documents (user_id, updated_at desc);
create unique index if not exists cv_user_source_idx on cv_documents (user_id, source_hash);

-- ---------------------------------------------------------------------
-- CUOTA DIARIA (free 5 / pro 30 adaptaciones por día) — server-side
-- ---------------------------------------------------------------------
create table if not exists usage_daily (
  user_id        uuid not null references users(id) on delete cascade,
  day            date not null,
  cv_adaptations int  not null default 0,
  primary key (user_id, day)
);

-- ---------------------------------------------------------------------
-- POSTULACIONES
-- ---------------------------------------------------------------------
create table if not exists applications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  company     text,
  role        text,
  job_url     text,
  match_score int check (match_score between 0 and 100),
  status      text not null default 'applied',      -- applied|viewed|interview|rejected|offer
  created_at  timestamptz not null default now()
);
create index if not exists apps_user_idx on applications (user_id, created_at desc);

-- ---------------------------------------------------------------------
-- SUSCRIPCIONES (Stripe / MercadoPago)
-- ---------------------------------------------------------------------
create table if not exists subscriptions (
  user_id            uuid primary key references users(id) on delete cascade,
  provider           text not null,                 -- 'stripe' | 'mercadopago'
  customer_id        text,
  subscription_id    text,
  status             text not null,                 -- active|past_due|canceled
  current_period_end timestamptz,
  updated_at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- AUDITORÍA MÍNIMA DE SEGURIDAD
-- ---------------------------------------------------------------------
create table if not exists auth_events (
  id         bigserial primary key,
  user_id    uuid references users(id) on delete set null,
  email      citext,
  event      text not null,     -- signup|verify_ok|verify_fail|login_ok|login_fail|resend|logout|lockout
  ip         inet,
  user_agent text,
  created_at timestamptz not null default now()
);
create index if not exists auth_events_idx on auth_events (email, created_at desc);

-- ---------------------------------------------------------------------
-- updated_at automático
-- ---------------------------------------------------------------------
create or replace function touch_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

drop trigger if exists users_touch on users;
create trigger users_touch before update on users
  for each row execute function touch_updated_at();

drop trigger if exists cv_touch on cv_documents;
create trigger cv_touch before update on cv_documents
  for each row execute function touch_updated_at();
