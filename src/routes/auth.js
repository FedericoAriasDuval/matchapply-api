import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { query, tx } from '../db.js';
import { DUMMY_HASH, checkPasswordStrength, hashPassword, verifyPassword } from '../lib/password.js';
import { consumeCode, inResendCooldown, issueCode } from '../lib/otp.js';
import { sendVerificationEmail } from '../lib/mailer.js';
import {
  clearAuthCookies, createSession, readAccessCookie, readRefreshCookie, revokeAllSessions,
  revokeSession, rotateSession, setAuthCookies, signAccessToken, verifyAccessToken,
} from '../lib/tokens.js';
import { authenticate } from '../middleware/auth.js';
import { SELECT_USER_CON_ACCESO, tierEfectivo } from '../lib/tier.js';
import { recordConsentGiven, wantsCompanyVisibility } from '../lib/consent.js';
import { codeLimiter, loginLimiter, signupLimiter } from '../middleware/rateLimit.js';
import { HttpError, badRequest, forbidden, tooMany, unauthorized } from '../middleware/errors.js';
import { attachReferral, creditReferral } from './referrals.js';

export const authRouter = Router();

/**
 * Manda el código y traduce una falla del SMTP a algo que la persona entiende.
 *
 * Sin esto, un hipo del proveedor de mail salía como error 500 genérico ("algo
 * se rompió de nuestro lado") justo en el alta, que es el momento de más
 * intención de toda la web. Con `mail_failed` decimos la verdad —el mail no
 * salió— y le damos la única salida real: volver a pedirlo. La cuenta ya quedó
 * creada sin verificar, así que reintentar funciona.
 */
const enviarCodigo = async ({ to, name, code }) => {
  try {
    await sendVerificationEmail({ to, name, code });
  } catch (e) {
    throw new HttpError(503, 'mail_failed', 'No pudimos enviarte el código.', { email: to });
  }
};

const publicUser = (u) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  tier: u.tier,
  /* QUÉ tipo de acceso tiene, no solo si tiene. Lo usa el front para no
     ofrecerle comprar lo que ya está pagando: sin esto, la pantalla le vende
     Pro a alguien que ya es Pro. null cuando nunca pagó nada. */
  accessType: u.sub_provider ?? null,
  accessUntil: u.sub_until ?? null,
  isVerified: u.is_verified,
  /* ?? false: la columna puede no venir en el SELECT (o no existir todavia, si
     la migracion 005 no corrio). El perfil no puede romperse por eso. */
  isVisibleToCompanies: u.is_visible_to_companies ?? false,
});

/* El tier que viaja al front tiene que ser el EFECTIVO también en login y en el
   refresh. Esos caminos traen la fila de users sin el join de subscriptions, y
   sin esto alguien con el pase semanal vencido vería la interfaz Pro mientras el
   servidor lo trata como free — el peor de los dos mundos: promete y no cumple. */
const conTierEfectivo = async (u) => {
  if (!u) return u;
  if (u.sub_provider === undefined) {
    const { rows } = await query(
      `select provider as sub_provider, current_period_end as sub_until from subscriptions where user_id = $1`,
      [u.id],
    );
    Object.assign(u, rows[0] ?? { sub_provider: null, sub_until: null });
  }
  u.tier = tierEfectivo(u);
  return u;
};

const audit = (req, event, { userId = null, email = null } = {}) =>
  query(
    `insert into auth_events (user_id, email, event, ip, user_agent) values ($1, $2, $3, $4, $5)`,
    [userId, email, event, req.ip, req.get('user-agent')?.slice(0, 300) ?? null],
  ).catch(() => {});

const signupSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().email().max(160),
  password: z.string().min(1).max(128),
  passwordConfirm: z.string().min(1).max(128),
  // OPT-IN, desmarcado por defecto: compartir el perfil con empresas es una
  // elección, nunca un requisito. `isDiscoverable` es el nombre viejo (pre
  // rename de la migración 005) que el front todavía puede mandar durante la
  // ventana de deploy: se acepta como alias para que ningún consentimiento se
  // pierda si el front y el back no despliegan exactamente a la vez.
  isVisibleToCompanies: z.boolean().optional(),
  isDiscoverable: z.boolean().optional(),
  // El codigo de invitacion. Opcional y tolerante: si viene roto, la persona se
  // registra igual. Nadie se queda afuera por un link mal pegado.
  ref: z.string().trim().max(16).optional(),
});

