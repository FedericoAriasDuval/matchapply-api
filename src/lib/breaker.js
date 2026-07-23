/**
 * src/lib/breaker.js
 * Circuit breaker para las llamadas al proveedor de IA.
 *
 * EL ESCENARIO QUE ESTO EVITA (y que pasa SIEMPRE en un lanzamiento)
 * El proveedor de IA se cae o empieza a tardar 60 s. Sin breaker, cada usuario
 * que sube su CV abre una llamada, espera el timeout completo, y ocupa un slot
 * de la cola durante todo ese tiempo. En dos minutos la cola está llena de
 * requests condenados a fallar, y la gente que llega recibe "servidor saturado"
 * — cuando el servidor está perfecto: el que está roto es el proveedor.
 *
 * El breaker corta esa cadena. Después de N fallos seguidos, ABRE el circuito:
 * durante los siguientes segundos ni siquiera intenta llamar, falla al instante
 * y le devuelve al usuario el motor local en vez de una espera inútil.
 *
 * Tres estados, como manda el patrón:
 *   CERRADO      → todo normal, se llama al proveedor.
 *   ABIERTO      → se falla rápido, sin llamar. Se ahorra tiempo y dinero.
 *   SEMIABIERTO  → pasado el enfriamiento, deja pasar UNA llamada de prueba.
 *                  Si sale bien, cierra. Si falla, vuelve a abrir.
 */
import { HttpError } from '../middleware/errors.js';

export class CircuitBreaker {
  constructor({ threshold = 5, cooldownMs = 30_000, name = 'llm' } = {}) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
    this.name = name;

    this.failures = 0;
    this.state = 'closed'; // closed | open | half
    this.openedAt = 0;
    this.stats = { opened: 0, shortCircuited: 0, ok: 0, fail: 0 };
  }

  get isOpen() {
    if (this.state !== 'open') return false;
    if (Date.now() - this.openedAt >= this.cooldownMs) {
      this.state = 'half'; // se acabó el enfriamiento: dejamos pasar una de prueba
      return false;
    }
    return true;
  }

  _open() {
    if (this.state !== 'open') {
      this.state = 'open';
      this.openedAt = Date.now();
      this.stats.opened++;
      console.warn(
        `[breaker:${this.name}] circuito ABIERTO tras ${this.failures} fallos. ` +
          `Fallamos rápido durante ${Math.round(this.cooldownMs / 1000)}s en vez de hacer esperar a la gente.`,
      );
    }
  }

  _success() {
    this.failures = 0;
    this.stats.ok++;
    if (this.state !== 'closed') {
      this.state = 'closed';
      console.log(`[breaker:${this.name}] circuito CERRADO: el proveedor volvió.`);
    }
  }

  _failure() {
    this.failures++;
    this.stats.fail++;
    if (this.state === 'half' || this.failures >= this.threshold) this._open();
  }

  /**
   * @template T
   * @param {() => Promise<T>} fn
   * @param {() => T|Promise<T>} [fallback] qué hacer cuando el circuito está abierto
   */
  async run(fn, fallback) {
    if (this.isOpen) {
      this.stats.shortCircuited++;
      if (fallback) return fallback();
      /* HttpError, NO un Error pelado: normalize() en middleware/errors.js solo
         reconoce HttpError y unos pocos tipos conocidos; cualquier otra cosa cae
         al 500 "algo se rompió de nuestro lado". O sea que durante TODA la
         ventana de circuito abierto —justo cuando más gente choca— el copy
         humano de llm_circuit_open era inalcanzable y la persona leía un error
         interno en vez de "volvé a intentar en un minuto". */
      throw new HttpError(503, 'llm_circuit_open', 'El servicio de IA está temporalmente fuera de servicio.');
    }
    try {
      const out = await fn();
      this._success();
      return out;
    } catch (err) {
      this._failure();
      if (fallback) return fallback();
      throw err;
    }
  }

  snapshot() {
    return {
      state: this.state,
      failures: this.failures,
      cooldownMs: this.cooldownMs,
      ...this.stats,
    };
  }
}

export const llmBreaker = new CircuitBreaker({
  threshold: Number(process.env.LLM_BREAKER_THRESHOLD ?? 5),
  cooldownMs: Number(process.env.LLM_BREAKER_COOLDOWN_MS ?? 30_000),
  name: 'llm',
});
