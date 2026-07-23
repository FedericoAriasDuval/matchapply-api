import PDFDocument from 'pdfkit';
import { contactLine, dateRange } from './cvSchema.js';

const M = 56;                 // márgenes A4 en puntos
const W = 595.28;
const RIGHT = W - M;
const WIDTH = RIGHT - M;

const SECTIONS = {
  es: { sum: 'Resumen profesional', exp: 'Experiencia', edu: 'Educación', skl: 'Habilidades', lng: 'Idiomas', int: 'Intereses' },
  en: { sum: 'Professional summary', exp: 'Experience', edu: 'Education', skl: 'Skills', lng: 'Languages', int: 'Interests' },
  fr: { sum: 'Profil professionnel', exp: 'Expérience', edu: 'Formation', skl: 'Compétences', lng: 'Langues', int: "Centres d'intérêt" },
  pt: { sum: 'Resumo profissional', exp: 'Experiência', edu: 'Educação', skl: 'Competências', lng: 'Idiomas', int: 'Interesses' },
};

/**
 * Plantilla ejecutiva (Harvard style), serif, A4:
 *   nombre centrado en grande · contacto en una línea separado por " | "
 *   secciones en versalitas precedidas por una línea divisoria fina
 *   institución/puesto a la izquierda, fechas/ubicación al margen derecho
 * @returns {Promise<Buffer>}
 */
/**
 * @param {object} cv
 * @param {string} lang
 * @param {{compress?: boolean}} [opts] compress:false deja el flujo de texto
 *   legible en crudo. Lo usa el TEST que verifica que los títulos de sección
 *   salgan enteros: sin esto habría que descomprimir el PDF para poder mirarlos,
 *   y una verificación que no se puede hacer no se hace.
 */
export const renderCvPdf = (cv, lang = 'es', opts = {}) =>
  new Promise((resolve, reject) => {
    const S = SECTIONS[lang] ?? SECTIONS.es;
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: M, bottom: M, left: M, right: M },
      compress: opts.compress !== false,
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const need = (h) => {
      if (doc.y + h > doc.page.height - M) doc.addPage();
    };

    // ---- encabezado ----
    doc.font('Times-Bold').fontSize(19).text((cv.name || '').toUpperCase(), M, M, {
      width: WIDTH,
      align: 'center',
      characterSpacing: 0.6,
    });
    doc.moveDown(0.35);
    const line = contactLine(cv);
    if (line) {
      doc.font('Times-Roman').fontSize(9.8).fillColor('#333')
        .text(line, M, doc.y, { width: WIDTH, align: 'center' });
      doc.fillColor('#000');
    }
    doc.moveDown(0.8);

    // ---- helpers de sección ----
    const rule = () => {
      need(24);
      const y = doc.y;
      doc.moveTo(M, y).lineTo(RIGHT, y).lineWidth(0.7).strokeColor('#333').stroke();
      doc.y = y + 6;
    };
    const heading = (label) => {
      rule();
      /* characterSpacing BAJO a propósito (era 1.2, 23/07/2026).
         Con 1.2 el extractor de texto leía los títulos PARTIDOS —"EDU CAC IÓN",
         "HABI LIDA DES"— porque el espaciado entre glifos entra al PDF como
         separación real. O sea que el CV que generamos tenía justo el defecto
         que este producto existe para detectar: un filtro automático busca la
         palabra "EDUCACIÓN" y no la encuentra. Nuestro propio PDF tiene que
         pasar la prueba que le exigimos al de los demás. */
      doc.font('Times-Bold').fontSize(10.5)
        .text(label.toUpperCase(), M, doc.y, { characterSpacing: 0.4, width: WIDTH });
      doc.moveDown(0.35);
      doc.font('Times-Roman').fontSize(11.5);
    };
    const paragraph = (text) => {
      if (!text) return;
      need(20);
      doc.font('Times-Roman').fontSize(11.5).text(text, M, doc.y, { width: WIDTH, align: 'justify' });
      doc.moveDown(0.3);
    };
    /** izquierda en negrita/itálica, derecha alineada al margen, misma línea */
    const row = (left, right, italicLeft = false) => {
      if (!left && !right) return;
      need(18);
      const y = doc.y;
      doc.font(italicLeft ? 'Times-Italic' : 'Times-Bold').fontSize(11.5);
      doc.text(left || '', M, y, { width: WIDTH - 150, continued: false });
      const leftEnd = doc.y;
      if (right) {
        doc.font('Times-Italic').fontSize(10.5).text(right, RIGHT - 150, y, { width: 150, align: 'right' });
      }
      doc.y = Math.max(leftEnd, y + 13);
      doc.font('Times-Roman').fontSize(11.5);
    };
    const bullets = (items) => {
      (items ?? []).filter(Boolean).forEach((b) => {
        need(16);
        const y = doc.y;
        doc.font('Times-Roman').fontSize(11.5);
        doc.text('•', M + 4, y, { width: 10 });
        doc.text(b, M + 18, y, { width: WIDTH - 18, align: 'justify' });
        doc.moveDown(0.15);
      });
      doc.moveDown(0.2);
    };

    // ---- cuerpo ----
    if (cv.summary) {
      heading(S.sum);
      paragraph(cv.summary);
    }

    if (cv.experience?.length) {
      heading(S.exp);
      cv.experience.forEach((e) => {
        row(e.role, dateRange(e.start, e.end));
        if (e.company || e.location) row(e.company, e.location, true);
        bullets(e.bullets);
      });
    }

    if (cv.education?.length) {
      heading(S.edu);
      cv.education.forEach((e) => {
        row(e.institution, e.location);
        if (e.degree || e.start || e.end) row(e.degree, dateRange(e.start, e.end), true);
        doc.moveDown(0.2);
      });
    }

    if (cv.skills?.length) {
      heading(S.skl);
      paragraph(cv.skills.join('  ·  '));
    }

    /* IDIOMAS, en su propia sección. Iban mezclados adentro de Habilidades y el
       CV salía sin la sección que la persona SÍ había escrito — y para un puesto
       que pide inglés, ese es el dato que decide. */
    if (cv.languages?.length) {
      heading(S.lng);
      paragraph(cv.languages.join('  ·  '));
    }

    if (cv.interests?.length) {
      heading(S.int);
      paragraph(cv.interests.join(', '));
    }

    doc.end();
  });
