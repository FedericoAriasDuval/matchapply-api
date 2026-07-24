/**
 * src/lib/consent.js
 *
 * Bitácora del consentimiento para el Panel de Talento (migración 007).
 *
 * La visibilidad OPERATIVA vive en users.is_visible_to_companies — una sola
 * fuente de verdad, opt-in, revocable. Esto es SOLO el registro auditable de
 * cuándo se dio y cuándo se retiró el consentimiento.
 *
 * Blindado a propósito: si la migración 007 todavía no corrió, las columnas no
 * existen y el UPDATE tira. Se atrapa, se loguea y se SIGUE — anotar la fecha
 * nunca puede ser el motivo por el que alguien no se pueda registrar ni cambiar
 * su visibilidad. La decisión real (verse o no) ya quedó guardada en la columna
 * que sí existe.
 */
import { query } from '../db.js';

/* La regla pura vive aparte (sin DB) para poder testearla sin env. Se re-exporta
   acá para que quien quiera "todo lo de consentimiento" lo tenga en un import. */
export { wantsCompanyVisibility } from './consent-rules.js';

export const recordConsentGiven = async (userId) => {
  try {
    await query(
      `update users
          set company_consent_at = coalesce(company_consent_at, now()),
              company_consent_withdrawn_at = null
        where id = $1`,
      [userId],
    );
  } catch (e) {
    console.warn('[consent] alta no registrada (¿migración 007 sin aplicar?):', e.message);
  }
};

export const recordConsentWithdrawn = async (userId) => {
  try {
    await query(
      `update users set company_consent_withdrawn_at = now() where id = $1`,
      [userId],
    );
  } catch (e) {
    console.warn('[consent] baja no registrada (¿migración 007 sin aplicar?):', e.message);
  }
};
