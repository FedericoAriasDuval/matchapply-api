/**
 * src/routes/talent.js
 * El lado del USUARIO del Panel de Talento: prender la visibilidad, apagarla, y
 * decidir qué hacer con cada empresa que se interesó.
 *
 * Está separado de /corporate a propósito: acá manda la sesión de la persona;
 * allá, la clave de la empresa. Dos mundos, dos puertas, cero cruce.
 *
 * LA REGLA: la persona decide, y su decisión tiene efecto AHORA. Apagar la
 * visibilidad es un UPDATE, no una solicitud que alguien revisa.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { badRequest } from '../middleware/errors.js';

export const talentRouter = Router();
talentRouter.use(authenticate);

/**
 * PUT /talent/visibility — prender o apagar la visibilidad.
 *
 * `visible_since` se setea al prender y se BORRA al apagar. No es un detalle:
 * si alguien vuelve a prenderla dentro de seis meses, no queremos que el panel
 * lo muestre como si llevara medio año esperando trabajo.
 */
talentRouter.put('/visibility', async (req, res, next) => {
  try {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);

    const { rows } = await query(
      `update users
          set is_visible_to_companies = $2,
              visible_since = case when $2 then coalesce(visible_since, now()) else null end
        where id = $1
        returning is_visible_to_companies, visible_since`,
      [req.user.id, enabled],
    );

    /* Al apagar, los intereses PENDIENTES se caen solos: ya no hay a quién
       mostrarle nada, y dejarlos vivos significaría que una empresa recibe un
       "sí" de alguien que se dio de baja. Los ya ACEPTADOS no se tocan: esa
       persona ya entregó su contacto y deshacerlo sería mentirle a la empresa
       sobre algo que efectivamente pasó. Para eso está el reclamo por soporte. */
    if (!enabled) {
      await query(
        `update company_interests set status = 'rejected', resolved_at = now()
          where user_id = $1 and status = 'pending'`,
        [req.user.id],
      );
    }

    res.json({
      visible: rows[0].is_visible_to_companies,
      visibleSince: rows[0].visible_since,
    });
  } catch (e) {
    next(e instanceof z.ZodError ? badRequest('invalid_payload', 'Datos inválidos.') : e);
  }
});

/**
 * GET /talent/interests — las empresas que se interesaron.
 *
 * OJO CON LO QUE **NO** SE DEVUELVE: ni el nombre ni el mail de contacto de la
 * empresa. Solo rubro y tamaño, que es lo que la persona necesita para decidir.
 * Si mostráramos el nombre antes de que acepte, la empresa estaría "presentada"
 * sin haber recibido nada a cambio, y el trato dejaría de ser parejo.
 */
talentRouter.get('/interests', async (req, res, next) => {
  try {
    const { rows } = await query(
      `select ci.id, ci.status, ci.message, ci.created_at, ci.resolved_at,
              c.sector, c.size_label,
              case when ci.status = 'accepted' then c.name else null end as company_name
         from company_interests ci
         join companies c on c.id = ci.company_id
        where ci.user_id = $1
        order by (ci.status = 'pending') desc, ci.created_at desc
        limit 100`,
      [req.user.id],
    );
    res.json({ items: rows });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /talent/interests/:id/:decision — aceptar (destaparse) o rechazar.
 *
 * El `and user_id = $2` del WHERE no es decorativo: sin eso, alguien podría
 * aceptar el interés de OTRA persona mandando un id ajeno, y con eso destapar
 * el contacto de un tercero. El id se valida contra el dueño, siempre.
 */
talentRouter.post('/interests/:id/:decision', async (req, res, next) => {
  try {
    const { id, decision } = z
      .object({ id: z.string().uuid(), decision: z.enum(['accept', 'reject']) })
      .parse(req.params);

    const nuevo = decision === 'accept' ? 'accepted' : 'rejected';
    const { rows } = await query(
      `update company_interests
          set status = $3, resolved_at = now()
        where id = $1 and user_id = $2 and status = 'pending'
        returning id, status, resolved_at`,
      [id, req.user.id, nuevo],
    );

    /* Sin fila: o el id no existe, o no es suyo, o ya lo había resuelto. Las
       tres se contestan igual — decir "ese interés no es tuyo" le confirmaría a
       alguien que ese id existe. */
    if (!rows[0]) throw badRequest('interest_not_found', 'Ese pedido ya no está disponible.');

    res.json({ interest: rows[0] });
  } catch (e) {
    next(e instanceof z.ZodError ? badRequest('invalid_payload', 'Datos inválidos.') : e);
  }
});
