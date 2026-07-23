import {
  AlignmentType, BorderStyle, Document, HeadingLevel, Packer, Paragraph, Tab, TabStopPosition,
  TabStopType, TextRun,
} from 'docx';
import { contactLine, dateRange } from './cvSchema.js';

const SECTIONS = {
  es: { sum: 'Resumen profesional', exp: 'Experiencia', edu: 'Educación', skl: 'Habilidades', lng: 'Idiomas', int: 'Intereses' },
  en: { sum: 'Professional summary', exp: 'Experience', edu: 'Education', skl: 'Skills', lng: 'Languages', int: 'Interests' },
  fr: { sum: 'Profil professionnel', exp: 'Expérience', edu: 'Formation', skl: 'Compétences', lng: 'Langues', int: "Centres d'intérêt" },
  pt: { sum: 'Resumo profissional', exp: 'Experiência', edu: 'Educação', skl: 'Competências', lng: 'Idiomas', int: 'Interesses' },
};

const FONT = 'Times New Roman';

const sectionHeading = (text) =>
  new Paragraph({
    spacing: { before: 240, after: 80 },
    border: { top: { style: BorderStyle.SINGLE, size: 6, color: '333333', space: 4 } },
    children: [new TextRun({ text: text.toUpperCase(), bold: true, size: 21, font: FONT, characterSpacing: 24 })],
  });

/** Línea con contenido a la izquierda y fecha/ubicación pegada al margen derecho (tab stop). */
const rowRight = (left, right, { italic = false, bold = false } = {}) =>
  new Paragraph({
    tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
    spacing: { after: 20 },
    children: [
      new TextRun({ text: left || '', bold, italics: italic, size: 23, font: FONT }),
      new TextRun({ children: [new Tab()], size: 23, font: FONT }),
      new TextRun({ text: right || '', italics: true, size: 21, font: FONT }),
    ],
  });

/** @returns {Promise<Buffer>} */
export const renderCvDocx = async (cv, lang = 'es') => {
  const S = SECTIONS[lang] ?? SECTIONS.es;
  const children = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      heading: HeadingLevel.TITLE,
      spacing: { after: 80 },
      children: [new TextRun({ text: cv.name || '', bold: true, size: 38, font: FONT, characterSpacing: 20 })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 60 },
      children: [new TextRun({ text: contactLine(cv), size: 19, font: FONT, color: '333333' })],
    }),
  ];

  if (cv.summary) {
    children.push(sectionHeading(S.sum));
    children.push(
      new Paragraph({
        alignment: AlignmentType.JUSTIFIED,
        children: [new TextRun({ text: cv.summary, size: 23, font: FONT })],
      }),
    );
  }

  if (cv.experience?.length) {
    children.push(sectionHeading(S.exp));
    cv.experience.forEach((e) => {
      children.push(rowRight(e.role, dateRange(e.start, e.end), { bold: true }));
      if (e.company || e.location) children.push(rowRight(e.company, e.location, { italic: true }));
      (e.bullets ?? []).filter(Boolean).forEach((b) => {
        children.push(
          new Paragraph({
            bullet: { level: 0 },
            alignment: AlignmentType.JUSTIFIED,
            spacing: { after: 20 },
            children: [new TextRun({ text: b, size: 23, font: FONT })],
          }),
        );
      });
    });
  }

  if (cv.education?.length) {
    children.push(sectionHeading(S.edu));
    cv.education.forEach((e) => {
      children.push(rowRight(e.institution, e.location, { bold: true }));
      if (e.degree || e.start || e.end) children.push(rowRight(e.degree, dateRange(e.start, e.end), { italic: true }));
    });
  }

  if (cv.skills?.length) {
    children.push(sectionHeading(S.skl));
    children.push(new Paragraph({ children: [new TextRun({ text: cv.skills.join('  ·  '), size: 23, font: FONT })] }));
  }

  /* IDIOMAS aparte de Habilidades: ver el comentario en pdf.js. */
  if (cv.languages?.length) {
    children.push(sectionHeading(S.lng));
    children.push(new Paragraph({ children: [new TextRun({ text: cv.languages.join('  ·  '), size: 23, font: FONT })] }));
  }

  if (cv.interests?.length) {
    children.push(sectionHeading(S.int));
    children.push(new Paragraph({ children: [new TextRun({ text: cv.interests.join(', '), size: 23, font: FONT })] }));
  }

  const doc = new Document({
    styles: { default: { document: { run: { font: FONT, size: 23 } } } },
    sections: [{ properties: { page: { margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } }, children }],
  });
  return Packer.toBuffer(doc);
};
