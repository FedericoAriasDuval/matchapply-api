-- ============================================================================
-- 007 · Registro DURABLE del consentimiento para el Panel de Talento
--
-- QUÉ RESUELVE: el usuario puede prender y apagar su visibilidad para empresas
-- (eso ya existe en `is_visible_to_companies`, opt-in, revocable). Lo que faltaba
-- era un registro AUDITABLE de CUÁNDO dio y cuándo retiró ese consentimiento —
-- el dato que te salva si alguien alguna vez reclama "yo nunca autoricé".
--
-- POR QUÉ NO ES UN SEGUNDO FLAG: la migración 005 renombró is_discoverable a
-- is_visible_to_companies justo para NO tener dos banderas de la misma decisión
-- (el peor bug de privacidad: una se actualiza y la otra no). Acá se respeta esa
-- regla. `is_visible_to_companies` sigue siendo la ÚNICA fuente de verdad de "¿me
-- ven ahora?". Estas columnas son solo la bitácora del consentimiento, no un
-- estado operativo — a diferencia de `visible_since`, NO se borran al apagar, así
-- que sobreviven como prueba de que el consentimiento existió.
--
-- POR QUÉ VIAJA SOLA Y ANTES DEL CÓDIGO: una migración y el código que la usa
-- nunca salen en el mismo deploy (rompió producción con la 005). El código que
-- escribe estas columnas está blindado: si esta migración todavía no corrió, la
-- visibilidad sigue funcionando igual y el timestamp simplemente no se anota
-- hasta que la apliques. Aplicá esto en Neon PRIMERO, después el Manual Deploy.
--
-- NADA DE SNAPSHOT: por decisión de producto (23/07/2026), NO se guarda una copia
-- congelada del perfil. Las empresas ven el perfil VIVO; si el usuario lo edita o
-- borra la cuenta, el cambio se refleja al instante. Por eso acá no hay ninguna
-- columna de datos del perfil: solo fechas de consentimiento.
-- ============================================================================

alter table users add column if not exists company_consent_at timestamptz;
alter table users add column if not exists company_consent_withdrawn_at timestamptz;

-- A quien YA está visible pero no tiene fecha de consentimiento, se le pone la
-- que se pueda afirmar con honestidad: desde cuándo está visible, o ahora. Es lo
-- único cierto que tenemos de antes de que existiera esta bitácora.
update users
   set company_consent_at = coalesce(company_consent_at, visible_since, now())
 where is_visible_to_companies = true
   and company_consent_at is null;
