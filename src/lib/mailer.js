import nodemailer from 'nodemailer';
import { config } from '../config.js';

/* Los timeouts NO son opcionales acá. Por defecto nodemailer espera 2 minutos
   para conectar y 10 para el socket: un SMTP que no contesta dejaba al que se
   estaba registrando mirando una pantalla girando durante minutos, en el peor
   momento posible. Preferimos fallar en 10 segundos y ofrecerle reintentar.
   `pool` reusa la conexión: en un pico de altas, abrir un socket TLS nuevo por
   cada mail es lo que hace que el proveedor nos empiece a rechazar. */
const transporter = config.mail.enabled
  ? nodemailer.createTransport({
      host: config.mail.host,
      port: config.mail.port,
      secure: config.mail.port === 465,
      auth: { user: config.mail.user, pass: config.mail.pass },
      pool: true,
      maxConnections: 3,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    })
  : null;

/* Un 4xx del SMTP (buzón lleno, límite momentáneo, "intentá más tarde") se
   reintenta; un 5xx (la dirección no existe) no, porque reintentar no la va a
   hacer existir. */
const vaDeNuevo = (e) => {
  const code = Number(e?.responseCode ?? 0);
  if (code >= 500 && code < 600) return false;
  return true;
};

const escape = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const template = ({ name, code, minutes }) => `
<!doctype html>
<html lang="es">
<body style="margin:0;background:#f8fafc;padding:32px 16px;font-family:'Manrope',Helvetica,Arial,sans-serif;color:#15294d">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:480px;background:#fff;border:1px solid #dbe2ec;border-radius:4px;padding:34px 34px 28px">
        <tr><td>
          <div style="font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#0b5fff;font-weight:700;margin-bottom:14px">Mavante</div>
          <h1 style="margin:0 0 10px;font-size:23px;letter-spacing:-.02em">Verificá tu email</h1>
          <p style="margin:0 0 22px;font-size:14.5px;line-height:1.55;color:#4b5565">
            Hola ${escape(name)}, usá este código para activar tu cuenta. Vence en ${minutes} minutos.
          </p>
          <div style="text-align:center;margin:0 0 22px">
            <div style="display:inline-block;font-family:'JetBrains Mono',Menlo,monospace;font-size:32px;font-weight:700;
                        letter-spacing:.28em;color:#15294d;background:#f1f5f9;border:1px solid #dbe2ec;border-radius:4px;padding:16px 20px 16px 28px">
              ${escape(code)}
            </div>
          </div>
          <p style="margin:0;font-size:12px;line-height:1.6;color:#8a93a5">
            Si no creaste una cuenta en Mavante, ignorá este mensaje: sin el código, nadie puede activarla.
            Nunca te vamos a pedir este código por teléfono, chat ni redes.
          </p>
        </td></tr>
      </table>
      <p style="max-width:480px;margin:16px auto 0;font-size:11px;color:#9aa3b2;text-align:center">
        Mavante · ${escape(config.appUrl)}
      </p>
    </td></tr>
  </table>
</body></html>`;

/**
 * Envía el código de verificación.
 * Sin SMTP configurado (dev), lo loguea por consola en vez de fallar.
 * El código NUNCA se devuelve al cliente.
 */
export const sendVerificationEmail = async ({ to, name, code }) => {
  const minutes = config.auth.codeTtlMinutes;
  if (!transporter) {
    console.log(`[mailer:dev] código para ${to}: ${code} (vence en ${minutes} min)`);
    return { delivered: false, dev: true };
  }
  const mensaje = {
    from: config.mail.from,
    to,
    subject: `${code} es tu código de verificación de Mavante`,
    text: `Hola ${name}. Tu código de verificación es ${code}. Vence en ${minutes} minutos.`,
    html: template({ name, code, minutes }),
  };

  /* Un intento y un reintento. La mayoría de las fallas de SMTP son un hipo de
     un segundo; morirse en el primero convierte un hipo del proveedor en una
     cuenta que nunca se creó. Más de un reintento no: la persona está esperando. */
  let ultimo;
  for (let intento = 0; intento < 2; intento++) {
    try {
      await transporter.sendMail(mensaje);
      if (intento > 0) console.warn('[mailer] salió en el reintento, para', to);
      return { delivered: true };
    } catch (e) {
      ultimo = e;
      if (!vaDeNuevo(e) || intento === 1) break;
      await new Promise((r) => setTimeout(r, 600));
    }
  }
  /* El código JAMÁS se loguea junto al error: un log de producción no es un
     lugar seguro para una credencial de un solo uso. */
  console.error('[mailer] no se pudo entregar el código a', to, '·', ultimo?.responseCode ?? '?', ultimo?.message);
  throw ultimo;
};

export const verifyMailer = async () => {
  if (!transporter) return false;
  try {
    await transporter.verify();
    return true;
  } catch (e) {
    console.error('[mailer] no se pudo verificar el SMTP:', e.message);
    return false;
  }
};
