# Mavante — Monorepo (API + Web)

Producto para quien busca empleo: puntúa ofertas, adapta el CV a cada búsqueda y prepara la entrevista.
Este repo contiene el **backend de producción** (Node + Postgres) y el **frontend** (single-page estático).

```
mavante/
├── db/
│   └── 001_init.sql              # esquema: users, verification_codes, sessions, cv_documents, usage_daily…
├── scripts/
│   └── migrate.js                # aplica las migraciones en orden
├── src/
│   ├── server.js                 # Express: helmet, CORS con cookies, rutas, shutdown limpio
│   ├── config.js                 # configuración tipada desde .env (falla temprano si falta algo)
│   ├── db.js                     # pool de Postgres + helper de transacciones
│   ├── lib/
│   │   ├── passwordPolicy.js     # 5 reglas de contraseña (módulo puro, testeado)
│   │   ├── password.js           # bcrypt cost 12 + hash señuelo anti-timing
│   │   ├── otpCore.js            # código de 6 dígitos: CSPRNG, HMAC, comparación en tiempo constante
│   │   ├── otp.js                # ciclo de vida en DB: emisión, intentos, expiración, cooldown
│   │   ├── tokens.js             # JWT de acceso + refresh opaco rotativo en cookies httpOnly
│   │   ├── mailer.js             # envío del código (SMTP/Resend) con plantilla HTML
│   │   ├── cvPrompt.js           # ⚠ SYSTEM PROMPT BLINDADO (el corazón del módulo de CVs)
│   │   ├── llm.js                # cliente Anthropic, temperatura 0, prefill de JSON, reintento
│   │   ├── json.js               # extracción robusta del JSON del modelo (módulo puro, testeado)
│   │   ├── cvSchema.js           # contrato del CV: forma + MAPEO ESTRICTO por sección (testeado)
│   │   ├── extract.js            # PDF/DOCX/TXT → texto plano (única fuente de verdad)
│   │   ├── pdf.js                # plantilla ejecutiva A4 en PDFKit (Times, fechas al margen derecho)
│   │   └── docx.js               # misma plantilla en DOCX (tab stops para alinear fechas)
│   ├── middleware/
│   │   ├── auth.js               # authenticate() + requirePro()  ← el paywall vive en el servidor
│   │   ├── rateLimit.js          # límites por IP en signup/login/códigos/IA
│   │   └── errors.js             # HttpError + handler uniforme
│   └── routes/
│       ├── auth.js               # signup · verify · resend · login · refresh · logout · delete account
│       ├── cv.js                 # parse · get · put (Pro) · export (PDF free / DOCX Pro) · tailor · quota
│       └── billing.js            # Stripe checkout + webhook (única fuente de verdad del tier)
├── docs/
│   ├── openapi.yaml              # especificación OpenAPI 3.1 (16 endpoints)
│   └── API.md                    # guía rápida: los 3 flujos que importan
├── test/
│   ├── *.test.js                 # unitarios: password, OTP, contrato del CV, caché, uploads
│   ├── ui/                       # flujos de UI sin navegador (login, ojo, swap de formularios)
│   └── e2e/                      # Playwright: scroll del registro, paywall, autoguardado
└── web/
    ├── index.html                # la app completa (UI, i18n ES/EN/FR/PT, editor de CV, chat)
    ├── api-client.js             # window.MA_API — enchufa el index.html a esta API
    ├── _headers                  # CSP y cabeceras de seguridad (Cloudflare Pages / Netlify)
    └── README-integration.md     # tabla de qué función del front llama a qué endpoint
```

---

## 1. Seguridad y autenticación

### Modelo de datos (`db/001_init.sql`)

| Tabla | Para qué |
|---|---|
| `users` | `password_hash` (bcrypt 12), `is_verified`, `tier` (`free`\|`pro`), `is_discoverable`, bloqueo por intentos |
| `verification_codes` | **hash HMAC** del código, `expires_at` (15 min), `attempts` / `max_attempts` (5), `consumed_at` |
| `sessions` | refresh tokens **hasheados**, rotativos, revocables uno a uno o todos |
| `auth_events` | auditoría: signup, verify_ok/fail, login_ok/fail, lockout, resend |

Nunca se guarda la contraseña ni el código en claro. El código se pepper-ea con `JWT_SECRET`.

### Flujo de registro

```
POST /auth/signup      → valida las 5 reglas + coincidencia, crea el usuario con is_verified=false,
                         emite el código y lo manda por mail. Responde 202 pending_verification.
                         ⚠ El código NUNCA vuelve al cliente.
POST /auth/verify      → consume el código (tiempo constante, 5 intentos, 15 min),
                         marca is_verified=true, abre sesión y setea las cookies httpOnly.
POST /auth/resend      → cooldown de 30s; respuesta uniforme aunque el mail no exista.
POST /auth/login       → mismo mensaje para usuario inexistente y contraseña incorrecta
                         (anti-enumeración) + bloqueo temporal a los 8 fallos.
POST /auth/refresh     → rota el refresh token (el viejo queda revocado).
```

Detalles que suelen faltar y acá están: rejection sampling en el código (sin sesgo), `timingSafeEqual`
para compararlo, hash señuelo en el login para que un usuario inexistente tarde lo mismo, y
respuestas idénticas ante mails existentes o no.

