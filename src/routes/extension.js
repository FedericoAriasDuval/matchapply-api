import { Router } from 'express';
import { config } from '../config.js';
import { authenticate } from '../middleware/auth.js';
import { tieneAlMenos } from '../lib/tier.js';

/* Sesión de la EXTENSIÓN de Chrome (feature Pro). La extensión pregunta si el usuario
   autenticado tiene Pro ACTIVO. `authenticate` acepta cookie httpOnly O Authorization:
   Bearer (el flujo real de la extensión usará un token — ver extension/README.md), y
   `req.user.tier` ya es el tier EFECTIVO (respeta vencimiento de la suscripción). */
export const extensionRouter = Router();

/* GET /extension/session
   - No logueado          → 401 (authenticate).
   - Logueado, NO Pro     → 403 con payload explicativo + link de upgrade (CTA en la extensión).
   - Logueado, Pro activo → 200 con los datos mínimos de la sesión. */
extensionRouter.get('/session', authenticate, (req, res) => {
  if (!tieneAlMenos(req.user, 'pro')) {
    return res.status(403).json({
      ok: false,
      code: 'pro_required',
      message: 'La extensión de Mavante es parte del plan Pro.',
      upgradeUrl: `${config.appUrl}/#precios`,
    });
  }
  res.json({
    ok: true,
    tier: req.user.tier,
    user: { id: req.user.id, email: req.user.email, name: req.user.name },
    accessUntil: req.user.accesoHasta ?? null,
  });
});
