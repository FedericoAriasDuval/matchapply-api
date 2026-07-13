/**
 * web/api-client.js
 * Cliente de la API de MatchApply.
 *
 * Cómo se enchufa al index.html (que hoy funciona 100% simulado):
 *
 *   <script>window.MA_API_BASE = 'https://api.matchapply.com';</script>
 *   <script src="/api-client.js"></script>
 *
 * El index.html ya busca `window.MA_API`. Al existir, deja de simular:
 *   - sendVerificationEmail()  -> MA_API.signup() / MA_API.resend()
 *   - verifyOTP()              -> MA_API.verify()
 *   - cvModel()                -> MA_API.parseCv()
 *   - exportCV()               -> MA_API.exportCv()
 *   - cvSync() (guardar)       -> MA_API.saveCv()   [solo Pro]
 *
 * Las sesiones viajan en cookies httpOnly: no guardamos tokens en localStorage
 * (un XSS no puede robarlos) y todas las llamadas van con credentials: 'include'.
 */
(function () {
  const BASE = (window.MA_API_BASE || '').replace(/\/$/, '');

  class ApiError extends Error {
    constructor(status, code, message, extra) {
      super(message || 'Error de red');
      this.status = status;
      this.code = code;
      Object.assign(this, extra || {});
    }
  }

  let refreshing = null;

  async function request(path, { method = 'GET', body, raw = false, retry = true } = {}) {
    const isForm = body instanceof FormData;
    const res = await fetch(BASE + path, {
      method,
      credentials: 'include',
      headers: isForm || !body ? undefined : { 'Content-Type': 'application/json' },
      body: isForm ? body : body ? JSON.stringify(body) : undefined,
    });

    // Access token vencido: se rota el refresh una sola vez y se reintenta.
    if (res.status === 401 && retry && path !== '/auth/refresh') {
      refreshing = refreshing || request('/auth/refresh', { method: 'POST', retry: false }).catch(() => null);
      const ok = await refreshing;
      refreshing = null;
      if (ok) return request(path, { method, body, raw, retry: false });
    }

    if (raw && res.ok) return res.blob();

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = data.error || {};
      throw new ApiError(res.status, e.code || 'error', e.message, e);
    }
    return data;
  }

  const download = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  };

  window.MA_API = {
    ApiError,

    // ---------- auth ----------
    /** Crea la cuenta en estado pendiente y dispara el mail con el código. */
    signup: (payload) => request('/auth/signup', { method: 'POST', body: payload }),
    /** Valida el código de 6 dígitos y abre sesión. */
    verify: (email, code) => request('/auth/verify', { method: 'POST', body: { email, code } }),
    resend: (email) => request('/auth/resend', { method: 'POST', body: { email } }),
    login: (email, password) => request('/auth/login', { method: 'POST', body: { email, password } }),
    logout: () => request('/auth/logout', { method: 'POST' }),
    me: () => request('/auth/me'),
    deleteAccount: () => request('/auth/account', { method: 'DELETE' }),

    /** Compatibilidad con el hook del index.html (sendVerificationEmail). */
    sendCode: (email) => request('/auth/resend', { method: 'POST', body: { email } }).then(() => ({ demo: false })),

    // ---------- cv ----------
    /** file: File | text: string. Devuelve {id, editable, cv?, preview?, quota, warnings}. */
    parseCv: ({ file, text, lang = 'es' }) => {
      if (file) {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('lang', lang);
        return request('/cv/parse', { method: 'POST', body: fd });
      }
      return request('/cv/parse', { method: 'POST', body: { text, lang } });
    },
    getCv: (id) => request('/cv/' + id),
    /** Solo Pro: el servidor devuelve 403 pro_required a los free. */
    saveCv: (id, cv, lang) => request('/cv/' + id, { method: 'PUT', body: { cv, lang } }),
    tailorCv: (id, jobDescription) =>
      request('/cv/' + id + '/tailor', { method: 'POST', body: { jobDescription } }),
    /** free: 'pdf' | pro: 'pdf' | 'docx'. */
    exportCv: async (id, format = 'pdf', filename) => {
      const blob = await request('/cv/' + id + '/export?format=' + format, { raw: true });
      download(blob, filename || 'CV_MatchApply.' + format);
      return true;
    },
    listCvs: () => request('/cv'),
    quota: () => request('/cv/quota/today'),

    // ---------- billing ----------
    upgrade: async () => {
      const { url } = await request('/billing/checkout', { method: 'POST' });
      window.location.href = url;
    },
  };
})();
