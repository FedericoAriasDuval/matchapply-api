# Integración del frontend con la API

El `index.html` de Mavante es autosuficiente: sin backend funciona en modo demo
(simulación local). Al cargar `api-client.js` y definir `MA_API_BASE`, los mismos
puntos de entrada pasan a hablar con la API real, sin tocar la UI.

```html
<!-- al final del <body>, antes de </body> -->
<script>window.MA_API_BASE = 'https://api.mavante.com';</script>
<script src="/api-client.js"></script>
```

## Puntos de enganche ya presentes en index.html

| Función del index.html      | Qué hace hoy (demo)                       | Qué hace con la API                          |
|-----------------------------|-------------------------------------------|----------------------------------------------|
| `sendVerificationEmail()`   | genera el código en el cliente            | `POST /auth/signup` → el código va por mail   |
| `verifyOTP()`               | compara contra el código local            | `POST /auth/verify` → crea la sesión          |
| `doAuth()` (login)          | guarda el usuario en localStorage         | `POST /auth/login` → cookie httpOnly          |
| `cvModel()` / `cvParse()`   | parser heurístico en el navegador         | `POST /cv/parse` → LLM con prompt blindado    |
| `cvSync()` (guardar edición)| escribe en localStorage                   | `PUT /cv/:id` → **403 si el usuario es free** |
| `exportCV('pdf')`           | jsPDF en el cliente                       | `GET /cv/:id/export?format=pdf`               |
| `exportCV('docx')`          | blob de Word en el cliente                | `GET /cv/:id/export?format=docx` (**Pro**)    |
| `openUpgrade()`             | modal de demo                             | `POST /billing/checkout` → Stripe             |

## Regla de oro

El paywall **no** se decide en el navegador. El cliente oculta el editor por UX,
pero quien manda es el servidor: `PUT /cv/:id` y el export en DOCX responden
`403 pro_required` a cualquier usuario `free`, aunque manipulen el JS.
