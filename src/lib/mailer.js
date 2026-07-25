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

/* El mail de verificación en los 5 idiomas del producto. Antes salía SIEMPRE en
   español, así que un francés/italiano/etc. que se registraba recibía en el momento
   de más intención un mensaje que no entendía. `subject`/`text` son para el mail
   plano; `title`/`greeting`/`disclaimer` para el HTML. El idioma lo elige quien
   llama (la UI si lo manda, o el Accept-Language del navegador; ver auth.js). */
const EMAIL_I18N = {
  es: {
    subject: (c) => `${c} es tu código de verificación de Mavante`,
    title: 'Verificá tu email',
    greeting: (n, m) => `Hola ${n}, usá este código para activar tu cuenta. Vence en ${m} minutos.`,
    disclaimer: 'Si no creaste una cuenta en Mavante, ignorá este mensaje: sin el código, nadie puede activarla. Nunca te vamos a pedir este código por teléfono, chat ni redes.',
    text: (n, c, m) => `Hola ${n}. Tu código de verificación es ${c}. Vence en ${m} minutos.`,
  },
  en: {
    subject: (c) => `${c} is your Mavante verification code`,
    title: 'Verify your email',
    greeting: (n, m) => `Hi ${n}, use this code to activate your account. It expires in ${m} minutes.`,
    disclaimer: "If you didn't create a Mavante account, ignore this message: without the code, no one can activate it. We'll never ask you for this code by phone, chat or social media.",
    text: (n, c, m) => `Hi ${n}. Your verification code is ${c}. It expires in ${m} minutes.`,
  },
  fr: {
    subject: (c) => `${c} est votre code de vérification Mavante`,
    title: 'Vérifiez votre e-mail',
    greeting: (n, m) => `Bonjour ${n}, utilisez ce code pour activer votre compte. Il expire dans ${m} minutes.`,
    disclaimer: "Si vous n'avez pas créé de compte Mavante, ignorez ce message : sans le code, personne ne peut l'activer. Nous ne vous demanderons jamais ce code par téléphone, chat ou réseaux sociaux.",
    text: (n, c, m) => `Bonjour ${n}. Votre code de vérification est ${c}. Il expire dans ${m} minutes.`,
  },
  pt: {
    subject: (c) => `${c} é o seu código de verificação da Mavante`,
    title: 'Verifique seu e-mail',
    greeting: (n, m) => `Olá ${n}, use este código para ativar sua conta. Expira em ${m} minutos.`,
    disclaimer: 'Se você não criou uma conta na Mavante, ignore esta mensagem: sem o código, ninguém pode ativá-la. Nunca vamos pedir este código por telefone, chat ou redes sociais.',
    text: (n, c, m) => `Olá ${n}. Seu código de verificação é ${c}. Expira em ${m} minutos.`,
  },
  it: {
    subject: (c) => `${c} è il tuo codice di verifica di Mavante`,
    title: 'Verifica la tua email',
    greeting: (n, m) => `Ciao ${n}, usa questo codice per attivare il tuo account. Scade tra ${m} minuti.`,
    disclaimer: 'Se non hai creato un account su Mavante, ignora questo messaggio: senza il codice, nessuno può attivarlo. Non ti chiederemo mai questo codice per telefono, chat o social.',
    text: (n, c, m) => `Ciao ${n}. Il tuo codice di verifica è ${c}. Scade tra ${m} minuti.`,
  },
};
/** Idioma soportado o 'es'. */
export const emailLang = (l) => (EMAIL_I18N[l] ? l : 'es');

