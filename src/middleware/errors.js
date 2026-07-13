export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const badRequest = (code, message, extra) => new HttpError(400, code, message, extra);
export const unauthorized = (code = 'unauthorized', message = 'Necesitás iniciar sesión.') =>
  new HttpError(401, code, message);
export const forbidden = (code, message, extra) => new HttpError(403, code, message, extra);
export const tooMany = (code, message, extra) => new HttpError(429, code, message, extra);

export const notFound = (_req, res) =>
  res.status(404).json({ error: { code: 'not_found', message: 'Ruta inexistente.' } });

// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, req, res, _next) => {
  const status = err.status ?? 500;
  if (status >= 500) console.error('[error]', req.method, req.path, err);
  res.status(status).json({
    error: {
      code: err.code ?? 'internal_error',
      message: status >= 500 ? 'Error interno.' : err.message,
      ...err.extra,
    },
  });
};
