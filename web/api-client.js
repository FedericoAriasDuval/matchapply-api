/* =============================================================================
   Mavante · api-client.js
   Puente entre el frontend estático (Cloudflare Pages) y la API (Render).

   Define window.MA_API. Si este archivo no carga —o si la API está caída— el
   frontend sigue funcionando en modo demo local: cada punto de enganche del
   index.html está guardado con `if (window.MA_API && typeof MA_API.x === 'function')`.
   Un backend caído degrada la experiencia; no la rompe.

   Las sesiones viajan en cookies httpOnly. Por eso TODA llamada va con
   `credentials: 'include'` y la API declara `APP_URL` como único origen CORS.
   El código de 6 dígitos nunca vuelve al cliente: lo emite y lo valida el server.
   ========================================================================== */
(function () {
  'use strict';

  var BASE = (window.MA_API_BASE || 'https://api.mavante.com').replace(/\/+$/, '');

  /* El plan free de Render duerme el servicio a los 15 min. El primer request
     después de una siesta tarda ~50s en vez de fallar: por eso el timeout es
     generoso y avisamos al usuario en vez de mentirle con un error genérico. */
  var TIMEOUT_MS = 70000;
  var wokenUp = false;

  function ApiError(code, message, status, details) {
    var e = new Error(message || 'Algo no salió como esperábamos.');
    e.code = code || 'unknown';
    e.status = status || 0;
    e.details = details || null;
    /* El backend siempre manda un 'hint': lo que la persona puede HACER ahora.
       Lo dejamos a mano para que quien muestre el error no tenga que bucear. */
    e.hint = (details && details.hint) || '';
    return e;
  }

  function timeout(ms) {
    var c = new AbortController();
    var id = setTimeout(function () { c.abort(); }, ms);
    return { signal: c.signal, clear: function () { clearTimeout(id); } };
  }

  /* Un solo refresh a la vez, compartido entre todas las llamadas. Antes, 5
     requests con el access vencido disparaban 5 /auth/refresh en paralelo (la
     lluvia de 401 en consola). Y si el refresh MISMO da 401, la sesión está
     muerta de verdad: se avisa una vez al frontend (MA_SESSION_EXPIRED, que
     desloguea) y no se insiste hasta el próximo login. */
  var refreshing = null, sessionDead = false;
  function tryRefresh() {
    if (sessionDead) return Promise.resolve(false);
    if (!refreshing) {
      refreshing = request('/auth/refresh', { method: 'POST', _retried: true })
        .then(function () { return true; })
        .catch(function (e) {
          if (e && e.status === 401) {
            sessionDead = true;
            try { if (typeof window.MA_SESSION_EXPIRED === 'function') window.MA_SESSION_EXPIRED(); } catch (err) {}
          }
          return false;
        })
        .finally(function () { refreshing = null; });
    }
    return refreshing;
  }

  async function request(path, opts) {
    opts = opts || {};
    var t = timeout(opts.timeoutMs || TIMEOUT_MS);
    var init = {
      method: opts.method || 'GET',
      credentials: 'include',            // cookies de sesión httpOnly
      signal: t.signal,
      headers: opts.headers || {}
    };

    if (opts.body instanceof FormData) {
      init.body = opts.body;             // el browser pone el boundary correcto
    } else if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }

    var res;
    try {
      res = await fetch(BASE + path, init);
    } catch (err) {
      t.clear();
      if (err && err.name === 'AbortError') {
        throw ApiError('timeout', 'El servidor está despertando. Probá de nuevo en unos segundos.', 0);
      }
      throw ApiError('offline', 'No pudimos conectar con el servidor.', 0);
    }
    t.clear();
    wokenUp = true;

    /* un login/verify/refresh exitoso revive la sesión: se levanta el candado.
       Va ANTES del atajo de los 204, que también son res.ok. */
    if (res.ok && (path === '/auth/login' || path === '/auth/verify' || path === '/auth/refresh')) sessionDead = false;

    /* 204 y respuestas sin cuerpo */
    if (res.status === 204) return {};

    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }

    if (!res.ok) {
      /* El access token venció: UN refresh compartido y se reintenta una vez. */
      if (res.status === 401 && !opts._retried && path !== '/auth/refresh' && path !== '/auth/login') {
        var refreshed = await tryRefresh();
        if (refreshed) return request(path, Object.assign({}, opts, { _retried: true }));
      }
      /* El backend envuelve TODO en {error:{code,message,hint,...}}. Leerlo plano
         dejaba e.code en 'http_429' y el mensaje en un genérico: los chequeos por
         código acertaban de casualidad (porque además miran e.status) y el texto
         humano del backend no llegaba nunca. */
      var payload = (data && data.error) ? data.error : (data || {});
      throw ApiError(
        payload.code || 'http_' + res.status,
        payload.message || 'El servidor respondió con un error.',
        res.status,
        payload
      );
    }
    return data || {};
  }

  window.MA_API = {
    base: BASE,

    /* ---------------------------------------------------------------- salud */
    health: function () {
      return request('/health', { timeoutMs: TIMEOUT_MS });
    },
    /** true si ya hablamos con la API al menos una vez en esta sesión. */
    isAwake: function () { return wokenUp; },

    /* ----------------------------------------------------------------- auth */
    /** Alta: crea la cuenta sin verificar y dispara el mail con el código. */
    signup: function (payload) {
      return request('/auth/signup', {
        method: 'POST',
        body: {
          name: payload.name,
          email: payload.email,
          password: payload.password,
          passwordConfirm: payload.passwordConfirm !== undefined ? payload.passwordConfirm : payload.password,
          isDiscoverable: !!payload.isDiscoverable,
          /* El codigo de invitacion viaja ACA y no en un endpoint aparte: el
             signup es el unico momento en que sabemos que la persona es nueva.
             Si no hay codigo, no mandamos la clave. */
          ref: payload.ref || undefined
        }
      });
    },

    /** Valida el código de 6 dígitos y abre sesión. Devuelve { user }. */
    verifyCode: function (email, code) {
      return request('/auth/verify', { method: 'POST', body: { email: email, code: String(code) } });
    },

    /** Reenvía el código (el server aplica su propio cooldown). */
    sendCode: function (email) {
      return request('/auth/resend', { method: 'POST', body: { email: email } });
    },

    login: function (email, password) {
      return request('/auth/login', { method: 'POST', body: { email: email, password: password } });
    },

    logout: function () {
      return request('/auth/logout', { method: 'POST' });
    },

    /** Sesión activa al cargar la página. Devuelve null si no hay. */
    me: function () {
      return request('/auth/me').then(function (r) { return (r && r.user) || null; })
                               .catch(function () { return null; });
    },

    /* ------------------------------------------------------------------- CV */
    /**
     * Procesa un CV. Acepta { file } (PDF/DOCX/TXT) o { text }.
     * free → devuelve resumen + id (sin JSON editable)
     * pro  → devuelve el JSON completo para el editor
     */
    parseCv: function (opts) {
      opts = opts || {};
      if (opts.file) {
        var fd = new FormData();
        fd.append('file', opts.file);
        fd.append('lang', opts.lang || 'es');
        return request('/cv/parse', { method: 'POST', body: fd });
      }
      return request('/cv/parse', {
        method: 'POST',
        body: { text: opts.text || '', lang: opts.lang || 'es' }
      });
    },

    getCv: function (id) { return request('/cv/' + encodeURIComponent(id)); },

    /** Guardar ediciones manuales: el server exige plan Pro (paywall real). */
    saveCv: function (id, cv) {
      return request('/cv/' + encodeURIComponent(id), { method: 'PUT', body: { cv: cv } });
    },

    /** Adapta el CV a un puesto. jobDescription = texto de la vacante. */
    /* lang manda el idioma de la RESPUESTA del modelo (motivos y resumen
       adaptado). Sin el, el backend contestaba siempre en espanol y alguien con
       la web en ingles recibia un resumen en espanol pegado a su CV. */
    tailorCv: function (id, jobDescription, lang) {
      return request('/cv/' + encodeURIComponent(id) + '/tailor', {
        method: 'POST',
        body: { jobDescription: jobDescription, lang: lang || undefined }
      });
    },

    /** Carta de presentación (solo Pro). opts: { jobDescription, tone, lang, draft }.
        Con draft (carta propia del usuario), la IA la MEJORA en vez de escribir de cero. */
    coverLetter: function (id, opts) {
      opts = opts || {};
      return request('/cv/' + encodeURIComponent(id) + '/cover', {
        method: 'POST',
        body: { jobDescription: opts.jobDescription || '', tone: opts.tone || 'formal', lang: opts.lang || 'es', draft: opts.draft || '' }
      });
    },

    /** Simulador de entrevista (solo Pro). Un turno por llamada.
        opts: { role, context, jobDescription, lang, history:[{q,a}], session }.
        session = token de continuación que devuelve el server; se reenvía en
        cada turno para no re-cobrar la cuota (el server lo exige para seguir). */
    interview: function (id, opts) {
      opts = opts || {};
      return request('/cv/' + encodeURIComponent(id) + '/interview', {
        method: 'POST',
        body: {
          role: opts.role || '', context: opts.context || 'regular',
          jobDescription: opts.jobDescription || '', lang: opts.lang || 'es',
          history: opts.history || [], session: opts.session || ''
        }
      });
    },

    /** URL de descarga (PDF o DOCX). La cookie viaja sola. */
    exportUrl: function (id, format) {
      return BASE + '/cv/' + encodeURIComponent(id) + '/export?format=' + (format === 'docx' ? 'docx' : 'pdf');
    },

    quota: function () { return request('/cv/quota/today'); },

    /* ------------------------------------------------------------ analytics */
    /* Deliberadamente NO exponemos MA_API.track: la API todavía no tiene un
       endpoint /analytics, y un cliente que dispara requests a una ruta que no
       existe es basura silenciosa. El frontend detecta la ausencia del método y
       usa los proveedores que sí estén cargados (gtag, mixpanel, dataLayer). */

    /* -------------------------------------------------------------- referidos */
    /* El credito se paga en el backend al verificar el email, no aca. El cliente
       solo lee lo que ya ocurrio: nunca es la fuente de verdad de un premio. */
    referrals: function () { return request('/referrals/me'); },

    /* ------------------------------------------------------------- oauth */
    /* Que proveedores estan configurados. El frontend no dibuja un boton que
       no funciona: un "Entrar con Google" que lleva a un error rompe la
       confianza justo cuando la persona decidio entrar. */
    providers: function () { return request('/auth/providers'); },

    /* ---------------------------------------------------------------- billing */
    /* method: 'mercadopago' | 'paddle'. Sin method, el backend usa el primero disponible. */
    checkout: function (method) {
      return request('/billing/checkout', { method: 'POST', body: method ? { method: method } : undefined });
    }
  };

  /* Despertar el servicio apenas carga la página: así, cuando el usuario
     realmente necesite la API, ya está caliente y no espera los 50 segundos. */
  try {
    if ('requestIdleCallback' in window) {
      requestIdleCallback(function () { window.MA_API.health().catch(function () {}); }, { timeout: 3000 });
    } else {
      setTimeout(function () { window.MA_API.health().catch(function () {}); }, 1200);
    }
  } catch (e) { /* nada */ }
})();
