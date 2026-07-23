/**
 * src/lib/cvSchema.js
 *
 * Contrato del CV — última línea de defensa.
 * El servidor NO confía en la salida del modelo ni en lo que edita el cliente:
 * todo pasa por parseCv() (forma) y sanitizeCv() (mapeo estricto por sección).
 *
 * Principios:
 *   1. Cero invención: si un dato no vino, queda vacío. Nunca se rellena.
 *   2. Cero contaminación cruzada: cada dato solo vive en su sección nativa.
 *   3. Lo que no encaja se DESCARTA (jamás se "reubica" adivinando).
 *
 * Módulo puro (sin dependencias): se puede testear y auditar en aislamiento.
 */

export class CvValidationError extends Error {
  constructor(message, issues = []) {
    super(message);
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------------
// Coerción de tipos (equivalente a un esquema, sin librerías)
// ---------------------------------------------------------------------------
const s = (v, max = 400) => {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  return String(v).replace(/\s+/g, ' ').trim().slice(0, max);
};
const arr = (v, mapper, max) => (Array.isArray(v) ? v.map(mapper).filter(Boolean).slice(0, max) : []);
const bool = (v) => v === true;

export const EMPTY_CV = () => ({
  name: '',
  contact: { email: '', phone: '', linkedin: '', github: '', website: '', location: '' },
  summary: '',
  summary_is_generated: false,
  experience: [],
  education: [],
  skills: [],
  languages: [],
  interests: [],
  warnings: [],
});

/** Normaliza la forma del objeto. No juzga el contenido (de eso se ocupa sanitizeCv). */
export const parseCv = (input) => {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new CvValidationError('El CV debe ser un objeto.');
  }
  const c = input.contact ?? {};
  return {
    name: s(input.name, 120),
    contact: {
      email: s(c.email, 160),
      phone: s(c.phone, 60),
      linkedin: s(c.linkedin, 200),
      github: s(c.github, 200),
      website: s(c.website, 200),
      location: s(c.location, 120),
    },
    summary: s(input.summary, 1200),
    summary_is_generated: bool(input.summary_is_generated),
    experience: arr(
      input.experience,
      (e) =>
        e && typeof e === 'object'
          ? {
              role: s(e.role, 140),
              company: s(e.company, 140),
              location: s(e.location, 120),
              start: s(e.start, 40),
              end: s(e.end, 40),
              bullets: arr(e.bullets, (b) => s(b, 400), 12),
            }
          : null,
      20,
    ),
    education: arr(
      input.education,
      (e) =>
        e && typeof e === 'object'
          ? {
              institution: s(e.institution, 160),
              degree: s(e.degree, 160),
              location: s(e.location, 120),
              start: s(e.start, 40),
              end: s(e.end, 40),
            }
          : null,
      12,
    ),
    skills: arr(input.skills, (x) => s(x, 60), 40),
    languages: arr(input.languages, (x) => s(x, 60), 12),
    interests: arr(input.interests, (x) => s(x, 80), 12),
    warnings: arr(input.warnings, (x) => s(x, 240), 10),
  };
};

// ---------------------------------------------------------------------------
// Reglas del mapeo estricto
// ---------------------------------------------------------------------------
const CONTACT_RX = /[\w.+-]+@[\w-]+\.[\w.-]+|linkedin\.com|github\.com|^\+?[\d ().-]{8,}$/i;
const INST_RX =
  /(universidad|universidade|university|universit[ée]|instituto|institute|facultad|school|escuela|colegio|academia|academy)/i;
const DEGREE_RX =
  /(licenciatur|licenciad|ingenier|engineering|bachelor|master|m[aá]ster|mba|maestr|doctorad|phd|t[eé]cnic|tecn[oó]log|diplomatur|certificad|certificat|certification|curso|course|posgrado|grado|degree|secundari|bachiller)/i;
const NOISE_RX =
  /^(intereses|interests|hobbies|idiomas|languages|habilidades|skills|conocimientos|referencias|references|contacto|contact|nota|note)\s*[:\-–]/i;
/**
 * Verbo de acción: 1ª persona del pretérito en español (termina en é/í antes de un
 * separador — "Coordiné", "Construí"; NO "Fotografía") o raíces verbales frecuentes.
 */
const VERB_RX =
  /[éí](?=$|[\s.,;:!?])|\b(desarroll|implement|dise[nñ]|coordin|lider|gestion|administr|optimiz|mejor|reduj|aument|automatiz|analiz|colabor|particip|present|capacit|supervis|logr|constru|dirig|trabaj|organiz|ense[nñ]|vend|cre[oóé]|led|lead|develop|design|improv|reduc|increas|automat|built|created|managed|owned|drove|delivered|launched|worked)/i;
const YEAR_RX = /\b(19|20)\d{2}\b/;

/** "React, Node, SQL" es una lista de skills, no un logro. */
export const isSkillList = (line) => {
  const parts = String(line).split(/[,;·|/]/).map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) return false;
  const shortOnes = parts.filter((p) => p.split(/\s+/).length <= 3).length;
  return shortOnes / parts.length >= 0.8;
};