// ---------------------------------------------------------------------------
// POST /auth/signup — crea la cuenta SIN verificar y dispara el código por mail
// ---------------------------------------------------------------------------
authRouter.post('/signup', signupLimiter, async (req, res, next) => {
  try {
    const body = signupSchema.parse(req.body);

    if (body.password !== body.passwordConfirm) {
      throw badRequest('password_mismatch', 'Las contraseñas no coinciden.');
    }
    const strength = checkPasswordStrength(body.password);
    if (!strength.ok) {
      throw badRequest('weak_password', 'La contraseña no cumple los requisitos.', {
        failed: strength.failed,
      });
    }

    const email = body.email.toLowerCase();
    const { rows: existing } = await query(
      `select id, is_verified from users where email = $1`, [email],
    );

    let user = existing[0];

    if (user?.is_verified) {
      // No revelamos si el mail existe: respondemos igual que en el alta.
      await audit(req, 'signup_existing', { userId: user.id, email });
      return res.status(202).json({
        status: 'pending_verification',
        email,
        expiresInMinutes: config.auth.codeTtlMinutes,
      });
    }

    const passwordHash = await hashPassword(body.password);
    // La elección del checkbox opt-in (acepta nombre nuevo y viejo). Ver consent.js.
    const wantsVisible = wantsCompanyVisibility(body);

    if (user) {
      // Cuenta creada pero nunca verificada: se pisan los datos y se reintenta.
      await query(
        `update users
            set name = $2, password_hash = $3, is_visible_to_companies = $4,
                visible_since = case when $4 then coalesce(visible_since, now()) else null end
          where id = $1`,
        [user.id, body.name, passwordHash, wantsVisible],
      );
    } else {
      const { rows } = await query(
        `insert into users (email, name, password_hash, tier, is_verified, is_visible_to_companies, visible_since)
         values ($1, $2, $3, 'free', false, $4, case when $4 then now() else null end)
         returning id, email, is_verified`,
        [email, body.name, passwordHash, wantsVisible],
      );
      user = rows[0];
    }
    /* Bitácora del consentimiento (blindada: si la migración 007 no corrió, la
       elección ya quedó en is_visible_to_companies y esto solo no anota la fecha). */
    if (wantsVisible) await recordConsentGiven(user.id);

    /* La invitacion se ANOTA aca (no se paga): el pago llega cuando verifica el
       email, en POST /auth/verify. Si algo falla, el registro sigue: el
       programa de referidos no puede ser el motivo por el que alguien no puede
       crear una cuenta. */
    if (body.ref) {
      try {
        const r = await attachReferral(user.id, body.ref);
        if (r.attached) await audit(req, 'referral_attached', { userId: user.id, code: body.ref });
      } catch (e) {
        console.error('[referrals] attach fallo en signup', { userId: user.id, err: e.message });
      }
    }

    const { code } = await issueCode(user.id, 'signup');
    await enviarCodigo({ to: email, name: body.name, code });
    await audit(req, 'signup', { userId: user.id, email });

    // El código NUNCA vuelve al cliente.
    res.status(202).json({
      status: 'pending_verification',
      email,
      expiresInMinutes: config.auth.codeTtlMinutes,
      resendCooldownSeconds: config.auth.resendCooldownSeconds,
    });
  } catch (e) {
    next(e instanceof z.ZodError ? badRequest('invalid_payload', 'Revisá los datos del formulario.') : e);
  }
});

// ---------------------------------------------------------------------------
// POST /auth/verify — valida el código de 6 dígitos y activa la cuenta
// ---------------------------------------------------------------------------
const verifySchema = z.object({
  email: z.string().trim().email(),
  code: z.string().trim().regex(/^\d{6}$/, 'El código tiene 6 dígitos.'),
});