const template = ({ name, code, minutes, lang }) => {
  const L = EMAIL_I18N[emailLang(lang)];
  return `
<!doctype html>
<html lang="${emailLang(lang)}">
<body style="margin:0;background:#f8fafc;padding:32px 16px;font-family:'Manrope',Helvetica,Arial,sans-serif;color:#15294d">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:480px;background:#fff;border:1px solid #dbe2ec;border-radius:4px;padding:34px 34px 28px">
        <tr><td>
          <div style="font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#0b5fff;font-weight:700;margin-bottom:14px">Mavante</div>
          <h1 style="margin:0 0 10px;font-size:23px;letter-spacing:-.02em">${L.title}</h1>
          <p style="margin:0 0 22px;font-size:14.5px;line-height:1.55;color:#4b5565">
            ${L.greeting(escape(name), minutes)}
          </p>
          <div style="text-align:center;margin:0 0 22px">
            <div style="display:inline-block;font-family:'JetBrains Mono',Menlo,monospace;font-size:32px;font-weight:700;
                        letter-spacing:.28em;color:#15294d;background:#f1f5f9;border:1px solid #dbe2ec;border-radius:4px;padding:16px 20px 16px 28px">
              ${escape(code)}
            </div>
          </div>
          <p style="margin:0;font-size:12px;line-height:1.6;color:#8a93a5">
            ${L.disclaimer}
          </p>
        </td></tr>
      </table>
      <p style="max-width:480px;margin:16px auto 0;font-size:11px;color:#9aa3b2;text-align:center">
        Mavante · ${escape(config.appUrl)}
      </p>
    </td></tr>
  </table>
</body></html>`;
};

/**
 * Envía el código de verificación.
 * Sin SMTP configurado (dev), lo loguea por consola en vez de fallar.
 * El código NUNCA se devuelve al cliente.
 */
export const sendVerificationEmail = async ({ to, name, code, lang }) => {
  const minutes = config.auth.codeTtlMinutes;
  const L = EMAIL_I18N[emailLang(lang)];
  if (!transporter) {
    console.log(`[mailer:dev] código para ${to}: ${code} (vence en ${minutes} min)`);
    return { delivered: false, dev: true };
  }
  const mensaje = {
    from: config.mail.from,
    to,
    subject: L.subject(code),
    text: L.text(name, code, minutes),
    html: template({ name, code, minutes, lang }),
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

/** Saca la dirección de un "Nombre <dir@dominio>" o de un "dir@dominio" pelado. */
const soloDireccion = (s) => {
  const m = /<([^>]+)>/.exec(String(s ?? ''));
  return (m ? m[1] : String(s ?? '')).trim().toLowerCase();
};

export const verifyMailer = async () => {
  if (!transporter) return false;

  /* Zoho (y casi cualquier SMTP serio) RECHAZA un "From" que no sea la cuenta
     autenticada ni uno de sus alias: contesta 553 y el mail no sale. Sin este
     aviso, esa incompatibilidad recién se descubría cuando una persona real
     intentaba registrarse — o sea, en el peor momento y sin que nos enteremos.
     `verify()` no lo detecta: comprueba la conexión y la clave, no el remitente. */
  const from = soloDireccion(config.mail.from);
  const user = String(config.mail.user ?? '').trim().toLowerCase();
  if (user.includes('@') && from && from !== user) {
    console.warn(
      `[mailer] ⚠️  MAIL_FROM (${from}) no coincide con SMTP_USER (${user}).\n` +
      `          Zoho va a rechazar el envío con un 553 salvo que "${from}" esté\n` +
      `          dado de alta como ALIAS de esa cuenta en Zoho Mail.`,
    );
  }
  if (!from.endsWith('@mavante.com')) {
    console.warn(`[mailer] ⚠️  el remitente (${from}) no es del dominio mavante.com.`);
  }

  try {
    await transporter.verify();
    console.log(`[mailer] SMTP OK · ${config.mail.host}:${config.mail.port} · from ${from}`);
    return true;
  } catch (e) {
    /* El motivo importa: una clave mal puesta y un host de otra región de Zoho
       fallan igual de silenciosos pero se arreglan distinto. */
    console.error('[mailer] no se pudo verificar el SMTP:', e.message);
    if (/auth/i.test(e.message ?? '')) {
      console.error(
        '          Si es Zoho: revisá que SMTP_USER sea la dirección COMPLETA, que\n' +
        '          SMTP_PASS sea una contraseña de aplicación (no la de tu cuenta) y\n' +
        '          que el host sea el de TU región (smtp.zoho.com / .eu / .in).',
      );
    }
    return false;
  }
};
