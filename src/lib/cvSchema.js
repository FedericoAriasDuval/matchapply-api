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
  summary_suggestion: '',
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
    summary_suggestion: s(input.summary_suggestion, 1200),
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
              // nota/promedio/distinción a destacar ("8,57", "9/10", "A", "con distinción")
              grade: s(e.grade, 80),
              // materias destacadas, mención, etc. (no logros de experiencia)
              details: arr(e.details, (d) => s(d, 200), 6),
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

/**
 * Nombre de institución que se cuela como "skill" o "idioma".
 *
 * Caso real que lo motivó: un CV decía "Promoción y venta en Hospitales Muñiz,
 * Francés e Italiano" y "Francés"/"Italiano" terminaban listados como idiomas de
 * la persona. Un hospital, un colegio o una universidad es el LUGAR donde trabajó
 * o estudió — va al contexto de experiencia/educación, nunca a lo que sabe hacer.
 *
 * Solo se aplica a skills/idiomas: la sección de educación SÍ debe contener
 * "Universidad", "Instituto" y compañía, y no la toca.
 */
const ENTIDAD_RX =
  /\b(hospital(es)?|cl[ií]nicas?|sanatorios?|policl[ií]nicas?|centro m[eé]dico|colegios?|escuelas?|institutos?|universidad(es)?|university|facultad(es)?|fundaci[oó]n)\b/i;
export const isEntityName = (value) => ENTIDAD_RX.test(String(value ?? ''));

/**
 * ¿Este término ES un idioma de la persona?
 *
 * POR QUÉ EXISTE (23/07/2026): "IDIOMAS · Inglés - C2" desaparecía del CV
 * generado. La causa no era un filtro: sanitizeCv metía los idiomas adentro de
 * skills y devolvía `languages: []` a la fuerza, y ni el PDF ni el DOCX tenían
 * sección de idiomas. O sea que el CV salía sin una sección que la persona SÍ
 * había escrito — y para un puesto que pide inglés, eso es el dato que decide.
 * Peor: como los idiomas iban al final de la lista de skills y esa lista se
 * recorta a 30, un CV con muchas habilidades técnicas los perdía enteros.
 *
 * Se compara sobre la BASE del término: se le sacan el nivel entre paréntesis,
 * el guion con el nivel y las palabras de escala. Así "Inglés - C2" y
 * "English (Native)" son idiomas, pero "Traducción inglés-español" sigue siendo
 * una habilidad — porque su base tiene palabras que no son el nombre del idioma.
 */
