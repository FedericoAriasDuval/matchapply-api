-- 002_reviews.sql
-- Las reseñas son PRIVADAS. No se muestran en la web, ni a otros usuarios, ni a
-- nadie. Son para nosotros dos y para nadie más.
--
-- La razón no es de producto, es de honestidad: si las mostráramos, tendríamos
-- el incentivo permanente de esconder las malas. Y el día que escondemos una
-- reseña mala, ya somos la empresa que no queríamos ser. Guardándolas privadas,
-- nadie tiene nada que maquillar.

create table if not exists reviews (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references users(id) on delete set null,   -- puede ser anónima
  stars        smallint not null check (stars between 1 and 5),
  comment      text,
  name         text,
  page         text,                                            -- desde dónde la dejó
  lang         text,
  user_agent   text,
  ip_hash      text,                                            -- hash, NUNCA la IP en claro
  created_at   timestamptz not null default now()
);

create index if not exists reviews_created_idx on reviews (created_at desc);
create index if not exists reviews_stars_idx   on reviews (stars);