---

## 2. Procesamiento de CVs

### El system prompt (`src/lib/cvPrompt.js`)

Cinco reglas duras: **(1)** solo existe el texto recibido; **(2)** el nombre sale del CV, jamás de la
cuenta; **(3)** mapeo estricto por sección; **(4)** solo se permite normalizar fechas y espacios;
**(5)** salida JSON exacta, con un campo `warnings` para señalar lo que *falta* (nunca datos nuevos).

**El modelo ni siquiera recibe la identidad del usuario.** `buildUserMessage()` le pasa únicamente
`<cv_text>`: no hay `name`, `email`, `id` ni `tier` en el contexto. Lo que no ve, no lo puede filtrar.

### La red de contención (`src/lib/cvSchema.js`)

El servidor no confía en el modelo. Todo pasa por `sanitizeCv()`, que hace cumplir el contrato
aunque el LLM se distraiga (y también cuando un usuario Pro edita a mano):

- **Experiencia** → solo logros profesionales. Se descartan listas de tecnologías, líneas de
  intereses, datos de contacto, líneas de educación y duplicados.
- **Educación** → institución, título, ubicación y período. Los comentarios ("me encantó la cursada")
  se descartan.
- **Habilidades** → términos de 1 a 4 palabras. Las frases se descartan; se dedupe y se elimina lo
  subsumido ("Inglés" dentro de "Inglés avanzado").
- **Intereses** → sin fechas, sin empresas, sin verbos de acción.
- **Contacto** → solo email/teléfono/LinkedIn/GitHub/web/ubicación válidos.

Cubierto por tests (`test/cvSchema.test.js`) con un CV deliberadamente contaminado.

### Paywall (decidido **siempre** en el servidor)

| Acción | free | pro |
|---|---|---|
| `POST /cv/parse` | ✅ (devuelve `preview` + link al PDF, **sin** el JSON) | ✅ (devuelve `cv` editable) |
| `GET /cv/:id/export?format=pdf` | ✅ | ✅ |
| `GET /cv/:id/export?format=docx` | ❌ `403 pro_required` | ✅ |
| `PUT /cv/:id` (edición manual) | ❌ `403 pro_required` | ✅ |
| Cuota diaria | 5 | 30 |

El frontend oculta el editor por UX, pero aunque alguien manipule el JS, el servidor responde 403.

---

## 3. Frontend

`web/index.html` es autosuficiente (modo demo). Con `api-client.js` + `MA_API_BASE` pasa a hablar con
esta API sin tocar la UI — ver `web/README-integration.md`. Lo que incluye, con sus clases:

| Pieza | Dónde |
|---|---|
| Navbar (pastillas, blur, subrayado animado, escala del activo, hide-on-scroll) | `nav.top`, `.nav-links button.plain`, `.nav-cta`, `nav.top.nav-hidden` |
| Sub-nav de Herramientas (sin fondo, subrayado deslizante) | `.seg`, `.seg::after` + `moveSegIndicator()` |
| **Modo enfoque** | `#page-herramientas.focus`, `.tools-back-row`, `enterFocus()` / `exitFocus()` |
| Microcopys por subsección | `.tool-lead` (claves `lead_auto`, `lead_matches`, `lead_adapter`, `lead_analysis`, `lead_role`) |
| Disclaimer de IA | `.disclaimer.ai` (clave `ai_disclaimer`) + `.bot-note` en el chat |
| Aviso de filtros vacíos | `.helper-note` (clave `ap_nofilter`) |
| Hover aumentado en tarjetas | `.feature:hover`, `.value:hover` → `scale(1.07)` + sombra dura desplazada |
| Salida del chat | `#botPanel.closing` → `@keyframes botOut` |
| Pulse del bloque de perfil | `.prof-box.syncing` → `@keyframes profSync` + `pulseProfile()` |
| Editor de CV con paywall | `.cv-doc.locked`, `.cv-lock-btn`, `cvCanEdit()` |

---

## Puesta en marcha

```bash
cp .env.example .env          # completar DATABASE_URL, JWT_SECRET, SMTP_*, ANTHROPIC_API_KEY
npm install
npm run migrate               # crea el esquema
npm test                      # 17 tests, sin red
npm start                     # API en :8080
```

Frontend: subir `web/` a Cloudflare Pages (o cualquier hosting estático) y definir
`window.MA_API_BASE` apuntando a la API. `web/_headers` ya trae CSP y cabeceras de seguridad.

### Checklist de producción

- [ ] `JWT_SECRET` de 64 bytes (`openssl rand -hex 64`), distinto por ambiente.
- [ ] Postgres con SSL (`PGSSL=true`) y backups automáticos.
- [ ] `APP_URL` exacto: el CORS con credenciales no admite `*`.
- [ ] SPF/DKIM en el dominio del remitente para que el código no caiga en spam.
- [ ] Webhook de Stripe apuntando a `/billing/webhook` con su `STRIPE_WEBHOOK_SECRET`.
- [ ] Job de limpieza (cron diario): `delete from verification_codes where expires_at < now() - interval '7 days';`
