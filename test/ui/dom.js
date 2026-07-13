/**
 * test/ui/dom.js
 * Arnés de pruebas de UI sin dependencias: ejecuta el <script> de web/index.html
 * dentro de un contexto vm con un DOM mínimo pero fiel para lo que testeamos.
 *
 * Permite testear los flujos críticos (login, ojo de contraseña, cambio de
 * formulario) sin instalar jsdom ni Playwright.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.join(__dirname, '..', '..', 'web', 'index.html');

const makeClassList = () => {
  const set = new Set();
  return {
    _set: set,
    add: (...c) => c.forEach((x) => set.add(x)),
    remove: (...c) => c.forEach((x) => set.delete(x)),
    toggle: (c, v) => (v === undefined ? (set.has(c) ? set.delete(c) : set.add(c)) : v ? set.add(c) : set.delete(c)),
    contains: (c) => set.has(c),
    get value() { return [...set].join(' '); },
  };
};

const makeEl = (id = '') => ({
  id,
  value: '',
  type: '',
  textContent: '',
  innerHTML: '',
  style: { setProperty() {}, removeProperty() {} },
  dataset: {},
  disabled: false,
  parentNode: null,
  classList: makeClassList(),
  _listeners: {},
  appendChild() {},
  insertAdjacentHTML() {},
  addEventListener(ev, fn) { (this._listeners[ev] ??= []).push(fn); },
  dispatch(ev, arg) { (this._listeners[ev] ?? []).forEach((f) => f(arg ?? {})); },
  setAttribute(k, v) { this[`attr_${k}`] = v; },
  getAttribute(k) { return this[`attr_${k}`] ?? null; },
  removeAttribute(k) { delete this[`attr_${k}`]; },
  focus() {},
  remove() {},
  contains() { return false; },
  // los nodos hijos existen: la app compone HTML y luego lo consulta (toasts, modales)
  querySelector() { return makeEl('child'); },
  querySelectorAll() { return []; },
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 80, width: 200, height: 80 }; },
  scrollIntoView() {},
  offsetLeft: 0,
  offsetWidth: 0,
  offsetHeight: 0,
});

/** Levanta la app en un contexto aislado. */
export const boot = ({ profile = '', storage = {}, absent = ['authBody'] } = {}) => {
  const missing = new Set(absent); // ids que aún no están montados: getElementById devuelve null, como el DOM real
  const html = fs.readFileSync(HTML, 'utf8');
  const script = /<script>\n([\s\S]*)\n<\/script>/.exec(html)[1];

  const els = new Map();
  const get = (id) => {
    if (missing.has(id)) return null;
    if (!els.has(id)) els.set(id, makeEl(id));
    return els.get(id);
  };
  /** el elemento pasa a existir (equivale a que la app lo haya renderizado) */
  const mount = (id) => { missing.delete(id); return get(id); };

  const body = makeEl('body');
  const document = {
    getElementById: get,
    querySelector: () => makeEl('q'),
    querySelectorAll: () => [],
    addEventListener() {},
    createElement: () => makeEl('new'),
    body,
    head: { appendChild() {} },
    documentElement: {},
    activeElement: null,
    title: '',
    hidden: false,
  };

  const win = {
    addEventListener() {},
    removeEventListener() {},
    innerWidth: 1280,
    innerHeight: 900,
    scrollY: 0,
    scrollTo() {},
    dataLayer: [],
    requestIdleCallback: (fn) => fn(),
    crypto: { getRandomValues: (a) => { a[0] = Math.floor(Math.random() * 0xffffffff); return a; } },
  };

  const ctx = {
    document,
    window: win,
    crypto: win.crypto,
    Uint32Array,
    localStorage: {
      getItem: (k) => storage[k] ?? null,
      setItem: (k, v) => { storage[k] = String(v); },
      removeItem: (k) => { delete storage[k]; },
    },
    location: { hash: '', origin: 'https://matchapply.test', pathname: '/' },
    history: { replaceState() {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: (fn) => fn(),
    requestIdleCallback: (fn) => fn(),
    console: { log() {}, warn() {}, error() {}, debug() {} },
    Blob: function Blob() {},
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    Promise, JSON, Math, Date, RegExp, encodeURIComponent, indexedDB: undefined,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);

  els.set('profile', makeEl('profile'));
  els.get('profile').value = profile;
  els.set('adapterSel', makeEl('adapterSel'));
  els.set('roleSel', makeEl('roleSel'));
  els.get('roleSel').value = '1';

  vm.runInContext(script, ctx);
  return { ctx, get, mount, storage, run: (code) => vm.runInContext(code, ctx) };
};
