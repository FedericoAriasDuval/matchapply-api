// =====================================================================
// ENTRAR CON GOOGLE / LINKEDIN
//
// Los dos usan OpenID Connect, así que el flujo es el mismo y cambian solo
// las URLs. Por eso hay UN motor y dos configuraciones, en vez de dos
// implementaciones parecidas que se desincronizan con el tiempo.
//
// Tres decisiones que no son negociables acá:
//
// 1. EL `state` SE FIRMA Y SE GUARDA EN UNA COOKIE. Sin eso, cualquiera puede
//    hacer que tu navegador complete un login con la cuenta del atacante (CSRF
//    de login). Comparamos lo que vuelve de Google contra lo que guardamos.
//
// 2. SOLO ACEPTAMOS EMAILS VERIFICADOS POR EL PROVEEDOR. Google y LinkedIn
//    dicen si el mail está verificado. Si no lo está, alguien podría crear una
//    cuenta con el mail de otro y quedarse con su sesión. Sin verificar, no entra.
//
// 3. SI EL EMAIL YA EXISTE, SE VINCULA. No creamos un usuario duplicado ni
//    pisamos la contraseña: la persona es la misma, entró por otra puerta.
// =====================================================================
import { Router } from 'express';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { query } from '../db.js';
import { badRequest } from '../middleware/errors.js';
import { createSession, setAuthCookies, signAccessToken } from '../lib/tokens.js';
import { creditReferral, attachReferral } from './referrals.js';

export const oauthRouter = Router();

// ---------------------------------------------------------------------
// Las dos configuraciones. `enabled` mira si hay credenciales: sin ellas el
// proveedor no existe para nadie — ni backend ni frontend.
// ---------------------------------------------------------------------
const PROVIDERS = {
  google: {
    id: () => process.env.GOOGLE_CLIENT_ID,
    secret: () => process.env.GOOGLE_CLIENT_SECRET,
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    scope: 'openid email profile',
    // Google devuelve email_verified. Lo exigimos.
    parse: (u) => ({ email: u.email, name: u.name || u.given_name || '', verified: u.email_verified === true }),
  },
  linkedin: {
    id: () => process.env.LINKEDIN_CLIENT_ID,
    secret: () => process.env.LINKEDIN_CLIENT_SECRET,
    // LinkedIn migró a OpenID Connect: el producto se llama
    // "Sign In with LinkedIn using OpenID Connect".
    authUrl: 'https://www.linkedin.com/oauth/v2/authorization',
    tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
    userUrl: 'https://api.linkedin.com/v2/userinfo',
    scope: 'openid email profile',
    parse: (u) => ({ email: u.email, name: u.name || '', verified: u.email_verified === true }),
  },
};

const isEnabled = (k) => Boolean(PROVIDERS[k]?.id() && PROVIDERS[k]?.secret());
const callbackUrl = (k) => `${config.apiUrl || process.env.API_URL || ''}/auth/${k}/callback`;

// ---------------------------------------------------------------------
// GET /auth/providers — qué está configurado.
//
// Existe para que el frontend NO dibuje un botón que no funciona. Un botón
// que te lleva a una pantalla de error es peor que no tener botón: rompe la
// confianza justo en el momento en que la persona decide entrar.
// ---------------------------------------------------------------------
oauthRouter.get('/providers', (_req, res) => {
  res.json({ google: isEnabled('google'), linkedin: isEnabled('linkedin') });
});

/** El state firmado. No guardamos nada en memoria: el servidor puede reiniciar
 *  entre el clic y la vuelta, y el login tiene que sobrevivir a eso. */
const signState = (payload) => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', config.auth.jwtSecret).update(body).digest('base64url');
  return `${body}.${mac}`;
};
const readState = (raw) => {
  const [body, mac] = String(raw || '').split('.');
  if (!body || !mac) return null;
  const expected = crypto.createHmac('sha256', config.auth.jwtSecret).update(body).digest('base64url');
  // timingSafeEqual necesita buffers del mismo largo: si no lo son, ya es inválido.
  const a = Buffer.from(mac), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
};

