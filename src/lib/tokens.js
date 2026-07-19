import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query } from '../db.js';

const ACCESS_COOKIE = 'ma_at';
const REFRESH_COOKIE = 'ma_rt';

export const signAccessToken = (user) =>
  jwt.sign(
    { sub: user.id, email: user.email, tier: user.tier, verified: user.is_verified },
    config.auth.jwtSecret,
    { expiresIn: config.auth.accessTtl, issuer: 'mavante', audience: 'mavante-web' },
  );

export const verifyAccessToken = (token) =>
  // algorithms fijo: no aceptamos que el token declare su propio alg. (Audit L5.)
  jwt.verify(token, config.auth.jwtSecret, { algorithms: ['HS256'], issuer: 'mavante', audience: 'mavante-web' });

const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

/** Crea una sesión con refresh token opaco (se guarda hasheado). */
export const createSession = async (userId, req) => {
  const raw = crypto.randomBytes(48).toString('base64url');
  const expiresAt = new Date(Date.now() + config.auth.refreshTtlDays * 86_400_000);
  await query(
    `insert into sessions (user_id, token_hash, user_agent, ip, expires_at)
     values ($1, $2, $3, $4, $5)`,
    [userId, hashToken(raw), req.get('user-agent')?.slice(0, 300) ?? null, req.ip, expiresAt],
  );
  return { raw, expiresAt };
};

/** Rotación: valida el refresh, lo revoca y emite uno nuevo. */
export const rotateSession = async (rawToken, req) => {
  const { rows } = await query(
    `select * from sessions where token_hash = $1 and revoked_at is null and expires_at > now()`,
    [hashToken(rawToken)],
  );
  const session = rows[0];
  if (!session) return null;

  await query(`update sessions set revoked_at = now() where id = $1`, [session.id]);
  const fresh = await createSession(session.user_id, req);
  const { rows: users } = await query(`select * from users where id = $1`, [session.user_id]);
  return users[0] ? { user: users[0], refresh: fresh } : null;
};

export const revokeSession = async (rawToken) => {
  if (!rawToken) return;
  await query(`update sessions set revoked_at = now() where token_hash = $1 and revoked_at is null`, [
    hashToken(rawToken),
  ]);
};

export const revokeAllSessions = (userId) =>
  query(`update sessions set revoked_at = now() where user_id = $1 and revoked_at is null`, [userId]);

const baseCookie = {
  httpOnly: true,
  secure: config.isProd,
  // Lax, no None: el front (mavante.com) y la API (api.mavante.com) son
  // same-site, así que la cookie viaja igual en los requests legítimos, y Lax
  // corta el envío cross-site que habilitaba CSRF. OAuth ya usaba Lax. (Audit M3.)
  sameSite: 'lax',
  domain: config.auth.cookieDomain,
  path: '/',
};

export const setAuthCookies = (res, { access, refresh }) => {
  res.cookie(ACCESS_COOKIE, access, { ...baseCookie, maxAge: 15 * 60_000 });
  res.cookie(REFRESH_COOKIE, refresh.raw, {
    ...baseCookie,
    maxAge: config.auth.refreshTtlDays * 86_400_000,
  });
};

export const clearAuthCookies = (res) => {
  res.clearCookie(ACCESS_COOKIE, baseCookie);
  res.clearCookie(REFRESH_COOKIE, baseCookie);
};

export const readAccessCookie = (req) => req.cookies?.[ACCESS_COOKIE] ?? null;
export const readRefreshCookie = (req) => req.cookies?.[REFRESH_COOKIE] ?? null;