authRouter.post('/verify', codeLimiter, async (req, res, next) => {
  try {
    const { email, code } = verifySchema.parse(req.body);
    const { rows } = await query(`select * from users where email = $1`, [email.toLowerCase()]);
    const user = rows[0];
    if (!user) throw badRequest('invalid_code', 'Código inválido o vencido.');

    if (user.is_verified) throw badRequest('already_verified', 'Esta cuenta ya está verificada.');

    const result = await consumeCode(user.id, code, 'signup');
    if (!result.ok) {
      await audit(req, 'verify_fail', { userId: user.id, email: user.email });
      const map = {
        expired: ['code_expired', 'El código venció. Pedí uno nuevo.'],
        too_many: ['code_too_many', 'Demasiados intentos. Pedí un código nuevo.'],
        not_found: ['code_expired', 'El código venció. Pedí uno nuevo.'],
        wrong: ['invalid_code', 'Código incorrecto.'],
      };
      const [code_, message] = map[result.reason] ?? map.wrong;
      throw badRequest(code_, message, result.left !== undefined ? { attemptsLeft: result.left } : {});
    }

    const verified = await tx(async (client) => {
      const { rows: u } = await client.query(
        `update users set is_verified = true where id = $1 returning *`, [user.id],
      );
      return u[0];
    });

    /* ACA se paga el referido, y no antes.
       Si pagaramos al hacer clic en el link, el programa no conseguiria
       usuarios: conseguiria cuentas falsas. Un email verificado es la barrera
       mas barata que separa a una persona de un script.

       Va FUERA de la transaccion de arriba a proposito: si el credito falla,
       la cuenta igual queda verificada. Nadie se puede quedar sin poder entrar
       porque nuestro programa de referidos tuvo un mal dia. */
    let referral = null;
    try {
      const r = await creditReferral(verified.id);
      if (r.credited) referral = { sims: r.sims };
    } catch (e) {
      console.error('[referrals] no se pudo acreditar', { userId: verified.id, err: e.message });
    }

    const refresh = await createSession(verified.id, req);
    setAuthCookies(res, { access: signAccessToken(verified), refresh });
    await audit(req, 'verify_ok', { userId: verified.id, email: verified.email });

    res.json({ user: publicUser(verified), referral });
  } catch (e) {
    next(e instanceof z.ZodError ? badRequest('invalid_payload', 'Código inválido.') : e);
  }
});

// ---------------------------------------------------------------------------
// POST /auth/resend — reenvía el código (con cooldown)
// ---------------------------------------------------------------------------
authRouter.post('/resend', codeLimiter, async (req, res, next) => {
  try {
    const { email } = z.object({ email: z.string().trim().email() }).parse(req.body);
    const { rows } = await query(`select * from users where email = $1`, [email.toLowerCase()]);
    const user = rows[0];

    // Respuesta uniforme aunque el mail no exista (no filtramos qué cuentas hay).
    if (!user || user.is_verified) {
      return res.status(202).json({ status: 'sent', resendCooldownSeconds: config.auth.resendCooldownSeconds });
    }

    const wait = await inResendCooldown(user.id, 'signup');
    if (wait > 0) throw tooMany('resend_cooldown', `Esperá ${wait} segundos antes de pedir otro código.`, { wait });

    const { code } = await issueCode(user.id, 'signup');
    await enviarCodigo({ to: user.email, name: user.name, code });
    await audit(req, 'resend', { userId: user.id, email: user.email });

    res.status(202).json({ status: 'sent', resendCooldownSeconds: config.auth.resendCooldownSeconds });
  } catch (e) {
    next(e instanceof z.ZodError ? badRequest('invalid_payload', 'Email inválido.') : e);
  }
});

// ---------------------------------------------------------------------------
// POST /auth/login
// ---------------------------------------------------------------------------
authRouter.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const { email, password } = z
      .object({ email: z.string().trim().email(), password: z.string().min(1).max(128) })
      .parse(req.body);

    const { rows } = await query(`select * from users where email = $1`, [email.toLowerCase()]);
    const user = rows[0];

    // Mismo mensaje para usuario inexistente y contraseña incorrecta (anti-enumeración).
    const invalid = unauthorized('invalid_credentials', 'Email o contraseña incorrectos.');
    if (!user) {
      await verifyPassword(password, DUMMY_HASH);
      throw invalid;
    }

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      throw tooMany('account_locked', 'Cuenta bloqueada temporalmente por intentos fallidos.');
    }

    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
      const failed = user.failed_logins + 1;
      const lock = failed >= config.auth.maxFailedLogins;
      await query(
        `update users set failed_logins = $2, locked_until = $3 where id = $1`,
        [user.id, lock ? 0 : failed, lock ? new Date(Date.now() + config.auth.lockoutMinutes * 60_000) : null],
      );
      await audit(req, lock ? 'lockout' : 'login_fail', { userId: user.id, email: user.email });
      throw invalid;
    }

    if (!user.is_verified) {
      const wait = await inResendCooldown(user.id, 'signup');
      if (wait === 0) {
        const { code } = await issueCode(user.id, 'signup');
        /* Acá el mail es un EXTRA: la respuesta real es "verificá tu email".
           Si el envío falla, se loguea y se sigue — tapar esa respuesta con un
           error de mail dejaría a la persona sin entender por qué no entra. */
        try {
          await sendVerificationEmail({ to: user.email, name: user.name, code });
        } catch (e) {
          console.error('[auth] login de cuenta sin verificar: el reenvío del código falló', e?.message);
        }
      }
      throw forbidden('not_verified', 'Verificá tu email para entrar.', {
        email: user.email,
        expiresInMinutes: config.auth.codeTtlMinutes,
      });
    }

    await query(
      `update users set failed_logins = 0, locked_until = null, last_login_at = now() where id = $1`,
      [user.id],
    );
    const refresh = await createSession(user.id, req);
    setAuthCookies(res, { access: signAccessToken(user), refresh });
    await audit(req, 'login_ok', { userId: user.id, email: user.email });

    res.json({ user: publicUser(await conTierEfectivo(user)) });
  } catch (e) {
    next(e instanceof z.ZodError ? badRequest('invalid_payload', 'Datos inválidos.') : e);
  }
});