/** Un bullet solo entra a Experiencia si es un logro profesional de verdad. */
export const isAchievement = (line) => {
  const x = String(line ?? '').trim();
  if (x.length < 12) return false;
  if (CONTACT_RX.test(x)) return false;          // datos personales -> no van acá
  if (NOISE_RX.test(x)) return false;            // intereses / skills / notas -> no van acá
  if (isSkillList(x)) return false;              // enumeración de tecnologías -> no va acá
  if (INST_RX.test(x) && DEGREE_RX.test(x)) return false; // educación -> no va acá
  const words = x.split(/\s+/).length;
  return words >= 4 && (VERB_RX.test(x) || words >= 7);
};

/**
 * Reformula aclaraciones informales de nivel a lenguaje profesional. Red de
 * seguridad determinística (español) SOBRE lo que el prompt ya normaliza: si el
 * modelo deja un coloquialismo, esto lo limpia igual. Reglas:
 *   - Solo toca lo que está ENTRE PARÉNTESIS (que es donde vive la aclaración);
 *     "Cálculo básico" sin paréntesis NO se toca (es el nombre de la materia).
 *   - NUNCA infla el nivel ni inventa un código CEFR: cambia palabras, no niveles.
 * El orden importa: lo más específico (curso/facultad, oxidado) va antes que lo
 * genérico ("básico"), para que no lo pise una regla más amplia.
 */
/* SOLO coloquialismos → término profesional. Los niveles que YA son estándar
   (básico, intermedio, avanzado, nativo, nociones) NO se tocan: son la escala
   correcta, no un problema. Y ningún reemplazo es fuente de otra regla, así que
   no hay cascada ("nivel básico" no se vuelve a reescribir). */
const NIVEL_INFORMAL = [
  // curso/facultad -> "formación académica" (es un contexto, no un nivel)
  [/\b(?:lo vi en (?:un|una) (?:curso|materia)|visto en (?:la )?facultad|de (?:la )?facultad|en la facu(?:ltad)?|en un curso|de la carrera|vi en la facu)\b/gi, 'formación académica'],
  // "oxidado" implica que hubo nivel -> intermedio
  [/\b(?:medio |algo )?oxidad[oa]s?\b/gi, 'intermedio'],
  // intensificador + nivel estándar -> el nivel SOLO ("muy avanzado" -> "avanzado")
  [/\b(?:muy|bastante|s[úu]per|re)\s+(b[áa]sico|intermedio|avanzado|fluido|nativ[oa])\b/gi, '$1'],
  // coloquialismos de nivel bajo -> "básico" (la escala estándar, sin "nivel")
  [/\b(?:muy poc[oa]s?|un poc[oa]|poqu[ií]t[oa]|apenas|casi nada|nivel usuario|principiante)\b/gi, 'básico'],
  // "nivel X" redundante -> solo la palabra de la escala ("nivel básico" -> "básico")
  [/\bnivel\s+(b[áa]sico|intermedio|avanzado)\b/gi, '$1'],
];
export const normalizeLevel = (raw) =>
  String(raw ?? '').replace(/\(([^)]*)\)/g, (_m, inner) => {
    let s = inner;
    for (const [re, rep] of NIVEL_INFORMAL) s = s.replace(re, rep);
    // "nivel nivel X" (dos reglas encadenadas) y espacios sobrantes
    s = s.replace(/\bnivel\s+nivel\b/gi, 'nivel').replace(/\s+/g, ' ').trim();
    return `(${s})`;
  });

/** Una skill es un término (1–4 palabras), no una oración. */
export const isSkillTerm = (value) => {
  const x = String(value ?? '').trim();
  if (!x || x.length < 2 || x.length > 40) return false;
  if (CONTACT_RX.test(x)) return false;
  if (/^\d+$/.test(x)) return false;
  return x.split(/\s+/).length <= 4;
};

