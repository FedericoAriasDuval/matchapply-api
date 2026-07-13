import PDFDocument from 'pdfkit';
import { contactLine, dateRange } from './cvSchema.js';

const M = 56;                 // márgenes A4 en puntos
const W = 595.28;
const RIGHT = W - M;
const WIDTH = RIGHT - M;

const SECTIONS = {
  es: { sum: 'Resumen profesional', exp: 'Experiencia', edu: 'Educación', skl: 'Habilidades', int: 'Intereses' },
  en: { sum: 'Professional summary', exp: 'Experience', edu: 'Education', skl: 'Skills', int: 'Interests' },
  fr: { sum: 'Profil professionnel', exp: 'Expérience', edu: 'Formation', skl: 'Compétences', int: "Centres d'intérêt" },
  pt: { sum: 'Resumo profissional', exp: 'Experiência', edu: 'Educação', skl: 'Competências', int: 'Interesses' },
};

/**
 * Plantilla ejecutiva (Harvard style), serif, A4:
 *   nombre centrado en grande · contacto en una línea separado por " | "
 *   secciones en versalitas precedidas por una línea divisoria fina
 *   institución/puesto a la izquierda, fechas/ubicación al margen derecho
 * @returns {Promise<Buffer>}
 */
export const renderCvPdf = (cv, lang = 'es') =>
  new Promise((resolve, reject) => {
    const S = SECTIONS[lang] ?? SECTIONS.es;
    const doc = new PDFDocument({ size: 'A4', margins: { top: M, bottom: M, left: M, right: M } });
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
      doc.font('Times-Bold').fontSize(10.5)
        .text(label.toUpperCase(), M, doc.y, { characterSpacing: 1.2, width: WIDTH });
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

    if (cv.interests?.length) {
      heading(S.int);
      paragraph(cv.interests.join(', '));
    }

    doc.end();
  });