// ---------------------------------------------------------------------------
// POST /auth/refresh — rota el refresh token y renueva el access token
// ---------------------------------------------------------------------------
authRouter.post('/refresh', async (req, res, next) => {
  try {
    const raw = readRefreshCookie(req);
    if (!raw) throw unauthorized();
    const rotated = await rotateSession(raw, req);
    if (!rotated) {
      clearAuthCookies(res);
      throw unauthorized('session_expired', 'Tu sesión expiró.');
    }
    setAuthCookies(res, { access: signAccessToken(rotated.user), refresh: rotated.refresh });
    res.json({ user: publicUser(await conTierEfectivo(rotated.user)) });
  } catch (e) {
    next(e);
  }
});

// ---------------------------------------------------------------------------
// GET /auth/me · POST /auth/logout · POST /auth/logout-all · DELETE /auth/account
// ---------------------------------------------------------------------------
/**
 * GET /auth/me — "¿quién soy?"
 *
 * POR QUÉ NO LLEVA `authenticate` DELANTE (y no es un descuido):
 * es una PREGUNTA, y "nadie" es una respuesta válida, no un error. Con el
 * middleware adelante, cada visita sin sesión —o con el token de acceso vencido,
 * que dura 15 minutos— dejaba un 401 rojo en la consola del navegador. Y eso NO
 * se puede tapar desde el frontend: lo imprime la capa de red, antes de que el
 * JavaScript pueda atraparlo. Encima disparaba un /auth/refresh que también
 * fallaba, así que eran dos errores por visita.
 *
 * Además se cura solo: si el acceso venció pero el refresh sigue vivo, rota la
 * sesión acá mismo. Antes eso costaba DOS viajes (401 → refresh → reintento) y
 * ahora es uno. Ojo con la tentación de "arreglarlo" devolviendo user:null sin
 * intentar la rotación: dejaría afuera a cualquiera que vuelve después de 15
 * minutos con su sesión perfectamente válida.
 *
 * Sigue sin filtrar nada: sin cookies válidas, la respuesta es user:null.
 */
authRouter.get('/me', async (req, res, next) => {
  try {
    /* 1) ¿Hay un token de acceso que valga? */
    const bearer = req.get('authorization')?.replace(/^Bearer\s+/i, '');
    const token = readAccessCookie(req) ?? bearer;
    if (token) {
      try {
        const payload = verifyAccessToken(token);
        /* Mismo SELECT y misma regla que el middleware: si /auth/me mirara solo
           users.tier, el front creería Pro a alguien con el pase ya vencido y
           chocaría contra el candado del servidor. */
        const { rows } = await query(SELECT_USER_CON_ACCESO, [payload.sub]);
        if (rows[0]) rows[0].tier = tierEfectivo(rows[0]);
        /* Sin verificar el email no hay sesión utilizable: se contesta "nadie"
           en vez de un 403, que dejaría el mismo error rojo. */
        if (rows[0]?.is_verified) return res.json({ user: publicUser(rows[0]) });
      } catch { /* token vencido o roto: seguimos al refresh */ }
    }

    /* 2) El acceso no sirve, pero el refresh puede seguir vivo. */
    const raw = readRefreshCookie(req);
    if (raw) {
      const rotated = await rotateSession(raw, req);
      if (rotated) {
        setAuthCookies(res, { access: signAccessToken(rotated.user), refresh: rotated.refresh });
        return res.json({ user: publicUser(await conTierEfectivo(rotated.user)) });
      }
      clearAuthCookies(res);   // refresh muerto: que el navegador no lo siga mandando
    }

    /* 3) No hay sesión. Es una respuesta, no una falla. */
    res.json({ user: null });
  } catch (e) {
    next(e);
  }
});

authRouter.post('/logout', async (req, res, next) => {
  try {
    await revokeSession(readRefreshCookie(req));
    clearAuthCookies(res);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

authRouter.post('/logout-all', authenticate, async (req, res, next) => {
  try {
    await revokeAllSessions(req.user.id);
    clearAuthCookies(res);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

/** Borrado real de cuenta y de todos sus datos (cascade). */
authRouter.delete('/account', authenticate, async (req, res, next) => {
  try {
    await query(`delete from users where id = $1`, [req.user.id]);
    clearAuthCookies(res);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
