import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeFilename, validateUpload } from '../src/lib/upload.js';

const file = (bytes, { size, name = 'cv.pdf' } = {}) => {
  const buffer = Buffer.from(bytes);
  return { buffer, size: size ?? buffer.length, originalname: name };
};

test('detecta el tipo real por firma binaria, no por la extensión', () => {
  assert.equal(validateUpload(file([0x25, 0x50, 0x44, 0x46, 0x2d], { name: 'cv.docx' })), 'pdf');
  assert.equal(validateUpload(file([0x50, 0x4b, 0x03, 0x04, 0x14], { name: 'cv.pdf' })), 'docx');
  assert.equal(validateUpload(file([...Buffer.from('Federico Arias Duval\nDeveloper')], { name: 'cv.txt' })), 'txt');
});

test('rechaza un ejecutable renombrado a cv.pdf', () => {
  const elf = [0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x00];
  assert.throws(() => validateUpload(file(elf, { name: 'cv.pdf' })), /no parece un CV/);
});

test('rechaza archivos que superan el límite de 8 MB', () => {
  assert.throws(() => validateUpload(file([0x25, 0x50, 0x44, 0x46], { size: 9 * 1024 * 1024 })), /8 MB/);
});

test('sanitiza el nombre del archivo (path traversal)', () => {
  assert.equal(safeFilename('../../etc/passwd'), '._._etc_passwd');
  assert.ok(!safeFilename('cv/../../secret.pdf').includes('/'));
});
