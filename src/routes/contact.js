/**
 * src/routes/contact.js
 * Formulario de contacto ("Stuck on something?").
 *
 * POR QUÉ EXISTE: el frontend mandaba el contacto por `mailto:`, que abre el
 * cliente de correo del visitante. En mucha gente (móvil sin app de mail,
 * usuarios de webmail) eso no hace NADA y el mensaje se pierde en silencio.
 * Este endpoint lo manda de verdad, por SMTP, a la casilla de soporte.
 *
 * No guarda en base: un contacto es un mail, y el lugar natural para leerlo y
 * responderlo es la bandeja de soporte (Reply-To apunta al usuario). Sin tabla,
 * sin migración, sin panel que nadie mira dos veces.
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncRoute } from '../middleware/errors.js';
import { reviewLimiter } from '../middleware/rateLimit.js';
import { sendContactEmail } from '../lib/mailer.js';

export const contactRouter = Router();

const schema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(160),
  message: z.string().trim().min(1).max(4000),
  lang: z.string().trim().max(5).optional().default('es'),
});

contactRouter.post(
  '/',
  reviewLimiter, // mismo perfil de abuso que las reseñas: form público de baja frecuencia
  asyncRoute(async (req, res) => {
    const body = schema.parse(req.body);
    await sendContactEmail(body);
    res.status(201).json({ ok: true });
  }),
);
