/**
 * src/lib/password.js
 * Hashing con bcrypt (cost 12). La contraseña en claro nunca se persiste ni se loguea.
 */
import bcrypt from 'bcrypt';
import { config } from '../config.js';

export { PASSWORD_RULES, checkPasswordStrength } from './passwordPolicy.js';

export const hashPassword = (plain) => bcrypt.hash(String(plain), config.auth.bcryptRounds);

export const verifyPassword = (plain, hash) => bcrypt.compare(String(plain), String(hash));

/** Hash falso con el mismo costo: se compara igual cuando el usuario no existe (anti timing attack). */
export const DUMMY_HASH = '$2b$12$C6UzMDM.H6dfI/f/IKcEeO1yq0bcCiGmSbcHCPtvKb7YFTB8hjTBW';
