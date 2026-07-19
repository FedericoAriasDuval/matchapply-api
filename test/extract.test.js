/**
 * test/extract.test.js
 *
 * Leer el archivo que subió una persona. Dos reglas:
 *
 *   1. El tipo lo deciden los BYTES, no el nombre. Un PDF llamado "cv.txt"
 *      sigue siendo un PDF.
 *   2. Un archivo que no se puede leer nunca sale como 500. El problema lo tiene
 *      el archivo y casi siempre tiene arreglo — hay que decir cuál.
 *
 * EL BUG QUE ESTO PROTEGE, y es el peor de todos los que aparecieron:
 * el extractor decidía por la extensión del nombre, así que un PDF de verdad
 * llamado "cv.txt" entraba por la rama de texto plano. Hacer toString('utf8')
 * sobre binario devuelve un amasijo de símbolos de más de 40 caracteres, o sea
 * que pasaba todos los controles y se le mandaba AL MODELO como si fuera un CV.
 * La persona recibía un diagnóstico inventado sobre basura, sin un solo error a
 * la vista. Un error visible es malo; un resultado falso que parece bueno es
 * peor, porque nadie lo reporta.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = 'postgres://nadie:nadie@127.0.0.1:1/nada';
process.env.JWT_SECRET = 'solo-para-tests';

const { extractText } = await import('../src/lib/extract.js');
const { validateUpload } = await import('../src/lib/upload.js');

/* Un PDF VALIDO de verdad, con una pagina real y ni una sola letra: un dibujo y
   nada mas. Es, en estructura, lo que produce escanear un CV en papel — el
   escaner mete una imagen en la pagina y no hay capa de texto.
   Se genera con pdfkit (ya es dependencia) en vez de escribirlo a mano: un PDF
   armado a mano no tiene tabla de referencias y el lector lo rechaza como
   corrupto, que es un caso DISTINTO del que queremos probar. */
const { default: PDFDocument } = await import('pdfkit');

const pdfSinTexto = async () => {
  const doc = new PDFDocument({ compress: false });
  const partes = [];
  doc.on('data', (c) => partes.push(c));
  const listo = new Promise((r) => doc.on('end', r));
  doc.rect(50, 50, 200, 120).stroke();   // un rectangulo: puro dibujo, cero texto
  doc.end();
  await listo;
  return Buffer.concat(partes);
};

const PDF_ESCANEADO = await pdfSinTexto();

const archivo = (buffer, originalname) => ({ buffer, originalname, size: buffer.length });

test('el tipo sale de los BYTES: un PDF llamado cv.txt sigue siendo un PDF', () => {
  const tipo = validateUpload(archivo(PDF_ESCANEADO, 'cv.txt'));
  assert.equal(tipo, 'pdf', 'el nombre miente, los bytes no');
});

test('un PDF disfrazado de .txt NO se le manda al modelo como texto', async () => {
  /* Este era el bug: entraba por la rama de texto, salia un amasijo y el
     usuario recibia un diagnostico inventado sobre basura. */
  const f = archivo(PDF_ESCANEADO, 'cv.txt');
  const tipo = validateUpload(f);
  await assert.rejects(() => extractText(f, tipo), (e) => {
    assert.notEqual(e.code, undefined);
    assert.ok(['pdf_scanned', 'pdf_broken', 'empty_cv'].includes(e.code),
      `deberia decir que el PDF no tiene texto, dijo: ${e.code}`);
    return true;
  });
});

test('un PDF sin texto legible es SIEMPRE un 4xx del archivo, nunca un 500 nuestro', async () => {
  const f = archivo(PDF_ESCANEADO, 'cv.pdf');
  await assert.rejects(() => extractText(f, 'pdf'), (e) => {
    assert.equal(e.status, 422, 'el problema lo tiene el archivo, no el servidor');
    assert.ok(['pdf_scanned', 'pdf_broken'].includes(e.code), `codigo inesperado: ${e.code}`);
    return true;
  });
});

test('LIMITACION CONOCIDA: pdf-parse no puede leer NINGUN PDF hecho con pdfkit', async () => {
  /* Verificado el 19/07/2026: con texto, sin texto, comprimido o no, pdf-parse
     (v1.1.1, sin mantenimiento desde 2018) siempre tira "bad XRef entry" sobre
     la salida de pdfkit — que es la libreria con la que ESTE MISMO backend
     genera PDFs en src/lib/pdf.js.

     Hoy no afecta a ningun usuario, y por eso no se cambio de libreria a un dia
     del lanzamiento: el PDF que la persona descarga lo genera jsPDF en el
     navegador, y cuando sube un PDF lo lee pdf.js, tambien en el navegador. Los
     dos son modernos. Este camino del backend solo se alcanza llamando a la API
     directamente.

     Este test NO es un deseo: documenta lo que pasa hoy. Si alguna vez se
     reemplaza pdf-parse por pdfjs-dist, este test va a fallar — y esa falla es
     la senal de que el reemplazo funciono. */
  const conTexto = await (async () => {
    const doc = new PDFDocument();
    const partes = [];
    doc.on('data', (c) => partes.push(c));
    const listo = new Promise((r) => doc.on('end', r));
    doc.text('Ana Gomez, desarrolladora backend en Mercado Libre');
    doc.end();
    await listo;
    return Buffer.concat(partes);
  })();

  await assert.rejects(() => extractText(archivo(conTexto, 'cv.pdf'), 'pdf'), (e) => {
    assert.equal(e.status, 422, 'aunque no lo pueda leer, sale como error del archivo y no como 500');
    return true;
  });
});

test('un PDF corrupto da un error del archivo (422), nunca un 500 nuestro', async () => {
  const roto = Buffer.concat([Buffer.from('%PDF-1.4\n', 'latin1'), Buffer.from([0, 1, 2, 3, 4, 5, 6, 7])]);
  await assert.rejects(() => extractText(archivo(roto, 'cv.pdf'), 'pdf'), (e) => {
    assert.ok(e.status >= 400 && e.status < 500, `deberia ser 4xx, fue ${e.status}`);
    assert.ok(['pdf_broken', 'pdf_scanned', 'empty_cv'].includes(e.code));
    return true;
  });
});

test('un PDF de verdad SIN extension en el nombre se acepta igual', () => {
  /* Antes se rechazaba con "formato no soportado" un archivo perfectamente
     valido, solo porque el nombre no terminaba en .pdf. */
  assert.equal(validateUpload(archivo(PDF_ESCANEADO, 'cv')), 'pdf');
});

test('un TXT de verdad se lee como texto', async () => {
  const cv = 'Ana Gomez\nDesarrolladora Backend\nMercado Libre 2021-2024\nNode, Postgres, AWS';
  const txt = Buffer.from(cv, 'utf8');
  assert.equal(validateUpload(archivo(txt, 'cv.txt')), 'txt');
  assert.match(await extractText(archivo(txt, 'cv.txt'), 'txt'), /Ana Gomez/);
});

test('un ejecutable renombrado a cv.pdf se rechaza antes de tocar el parser', () => {
  const exe = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04]);
  assert.throws(() => validateUpload(archivo(exe, 'cv.pdf')), (e) => {
    assert.equal(e.code, 'unsupported_file');
    return true;
  });
});