const IDIOMAS_RX = new RegExp(
  '^(' +
    'espanol|espanhol|espagnol|spanish|castellano|' +
    'ingles|english|anglais|' +
    'frances|french|francais|' +
    'aleman|german|allemand|alemao|deutsch|' +
    'italiano|italian|italien|' +
    'portugues|portuguese|portugais|' +
    'chino|mandarin|chinese|' +
    'japones|japanese|japonais|' +
    'coreano|korean|' +
    'ruso|russian|russe|' +
    'arabe|arabic|' +
    'hebreo|hebrew|' +
    'hindi|urdu|bengali|' +
    'catalan|gallego|euskera|vasco|' +
    'holandes|neerlandes|dutch|' +
    'sueco|swedish|noruego|norwegian|danes|danish|finlandes|finnish|' +
    'polaco|polish|griego|greek|turco|turkish|' +
    'ucraniano|ukrainian|rumano|romanian|checo|czech|hungaro|hungarian|' +
    'vietnamita|vietnamese|tailandes|thai|indonesio|indonesian|' +
    'guarani|quechua|latin|' +
    'lengua de senas|lengua de signos|sign language|langue des signes|libras' +
  ')$',
  'i',
);
/* Palabras de nivel que acompañan al idioma y no forman parte de su nombre. */
const NIVEL_RX = new RegExp(
  '\\b([abc][12]|b[áa]sico|b[áa]sica|intermedio|intermedia|avanzado|avanzada|nativo|nativa|fluido|fluida|' +
  'basic|intermediate|advanced|native|fluent|proficient|proficiency|working|elementary|limited|bilingue|biling[üu]e|bilingual|' +
  'nociones|conversacional|conversational|profesional|professional|nivel|level|' +
  'courant|interm[ée]diaire|avanc[ée]|natif|maternelle|langue|' +
  'b[áa]sico|avan[çc]ado|nativo|fluente|materna|' +
  'formaci[óo]n\\s+acad[ée]mica|academic\\s+background)\\b',
  'gi',
);
const cleanLangBase = (str) =>
  String(str ?? '')
    .replace(/\([^)]*\)/g, ' ')          // "(C2)", "(avanzado)"
    .replace(/[-–—:,;|.]/g, ' ')          // "Inglés - C2", "Inglés: ...", "204 puntos."
    .replace(NIVEL_RX, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');    // sin tildes: "Inglés" == "Ingles"
export const isLanguageTerm = (value) => {
  const base = cleanLangBase(value);
  if (base && IDIOMAS_RX.test(base)) return true;
  /* FORMA VERBOSA (bug del 25/07, CV de Nicolás): "Inglés: Certificate of Proficiency
     in English (CPE) – Cambridge. Nivel C2, Grade C, 204 puntos". Después de sacar
     nivel/paréntesis quedan tokens sobrantes (Cambridge, Grade, puntos) y el match
     ANCLADO (^idioma$) fallaba → el idioma se descartaba entero, aunque tuviera nivel.
     Red de seguridad: si el PRIMER segmento (antes del primer separador fuerte) es un
     idioma, ES un idioma. "English translation" no tiene separador → su primer segmento
     es todo el término y no matchea; "Traducción inglés-español" arranca con
     "Traducción" → tampoco. Así rescatamos el idioma sin tragarnos skills. */
  const first = cleanLangBase(String(value ?? '').split(/[:\-–—,.(]/)[0]);
  return !!first && IDIOMAS_RX.test(first);
};

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
  /* normalizeLevel ANTES de todo: "Python (lo vi en un curso)" (6 palabras) se
     reformula a "Python (formación académica)" (3) y recién ahí pasa el filtro de
     término corto. Al revés, se descartaría por largo y perderíamos la skill. */
  const base = [...cv.skills, ...cv.languages]
    .map(normalizeLevel)
    .filter((x) => x && !isEntityName(x));   // "Hospital Francés" es un lugar, no un idioma

  /* IDIOMAS Y HABILIDADES VIVEN SEPARADOS, con filtros DISTINTOS:
     - un IDIOMA vale aunque sea largo ("English (C2 Proficient – EF SET, 2026)"):
       parseCv ya lo capó a 60 chars. Antes se le aplicaba isSkillTerm a todo por
       igual y ese idioma —7 palabras— se descartaba por "frase", y perdíamos el
       idioma entero (CV de Federico, 25/07). Se detecta ANTES del filtro de skill.
     - una SKILL sí tiene que ser un término corto (isSkillTerm).
     El idioma sale de donde el modelo lo haya puesto (a veces dentro de skills) y
     se va a SU sección; cada lista tiene su propio tope. */
  const languages = dropSubsumed(dedupe(base.filter(isLanguageTerm))).slice(0, 12);
  const skills = dropSubsumed(dedupe(base.filter((x) => !isLanguageTerm(x) && isSkillTerm(x)))).slice(0, 30);

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
    /* Reescritura sugerida del resumen (misma disciplina: solo hechos del CV).
       Si es igual al resumen actual, el frontend no ofrece nada. */
    summary_suggestion: cv.summary_suggestion === cv.summary ? '' : cv.summary_suggestion,
    experience,
    education,
    skills,
    languages,
    interests,
    warnings: cv.warnings,
  };
};

