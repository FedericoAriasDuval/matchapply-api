-- Tokens de la EXTENSIÓN de Chrome.
--
-- Por qué una tabla propia y no reusar el access token: la cookie de sesión
-- (ma_at) es SameSite=lax y NO viaja desde un origen chrome-extension://, y el
-- access JWT dura 15 minutos — inservible para una extensión que vive semanas.
-- Un JWT de larga vida sería un bearer NO revocable (si se filtra, vale hasta
-- que venza, y este proyecto ya trata la revocación como un requisito, no un
-- lujo). Estos tokens son OPACOS, se guardan HASHEADOS (igual que el refresh de
-- sessions), vencen, y se pueden revocar de a uno o todos.
create table if not exists extension_tokens (
  token_hash   text primary key,
  user_id      uuid not null references users(id) on delete cascade,
  label        text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at   timestamptz not null,
  revoked_at   timestamptz
);

-- Para listar/revocar los tokens vivos de un usuario sin escanear la tabla.
create index if not exists extension_tokens_user_idx
  on extension_tokens (user_id) where revoked_at is null;
