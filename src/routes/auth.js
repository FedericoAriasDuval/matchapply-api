import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { query, tx } from '../db.js';
import { DUMMY_HASH, checkPasswordStrength, hashPassword, verifyPassword } from '../lib/password.js';
import { consumeCode, inResendCooldown, issueCode } from '../lib/otp.js';
import { sendVerificationEmail } from '../lib/mailer.js';
import {
  clearAuthCookies, createSession, readRefreshCookie, revokeAllSessions, revokeSession,
  rotateSession, setAuthCookies, signAccessToken,
} from '../lib/tokens.js';
import { authenticate } from '../middleware/auth.js';
import { codeLimiter, loginLimiter, signupLimiter } from '../middleware/rateLimit.js';
import { badRequest, forbidden, tooMany, unauthorized } from '../middleware/errors.js';
import { attachReferral, creditReferral } from './referrals.js';

export const authRouter = Router();

const publicUser = (u) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  tier: u.tier,
  isVerified: u.is_verified,
  isDiscoverable: u.is_discoverable,
});

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
  isDiscoverable: z.boolean().optional().default(false),
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

    if (user) {
      // Cuenta creada pero nunca verificada: se pisan los datos y se reintenta.
      await query(
        `update users set name = $2, password_hash = $3, is_discoverable = $4 where id = $1`,
        [user.id, body.name, passwordHash, body.isDiscoverable],
      );
    } else {
      const { rows } = await query(
        `insert into users (email, name, password_hash, is_discoverable, tier, is_verified)
         values ($1, $2, $3, $4, 'free', false)
         returning id, email, is_verified`,
        [email, body.name, passwordHash, body.isDiscoverable],
      );
      user = rows[0];
    }

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
    await sendVerificationEmail({ to: email, name: body.name, code });
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
    await sendVerificationEmail({ to: user.email, name: user.name, code });
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
        await sendVerificationEmail({ to: user.email, name: user.name, code });
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

    res.json({ user: publicUser(user) });
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
    res.json({ user: publicUser(rotated.user) });
  } catch (e) {
    next(e);
  }
});

// ---------------------------------------------------------------------------
// GET /auth/me · POST /auth/logout · POST /auth/logout-all · DELETE /auth/account
// ---------------------------------------------------------------------------
authRouter.get('/me', authenticate, (req, res) => res.json({ user: publicUser(req.user) }));

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