/**
 * RED DE SEGURIDAD DETERMINÍSTICA: rescatar el PROMEDIO que el modelo tira.
 *
 * POR QUÉ (26/07/2026 — "Mavante sigue borrando los promedios de la gente"): el
 * prompt y el schema YA piden preservar education.grade, y aun así el modelo
 * devolvía la educación SIN la nota ("Promedio actual: 8,57", "Promedio de egreso:
 * 9,63", "Calificación: 9/10" desaparecían). Reforzar el prompt ya falló: un modelo
 * NO es determinístico y este dato es demasiado importante para dejarlo a su humor.
 *
 * Entonces no le creemos. Releemos el TEXTO ORIGINAL y, para cada estudio al que el
 * modelo le dejó el grade vacío, buscamos la nota que le corresponde y la
 * reinyectamos. El anclaje es la INSTITUCIÓN (nombre propio que el modelo SÍ
 * conserva, hasta cuando traduce): la nota se busca solo en la ventana de texto
 * entre una institución y la siguiente, y solo se acepta si está pegada a una
 * PALABRA CLAVE de nota (promedio, calificación, GPA, average, media, moyenne…),
 * nunca un número suelto — así no confundimos un año, un puntaje ni una cantidad.
 *
 * Funciona aunque el CV salga traducido: el texto fuente sigue en su idioma
 * original y una nota ("8,57", "9/10") es idéntica en cualquier idioma de salida.
 * Solo RELLENA lo vacío: si el modelo ya trajo la nota, no la toca.
 */
const flattenForSearch = (str) =>
  String(str ?? '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');   // sin tildes: "Andrés" == "andres"

/* Palabra clave de nota (el texto de trabajo va sin acentos, así que van sin tildes:
   "calificacion", "media"). "grade" suelto NO alcanza como valor: exige un número. */
const GRADE_KW =
  '(?:promedios?(?:\\s+(?:actual|de\\s+egreso|general|final|ponderado))?' +
  '|nota(?:\\s+final)?|calificacion|g\\.?p\\.?a\\.?|grade\\s+point\\s+average' +
  '|average(?:\\s+grade)?|media(?:\\s+ponderata)?|moyenne|voto|overall)';
/* Valor de nota: fracción ("9/10", "3.8/4.0") o decimal ("8,57"). Enteros sueltos
   NO — un "3" o un "2024" pegado a una palabra ambigua sería un falso positivo. */
const GRADE_VAL =
  '(\\d{1,3}(?:[.,]\\d{1,2})?\\s*\\/\\s*\\d{1,3}(?:[.,]\\d{1,2})?|\\d{1,2}[.,]\\d{1,2})';
/* Separador corto entre la palabra y el número: espacio, ":", "=", guion. SIN punto,
   para que "media." (fin de oración) no salte a un número de la frase siguiente. */
const GRADE_RX = new RegExp(`${GRADE_KW}[\\s:=\\-–—]{0,4}${GRADE_VAL}`, 'i');

export const rescueEducationGrades = (cv, sourceText) => {
  if (!cv || !Array.isArray(cv.education) || !cv.education.length) return cv;
  const flat = flattenForSearch(sourceText);
  if (!flat) return cv;

  // Ubicar cada estudio por su institución (nombre propio); si no hay, por el título.
  const located = cv.education
    .map((e, idx) => {
      const anchor = flattenForSearch(e.institution || e.degree);
      const pos = anchor.length >= 4 ? flat.indexOf(anchor) : -1;
      return { e, idx, pos };
    })
    .filter((x) => x.pos >= 0)
    .sort((a, b) => a.pos - b.pos);

  for (let i = 0; i < located.length; i += 1) {
    const cur = located[i];
    if (cur.e.grade && String(cur.e.grade).trim()) continue;   // el modelo ya la trajo: no se pisa
    const end = i + 1 < located.length ? located[i + 1].pos : flat.length;
    const m = GRADE_RX.exec(flat.slice(cur.pos, end));          // primera nota en LA ventana de ese estudio
    if (m && m[1]) cur.e.grade = m[1].replace(/\s+/g, '');      // "9 / 10" -> "9/10"
  }
  return cv;
};

