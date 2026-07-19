/**
 * src/lib/queue.js
 * Cola de trabajo con concurrencia acotada, timeout duro y límite de espera.
 *
 * POR QUÉ EXISTE
 * El día del lanzamiento el riesgo no es "el servidor no da abasto": es que
 * 300 personas suban su CV en el mismo minuto, cada request abra una llamada al
 * LLM de 20 segundos, y el proceso Node se quede con 300 promesas colgadas
 * comiéndose la memoria hasta morir. Un servidor que se cae por exceso de éxito
 * es el peor resultado posible del viernes.
 *
 * La cola resuelve tres cosas distintas, y conviene no confundirlas:
 *
 *   1. CONCURRENCIA (`concurrency`): cuántos trabajos corren a la vez. Protege
 *      al proveedor de IA y a nuestra memoria.
 *   2. ESPERA (`maxQueue`): cuánta gente puede estar haciendo fila. Si la fila
 *      se desborda, es mejor decirlo AHORA —con un mensaje humano y un tiempo
 *      estimado— que aceptar el trabajo y hacerlo esperar tres minutos para
 *      fallar igual. Fallar rápido y con honestidad es una decisión de producto.
 *   3. TIMEOUT (`timeoutMs`): ningún trabajo puede colgarse para siempre. Sin
 *      esto, un LLM que no responde deja el slot ocupado y la fila se congela.
 *
 * Sin dependencias: no quiero sumar un paquete el martes previo al lanzamiento.
 */

export class TimeoutError extends Error {
  constructor(ms) {
    super(`La operación superó los ${ms} ms.`);
    this.name = 'TimeoutError';
    this.timeoutMs = ms;
  }
}

export class QueueFullError extends Error {
  constructor(waiting, etaSeconds) {
    super('La cola está llena.');
    this.name = 'QueueFullError';
    this.waiting = waiting;
    this.etaSeconds = etaSeconds;
  }
}

export class Queue {
  /**
   * @param {object} o
   * @param {number} o.concurrency  trabajos en paralelo
   * @param {number} o.maxQueue     máximo de trabajos esperando
   * @param {number} o.timeoutMs    timeout duro por trabajo
   */
  constructor({ concurrency = 4, maxQueue = 100, timeoutMs = 45_000 } = {}) {
    this.concurrency = concurrency;
    this.maxQueue = maxQueue;
    this.timeoutMs = timeoutMs;

    this.running = 0;
    this.waiting = [];
    this.closing = false;   // se prende al apagar: ver drain()

    // métricas: sin esto, el día del pico estás volando a ciegas
    this.stats = { done: 0, failed: 0, timedOut: 0, rejected: 0, maxWaitMs: 0, maxDepth: 0 };
    this._durations = []; // últimas 50, para estimar la espera
  }

  get depth() {
    return this.waiting.length;
  }

  /** Segundos estimados de espera para quien llega ahora. Honesto, no optimista. */
  eta() {
    const avg = this._durations.length
      ? this._durations.reduce((a, b) => a + b, 0) / this._durations.length
      : 8_000; // suposición inicial prudente: 8 s por CV
    const ahead = this.waiting.length + this.running;
    return Math.ceil((ahead / this.concurrency) * (avg / 1000));
  }

  _record(ms) {
    this._durations.push(ms);
    if (this._durations.length > 50) this._durations.shift();
  }

  /**
   * Encola una función async. Rechaza de entrada si la fila está desbordada.
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  run(fn) {
    if (this.closing) {
      /* Estamos apagando por un deploy: no aceptamos trabajo nuevo, pero el que
         ya estaba corriendo se termina. Es un 503 honesto, no una desconexión. */
      this.stats.rejected++;
      return Promise.reject(new QueueFullError(this.waiting.length, this.eta()));
    }
    if (this.waiting.length >= this.maxQueue) {
      this.stats.rejected++;
      return Promise.reject(new QueueFullError(this.waiting.length, this.eta()));
    }

    return new Promise((resolve, reject) => {
      const job = { fn, resolve, reject, queuedAt: Date.now() };
      this.waiting.push(job);
      this.stats.maxDepth = Math.max(this.stats.maxDepth, this.waiting.length);
      this._pump();
    });
  }

  /**
   * Deja de aceptar trabajo nuevo y espera a que se vacíe lo que está corriendo.
   *
   * POR QUÉ: en cada deploy Render manda SIGTERM. Sin esto, los CVs que estaban
   * a mitad de análisis se cortaban de un hachazo — y el usuario perdía el
   * análisis DESPUÉS de que ya le habíamos descontado la cuota. Un deploy no
   * puede costarle un uso a alguien que hizo todo bien.
   *
   * @param {number} ms cuánto esperamos como máximo antes de cortar igual.
   * @returns {Promise<boolean>} true si se vació sola, false si venció el plazo.
   */
  async drain(ms = 25_000) {
    this.closing = true;
    const hasta = Date.now() + ms;
    while ((this.running > 0 || this.waiting.length > 0) && Date.now() < hasta) {
      await new Promise((r) => setTimeout(r, 200));
    }
    return this.running === 0 && this.waiting.length === 0;
  }

  _pump() {
    while (this.running < this.concurrency && this.waiting.length) {
      const job = this.waiting.shift();
      this.running++;

      const waited = Date.now() - job.queuedAt;
      this.stats.maxWaitMs = Math.max(this.stats.maxWaitMs, waited);
      const started = Date.now();

      // El timeout no cancela el trabajo de fondo (no podemos abortar cualquier
      // promesa), pero SÍ libera el slot y le contesta al usuario. Un slot
      // ocupado para siempre es lo que congela la fila.
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.stats.timedOut++;
        this.running--;
        job.reject(new TimeoutError(this.timeoutMs));
        this._pump();
      }, this.timeoutMs);

      Promise.resolve()
        .then(job.fn)
        .then(
          (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            this.stats.done++;
            this._record(Date.now() - started);
            this.running--;
            job.resolve(value);
            this._pump();
          },
          (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            this.stats.failed++;
            this.running--;
            job.reject(err);
            this._pump();
          },
        );
    }
  }

  snapshot() {
    return {
      concurrency: this.concurrency,
      running: this.running,
      waiting: this.waiting.length,
      etaSeconds: this.eta(),
      ...this.stats,
    };
  }
}

/**
 * La cola del procesamiento de CVs.
 *
 * concurrency 4: el plan free de Render tiene poca CPU y el parser de PDF es
 * sincrónico. Más de 4 en paralelo no acelera nada — solo hace que TODOS vayan
 * lento, que es la peor forma de estar saturado.
 *
 * maxQueue 120: a 8 s por CV y 4 en paralelo, 120 en fila son ~4 minutos de
 * espera. Más que eso, preferimos decir la verdad y pedirle al usuario que
 * vuelva en un rato.
 */
export const cvQueue = new Queue({
  concurrency: Number(process.env.CV_CONCURRENCY ?? 4),
  maxQueue: Number(process.env.CV_MAX_QUEUE ?? 120),
  timeoutMs: Number(process.env.CV_TIMEOUT_MS ?? 45_000),
});
