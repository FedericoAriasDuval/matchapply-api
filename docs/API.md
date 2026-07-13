# API de MatchApply — guía rápida

> Especificación completa: [`docs/openapi.yaml`](./openapi.yaml).
> Podés abrirla en <https://editor.swagger.io> o servirla con `npx @redocly/cli preview-docs docs/openapi.yaml`.

## En 60 segundos

```bash
cp .env.example .env      # completar DATABASE_URL, JWT_SECRET, SMTP_*, ANTHROPIC_API_KEY
npm install
npm run migrate           # crea el esquema
npm test                  # 34 tests, sin red ni base de datos
npm start                 # API en :8080
```

O todo junto, sin instalar nada: `docker compose up --build`.

## Los tres flujos que importan

### 1. Alta de cuenta (con verificación)

```
POST /auth/signup     → 202 pending_verification   (el código va por mail, nunca en la respuesta)
POST /auth/verify     → 200 + cookies de sesión    (15 min, 5 intentos, tiempo constante)
POST /auth/resend     → 202                        (cooldown 30s)
```

La contraseña se valida contra 5 reglas **en el servidor** y se guarda con bcrypt (cost 12).
La cuenta nace con `is_verified = false` y no puede hacer nada hasta verificarse.

### 2. Procesar un CV

```
POST /cv/parse              (multipart: file | json: text)
  → free : { preview, downloadPdf }        ← sin JSON editable
  → pro  : { cv: {...} }                   ← con JSON editable

GET  /cv/:id/export?format=pdf     ← todos
GET  /cv/:id/export?format=docx    ← 403 pro_required si es free
PUT  /cv/:id                       ← 403 pro_required si es free
```

Reglas duras del motor:
- El modelo recibe **solo el texto del CV**. No se le pasa el nombre, el email ni el tier del usuario.
- La salida se valida y se sanea: cada dato solo puede quedar en su sección nativa.
- Si el usuario ya subió ese CV (`source_hash`), se devuelve cacheado: sin cuota, sin llamada al modelo.
- Los archivos se validan por **firma binaria** (un `.exe` renombrado a `cv.pdf` se rechaza).

### 3. Paywall

El tier se decide **siempre** en el servidor (`requirePro`). El frontend oculta el editor por UX,
pero aunque alguien manipule el JS, `PUT /cv/:id` y el export en DOCX responden `403 pro_required`.
La única fuente de verdad del tier es el webhook de Stripe.

## Formato de errores

```json
{ "error": { "code": "pro_required", "message": "Esta función es exclusiva de MatchApply Pro.", "upgrade": true } }
```

| Código | Cuándo |
|---|---|
| `weak_password` | La contraseña no cumple las 5 reglas (trae `failed[]` con cuáles) |
| `invalid_code` / `code_expired` / `code_too_many` | Verificación por email |
| `invalid_credentials` | Login (mismo mensaje exista o no el usuario: anti-enumeración) |
| `not_verified` | Login con la cuenta sin verificar (se reenvía el código) |
| `account_locked` | 8 fallos seguidos |
| `pro_required` | Función exclusiva de Pro |
| `quota_exceeded` | Límite diario (free 5 / pro 30) |
| `unsupported_file` / `file_too_large` | Upload rechazado |

## Tests

```bash
npm test          # 34 unitarios + de integración, sin dependencias externas
npm run test:e2e  # Playwright (requiere: npm i -D @playwright/test && npx playwright install)
```

Cubren, entre otros: las 5 reglas de contraseña, el código OTP (sin sesgo, hash, tiempo constante),
el contrato de secciones del CV con un currículum deliberadamente contaminado, la caché LRU,
la validación de uploads, y los tres bugs de login que corregimos (botón bloqueado, scroll trabado,
transición entre formularios).