// ---------------------------------------------------------------------
// GET /auth/:provider — arranca el baile.
// ---------------------------------------------------------------------
oauthRouter.get('/:provider', (req, res, next) => {
  const k = req.params.provider;
  if (!PROVIDERS[k]) return next();                       // no es nuestro: que siga la cadena
  if (!isEnabled(k)) return next(badRequest('oauth_disabled', 'Ese método de ingreso no está disponible.'));

  const p = PROVIDERS[k];
  const state = signState({ k, n: crypto.randomBytes(16).toString('hex'), t: Date.now(), ref: String(req.query.ref || '').slice(0, 16) });

  // La cookie es la otra mitad del state: el atacante puede fabricar una URL,
  // pero no puede escribir una cookie en el navegador de la víctima.
  res.cookie('ma_oauth', state, {
    httpOnly: true, secure: config.env === 'production', sameSite: 'lax', maxAge: 10 * 60_000, path: '/',
  });

  const url = new URL(p.authUrl);
  url.searchParams.set('client_id', p.id());
  url.searchParams.set('redirect_uri', callbackUrl(k));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', p.scope);
  url.searchParams.set('state', state);
  res.redirect(url.toString());
});

// ---------------------------------------------------------------------
// GET /auth/:provider/callback — la vuelta.
//
// Nunca respondemos JSON acá: el navegador viene de un redirect y la persona
// tiene que terminar en la app, no mirando un objeto.
// ---------------------------------------------------------------------
oauthRouter.get('/:provider/callback', async (req, res) => {
  const k = req.params.provider;
  const back = (err) => res.redirect(`${config.appUrl}/${err ? `?auth_error=${encodeURIComponent(err)}` : '?auth=ok'}`);

  try {
    const p = PROVIDERS[k];
    if (!p || !isEnabled(k)) return back('oauth_disabled');
    if (req.query.error) return back('cancelled');           // apretó "Cancelar": no es un error nuestro

    // El state tiene que venir Y coincidir con la cookie. Las dos cosas.
    const cookie = req.cookies?.ma_oauth;
    if (!cookie || cookie !== req.query.state) return back('state_mismatch');
    const st = readState(cookie);
    if (!st || st.k !== k || Date.now() - st.t > 10 * 60_000) return back('state_expired');
    res.clearCookie('ma_oauth', { path: '/' });

    // code -> token
    const tokRes = await fetch(p.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: String(req.query.code || ''),
        redirect_uri: callbackUrl(k),
        client_id: p.id(),
        client_secret: p.secret(),
      }),
    });
    if (!tokRes.ok) return back('token_failed');
    const tok = await tokRes.json();
    if (!tok.access_token) return back('token_failed');

    // token -> quién sos
    const uRes = await fetch(p.userUrl, { headers: { authorization: `Bearer ${tok.access_token}` } });
    if (!uRes.ok) return back('profile_failed');
    const info = p.parse(await uRes.json());

    if (!info.email) return back('no_email');
    // Sin email verificado NO entra: si no, cualquiera se registra con el mail ajeno.
    if (!info.verified) return back('email_unverified');

    const email = info.email.trim().toLowerCase();
    const { rows: found } = await query(`select * from users where email = $1`, [email]);
    let user = found[0];

    if (user) {
      // Ya existe: se vincula, no se duplica ni se pisa la contraseña.
      // Y si venía sin verificar, entrar por Google ES una verificación.
      if (!user.is_verified) {
        const { rows } = await query(`update users set is_verified = true where id = $1 returning *`, [user.id]);
        user = rows[0];
        try { await creditReferral(user.id); } catch (e) { console.error('[oauth] credito', e.message); }
      }
    } else {
      // Nace verificado: el proveedor ya confirmó el email. Pedirle un código
      // de 6 dígitos a alguien que acaba de probar su identidad es fricción sin motivo.
      // password_hash queda inutilizable a propósito: no hay contraseña que robar.
      const { rows } = await query(
        `insert into users (email, name, password_hash, tier, is_verified)
         values ($1, $2, $3, 'free', true)
         returning *`,
        [email, info.name || email.split('@')[0], `oauth:${k}:${crypto.randomBytes(24).toString('hex')}`],
      );
      user = rows[0];
      if (st.ref) {
        try {
          await attachReferral(user.id, st.ref);
          await creditReferral(user.id);
        } catch (e) { console.error('[oauth] referido', e.message); }
      }
    }

    const refresh = await createSession(user.id, req);
    setAuthCookies(res, { access: signAccessToken(user), refresh });
    return back(null);
  } catch (e) {
    console.error('[oauth] fallo', { provider: k, err: e.message });
    return back('server_error');
  }
});

export default oauthRouter;