/**
 * RED DETERMINÍSTICA #2: término del SECUNDARIO y unidad del PUNTAJE.
 *
 * POR QUÉ (26/07/2026, mismo CV): el prompt YA fija el término estándar por idioma
 * y YA pide traducir la unidad del puntaje, y el modelo igual devolvía "Secondary
 * School Diploma" (calco, en vez de "High School Diploma") y "204 puntos" en un CV
 * en inglés. Misma lección que con el promedio: al modelo no se le ruega, se lo
 * corrige. Esto ENFORZA una decisión de producto que ya está escrita en el prompt.
 *
 * 1) SECUNDARIO: reemplaza SOLO los calcos conocidos por el término local (en:
 *    "High School", fr: "baccalauréat/lycée", pt: "ensino médio", it: "scuola
 *    superiore"), preservando lo que rodea (una orientación no se pierde). El
 *    español ya usa el término correcto, no se toca. Nombres propios de colegios
 *    (en su idioma original) no matchean estos patrones en inglés/francés/etc.
 * 2) PUNTAJE: normaliza la unidad ("204 puntos") al idioma de salida, en cualquier
 *    dirección, y SOLO cuando va pegada a un número (no toca "puntos fuertes").
 */
/* Ordenado: la frase específica ("diploma de …") antes que la palabra suelta, para
   que no quede a medias. El calco inglés ("secondary school") se ataja en los 4. */
const SECONDARY_FIXES = {
  es: [],   // "Secundario" / "Bachillerato" ya es el término correcto en español
  en: [
    // "post-secondary" es TERCIARIO (universidad): no lo pisamos.
    [/(?<!post[- ])\bsecondary school\b/gi, 'High School'],
    [/(?<!post[- ])\bsecondary education\b/gi, 'High School'],
  ],
  fr: [
    [/\bdipl[oô]me d['’]\s?[ée]tudes secondaires\b/gi, 'Diplôme du baccalauréat'],
    [/\bdipl[oô]me d['’]\s?[ée]cole secondaire\b/gi, 'Diplôme du baccalauréat'],
    [/\b[ée]cole secondaire\b/gi, 'Lycée'],
    [/\b[ée]tudes secondaires\b/gi, 'Baccalauréat'],
    [/\benseignement secondaire\b/gi, 'Baccalauréat'],
    [/\bsecondary school\b/gi, 'Baccalauréat'],
  ],
  pt: [
    [/\bdiploma de escola secund[aá]ria\b/gi, 'Diploma do ensino médio'],
    [/\bescola secund[aá]ria\b/gi, 'Ensino médio'],
    [/\bsecondary school\b/gi, 'Ensino médio'],
  ],
  it: [
    [/\bdiploma di scuola secondaria(?: di secondo grado)?\b/gi, 'Diploma di scuola superiore'],
    [/\bscuola secondaria(?: di secondo grado)?\b/gi, 'Scuola superiore'],
    [/\bsecondary school\b/gi, 'Scuola superiore'],
  ],
};

// Unidad del puntaje de una certificación, por idioma de salida.
const SCORE_UNIT = { es: 'puntos', en: 'points', fr: 'points', pt: 'pontos', it: 'punti' };
const SCORE_UNIT_RX = /(\d+)\s*(puntos|points|pontos|punti)\b/gi;

export const normalizeLocaleTerms = (cv, lang) => {
  if (!cv) return cv;
  const L = ['es', 'en', 'fr', 'pt', 'it'].includes(lang) ? lang : 'es';

  const fixes = SECONDARY_FIXES[L] || [];
  const fixTerm = (str) => {
    let out = String(str ?? '');
    for (const [re, rep] of fixes) out = out.replace(re, rep);
    return out;
  };
  const unit = SCORE_UNIT[L] || 'points';
  const fixScore = (str) => String(str ?? '').replace(SCORE_UNIT_RX, (_m, n) => `${n} ${unit}`);

  if (typeof cv.summary === 'string') cv.summary = fixScore(cv.summary);
  if (Array.isArray(cv.languages)) cv.languages = cv.languages.map(fixScore);
  if (Array.isArray(cv.education)) {
    for (const e of cv.education) {
      if (!e) continue;
      if (e.degree) e.degree = fixTerm(e.degree);
      if (e.institution) e.institution = fixTerm(e.institution);
      if (e.grade) e.grade = fixScore(e.grade);
      if (Array.isArray(e.details)) e.details = e.details.map(fixScore);
    }
  }
  return cv;
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
