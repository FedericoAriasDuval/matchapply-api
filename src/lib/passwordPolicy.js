/**
 * src/lib/passwordPolicy.js
 * Política de contraseñas — módulo puro (sin dependencias, testeable en aislamiento).
 * Es la misma que el frontend muestra en vivo, pero la que decide es esta.
 */
export const PASSWORD_RULES = [
  { id: 'len',   test: (v) => v.length >= 8,                           message: 'Mínimo 8 caracteres' },
  { id: 'upper', test: (v) => /[A-Z]/.test(v),                         message: 'Al menos una mayúscula' },
  { id: 'lower', test: (v) => /[a-z]/.test(v),                         message: 'Al menos una minúscula' },
  { id: 'num',   test: (v) => /[0-9]/.test(v),                         message: 'Al menos un número' },
  { id: 'sym',   test: (v) => /[@$!%*?&#^()\-_+=.,;:{}\[\]~]/.test(v), message: 'Al menos un carácter especial' },
];

/** Contraseñas comunes: se rechazan aunque cumplan el patrón. */
const BLOCKLIST = new Set([
  'password1!', 'password123!', 'admin1234!', 'qwerty123!', 'welcome1!',
  'matchapply1!', 'contraseña1!', 'passw0rd!', 'abcd1234!', 'iloveyou1!',
]);

/** @returns {{ok: boolean, failed: string[], score: number}} */
export const checkPasswordStrength = (raw) => {
  const value = String(raw ?? '');
  const failed = PASSWORD_RULES.filter((r) => !r.test(value)).map((r) => r.message);
  if (value.length > 128) failed.push('Máximo 128 caracteres');
  if (BLOCKLIST.has(value.toLowerCase())) failed.push('Es una contraseña demasiado común');
  return { ok: failed.length === 0, failed, score: PASSWORD_RULES.length - failed.length };
};
