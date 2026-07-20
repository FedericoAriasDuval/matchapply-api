/**
 * src/lib/anon.js
 * Convierte el CV de una persona en un perfil que una empresa puede ver SIN
 * saber quién es.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * LA DECISIÓN DE DISEÑO MÁS IMPORTANTE DE ESTE ARCHIVO: LISTA BLANCA.
 *
 * La consigna decía "borrá estos campos" (nombre, email, teléfono, links). Eso
 * es una lista NEGRA, y una lista negra falla ABIERTA: el día que alguien
 * agregue un campo al CV —un `portfolio`, un `twitter`, un `dni`— nadie se va a
 * acordar de sumarlo a la lista, y ese campo va a salir publicado. El error no
 * hace ruido: simplemente aparece el dato de alguien en la pantalla de una
 * empresa.
 *
 * Acá se hace al revés: se ARMA un objeto nuevo copiando SOLO lo que decidimos
 * mostrar. Todo lo que no esté nombrado explícitamente abajo no existe para el
 * panel, hoy y dentro de un año. Falla CERRADA.
 * ════════════════════════════════════════════════════════════════════════════
 */

/* Patrones de contacto que se pueden colar en texto LIBRE. El resumen y las
   viñetas los escribe una IA a partir del CV, y los CVs traen cosas como
   "contactame a juan@mail.com" o "ver portfolio en github.com/juan". Ese texto
   pasa por acá antes de salir. */
const PATRONES = [
  // Email. Antes que la URL, porque un mail no es un dominio.
  [/\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b/gi, '[contacto oculto]'],
  // URLs con o sin protocolo (linkedin.com/in/…, github.com/…, midominio.dev)
  [/\b(?:https?:\/\/|www\.)[^\s<>()]+/gi, '[enlace oculto]'],
  [/\b[\w-]+\.(?:com|net|org|io|dev|ar|es|me|co)(?:\.[a-z]{2})?\/[^\s<>()]*/gi, '[enlace oculto]'],
  // Usuarios de redes: @juanperez
  [/(^|\s)@[\w.-]{3,}/g, '$1[usuario oculto]'],
  /* Teléfonos. Deliberadamente amplio: 7 dígitos o más con separadores
     opcionales. Prefiero tapar de más un número de serie que dejar pasar un
     celular — el falso positivo cuesta una palabra, el falso negativo cuesta la
     privacidad de una persona. Los años (4 dígitos) y los porcentajes NO
     entran, que es lo que de verdad importa no romper en un CV. */
  [/(?:\+?\d[\d\s().-]{6,}\d)/g, '[teléfono oculto]'],
];

/** Limpia contactos de un texto libre. Nunca devuelve null. */
export const scrubText = (txt) => {
  let s = String(txt ?? '');
  for (const [re, rep] of PATRONES) s = s.replace(re, rep);
  return s.replace(/\s{2,}/g, ' ').trim();
};

/** ¿Este texto TODAVÍA parece tener un contacto adentro? (para avisarle al usuario) */
export const looksLikeContact = (txt) => {
  const s = String(txt ?? '');
  return PATRONES.some(([re]) => { re.lastIndex = 0; return re.test(s); });
};

/* Un CV puede llegar con un campo del tipo equivocado (el modelo devuelve
   JSON y no siempre respeta la forma). Sin esta guarda, un `skills` que llega
   como texto en vez de lista tenía .slice pero no .map, y el panel ENTERO se
   caía con un 500 por UN perfil mal formado. Lo encontró un test adversario. */
const lista = (x) => (Array.isArray(x) ? x : []);

/* Los años de experiencia salen de las fechas, no de un dato identificatorio.
   Es lo que una empresa necesita para filtrar sin saber de quién se trata. */
const aniosDeExperiencia = (experiencia) => {
  const anios = [];
  for (const e of lista(experiencia)) {
    const m = String(e?.dates ?? e?.period ?? '').match(/\d{4}/g);
    if (m) anios.push(...m.map(Number));
  }
  if (!anios.length) return null;
  const desde = Math.min(...anios);
  const hasta = Math.max(...anios, new Date().getFullYear());
  const n = hasta - desde;
  return n > 0 && n < 60 ? n : null;
};

/**
 * El perfil ANÓNIMO. Esto es lo único que una empresa ve antes de que la
 * persona acepte destaparse.
 *
 * @param {object} row  fila de users + su CV ya descifrado
 * @returns {object} objeto NUEVO, construido campo por campo
 */
export const perfilAnonimo = (row, cv) => {
  const c = cv ?? {};
  return {
    /* El id del PERFIL es el del usuario, y es lo que la empresa usa para pedir
       el contacto. No revela nada por sí solo (es un uuid aleatorio). */
    profileId: row.id,

    /* NO va: name, contact (email/phone/linkedin/github/website/location),
       ni ningún campo que aparezca en el futuro. Ver la nota de arriba. */

    headline: scrubText(c.experience?.[0]?.role ?? ''),          // "Backend Senior", sin la empresa
    summary: scrubText(c.summary ?? ''),
    yearsExperience: aniosDeExperiencia(c.experience),
    skills: lista(c.skills).slice(0, 20).map((s) => scrubText(s)).filter(Boolean),
    languages: lista(c.languages).slice(0, 8).map((s) => scrubText(s)).filter(Boolean),

    /* Experiencia SIN el nombre de la empresa: "Backend en Mercado Libre
       2021-2024" identifica a una persona con dos búsquedas en LinkedIn. Queda
       el rubro del puesto y lo que hizo, que es lo que se evalúa. */
    experience: lista(c.experience).slice(0, 6).map((e) => ({
      role: scrubText(e?.role ?? ''),
      years: String(e?.dates ?? e?.period ?? '').match(/\d{4}/g)?.join('–') ?? null,
      bullets: lista(e?.bullets).slice(0, 4).map((b) => scrubText(b)).filter(Boolean),
    })).filter((e) => e.role || e.bullets.length),

    /* Educación SIN la institución, por el mismo motivo. */
    education: lista(c.education).slice(0, 4).map((e) => ({
      degree: scrubText(e?.degree ?? e?.title ?? ''),
      years: String(e?.dates ?? e?.period ?? '').match(/\d{4}/g)?.join('–') ?? null,
    })).filter((e) => e.degree),

    visibleSince: row.visible_since ?? null,
  };
};

/**
 * Los datos de contacto. Se devuelven SOLO cuando la persona aceptó el interés
 * de ESA empresa. La decisión de si corresponde o no NO se toma acá: se toma en
 * la base (status='accepted') y se pasa el resultado.
 */
export const contactoRevelado = (row, cv) => ({
  profileId: row.id,
  name: row.name ?? cv?.name ?? '',
  email: row.email ?? cv?.contact?.email ?? '',
  phone: cv?.contact?.phone ?? '',
  links: [cv?.contact?.linkedin, cv?.contact?.github, cv?.contact?.website].filter(Boolean),
});
