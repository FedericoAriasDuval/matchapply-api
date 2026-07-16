-- =====================================================================
-- Mavante — referidos
--
-- Dos decisiones que no son obvias y que conviene dejar escritas:
--
-- 1. EL CÓDIGO NO SE DERIVA DEL EMAIL NI DEL ID. Es aleatorio. Si lo
--    derivamos del id, cualquiera que vea un link de referido conoce el uuid
--    de un usuario; si lo derivamos del email, es peor todavía. El link se
--    comparte en público: no puede filtrar nada de quien lo comparte.
--
-- 2. LA RECOMPENSA SE PAGA CUANDO EL INVITADO VERIFICA SU EMAIL, no cuando
--    hace clic. Si pagáramos por clic, el programa se convierte en una
--    máquina de fabricar cuentas falsas — y el primero en descubrirlo sería
--    alguien que quiera romperlo, no alguien que quiera un trabajo.
--    Por eso `credited_at` es nullable y hay un unique sobre invitee_id: un
--    invitado paga una sola vez, para siempre.
-- =====================================================================

-- ---------------------------------------------------------------------
-- El código de cada usuario. Uno por persona, estable en el tiempo:
-- si alguien ya compartió su link, ese link tiene que seguir funcionando.
-- ---------------------------------------------------------------------
create table if not exists referral_codes (
  user_id     uuid primary key references users(id) on delete cascade,
  code        text not null unique,
  created_at  timestamptz not null default now()
);
create index if not exists referral_codes_code_idx on referral_codes (code);

-- ---------------------------------------------------------------------
-- Cada invitación aceptada. `invitee_id` es UNIQUE: una persona sola puede
-- ser invitada una vez en su vida. Sin eso, borrar la cuenta y volver a
-- entrar sería una fábrica de créditos.
-- ---------------------------------------------------------------------
create table if not exists referrals (
  id           uuid primary key default gen_random_uuid(),
  referrer_id  uuid not null references users(id) on delete cascade,
  invitee_id   uuid not null unique references users(id) on delete cascade,
  code         text not null,
  credited_at  timestamptz,                    -- null = todavía no verificó su email
  created_at   timestamptz not null default now(),
  -- Nadie se invita a sí mismo. Es la trampa más obvia y la más usada.
  constraint referrals_no_self check (referrer_id <> invitee_id)
);
create index if not exists referrals_referrer_idx on referrals (referrer_id);
create index if not exists referrals_pending_idx  on referrals (invitee_id) where credited_at is null;

-- ---------------------------------------------------------------------
-- El saldo de simulaciones regaladas. Una fila por usuario.
-- No lo guardamos como columna en `users` porque queremos poder auditar de
-- dónde salió cada crédito: la fuente de verdad son las filas de `referrals`,
-- y esto es el acumulado que se lee rápido.
-- ---------------------------------------------------------------------
create table if not exists referral_credits (
  user_id     uuid primary key references users(id) on delete cascade,
  sims_total  int not null default 0 check (sims_total >= 0),
  sims_used   int not null default 0 check (sims_used  >= 0),
  updated_at  timestamptz not null default now(),
  constraint referral_credits_sane check (sims_used <= sims_total)
);