const norm = (x) =>
  String(x).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

const dedupe = (list) => {
  const seen = new Set();
  return list.filter((x) => {
    const k = norm(x);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

/** Descarta la skill genérica cuando existe una más específica ("Inglés" vs "Inglés avanzado"). */
const dropSubsumed = (list) =>
  list.filter((k, i) => {
    const kk = norm(k);
    return !list.some((other, j) => {
      if (i === j) return false;
      const oo = norm(other);
      return oo.length > kk.length && (oo.startsWith(`${kk} `) || oo.includes(` ${kk}`));
    });
  });

/**
 * Hace cumplir el contrato aunque el modelo (o el usuario Pro editando) se desvíe.
 * @param {object} input
 * @returns {object} CV saneado
 */
export const sanitizeCv = (input) => {
  const cv = parseCv(input ?? {});

  // --- DATOS PERSONALES: solo canales de contacto reales ---
  const contact = { ...cv.contact };
  if (contact.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(contact.email)) contact.email = '';
  if (contact.phone && contact.phone.replace(/\D/g, '').length < 6) contact.phone = '';
  if (contact.linkedin && !/linkedin\.com/i.test(contact.linkedin)) contact.linkedin = '';
  if (contact.github && !/github\.com/i.test(contact.github)) contact.github = '';
  if (contact.website && !/^(https?:\/\/|www\.)|\.[a-z]{2,}(\/|$)/i.test(contact.website)) contact.website = '';
  if (contact.website && (INST_RX.test(contact.website) || DEGREE_RX.test(contact.website))) contact.website = '';

  // --- EXPERIENCIA: solo logros profesionales ---
  const experience = cv.experience
    .map((e) => ({
      ...e,
      bullets: dedupe(e.bullets.filter(isAchievement)).slice(0, 8),
    }))
    .filter((e) => e.role || e.company || e.bullets.length);

  // --- EDUCACIÓN: institución, título, ubicación y período. Nada más. ---
  const education = cv.education
    .map((e) => {
      // Un párrafo con verbos no es un título: se descarta el texto, no la entrada.
      const degree = VERB_RX.test(e.degree) && e.degree.split(/\s+/).length > 9 ? '' : e.degree;
      const institution = e.institution || degree;
      return { ...e, institution, degree: institution === degree ? '' : degree };
    })
    .filter((e) => {
      const blob = `${e.institution} ${e.degree}`.trim();
      if (!blob) return false;
      if (CONTACT_RX.test(blob)) return false;
      if (isSkillList(blob)) return false;
      // Debe oler a formación: institución conocida o título/certificación.
      return INST_RX.test(e.institution) || DEGREE_RX.test(blob);
    })
    .slice(0, 10);

  // --- HABILIDADES (+ idiomas): términos, sin duplicados ni frases ---
  /* normalizeLevel ANTES de isSkillTerm: "Python (lo vi en un curso)" (6 palabras)
     se reformula a "Python (formación académica)" (3) y recién ahí pasa el filtro
     de término corto. Al revés, se descartaría por largo y perderíamos la skill. */
  const skills = dropSubsumed(dedupe([...cv.skills, ...cv.languages].map(normalizeLevel).filter(isSkillTerm))).slice(0, 30);

  // --- INTERESES: ni fechas, ni empresas, ni logros ---
  const interests = dedupe(
    cv.interests.filter(
      (i) => !CONTACT_RX.test(i) && !YEAR_RX.test(i) && !VERB_RX.test(i) && i.split(/\s+/).length <= 6,
    ),
  ).slice(0, 8);

  return {
    name: cv.name,
    contact,
    summary: cv.summary,
    summary_is_generated: cv.summary_is_generated,
    experience,
    education,
    skills,
    languages: [],
    interests,
    warnings: cv.warnings,
  };
};

/** Línea de contacto compacta, separada por " | " (va debajo del nombre). */
export const contactLine = (cv) =>
  [
    cv.contact.email,
    cv.contact.phone,
    cv.contact.linkedin,
    cv.contact.github,
    cv.contact.website,
    cv.contact.location,
  ]
    .filter(Boolean)
    .join('  |  ');

/** Rango para el margen derecho: "2021 – 2025" / "2024 – Present". */
export const dateRange = (start, end) => {
  const e = end === 'present' ? 'Present' : end;
  if (start && e) return `${start} – ${e}`;
  return start || e || '';
};
