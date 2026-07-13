# web/index.html — mapa de componentes

Un solo archivo, sin build. Orden interno: `<style>` (base → identidad de módulo → tipografía →
auth) · markup · `<script>` (i18n → datos → CV → UI → auth → init).

## Navbar principal — lenguaje de "pastillas"
```css
nav.top            /* blur + saturate, sombra al scrollear, translateY(-100%) al bajar */
.nav-links button.plain::after   /* subrayado animado que se completa en la sección activa */
.nav-links button.plain.active   /* scale(1.08) + weight 600 */
.nav-cta, .acct-btn, .lang-btn   /* border-radius: 980px — reservado para la navbar */
```
Scrollspy: `scrollSpy()` dentro del listener de scroll cambia el activo entre `#inicio` y `#nosotros`.

## Sub-navegación de Herramientas — lenguaje de "líneas"
Deliberadamente opuesta a la navbar: sin fondo, sin pastillas.
```css
.seg              /* transparente, borde inferior hairline, sin scrollbar */
.seg::after       /* línea de 3px en degradé que se desliza (--ind-x / --ind-w) */
.seg button.active/* navy + bold, sin fondo */
```
`moveSegIndicator()` mide `offsetLeft/offsetWidth` del botón activo y mueve la línea.

## Modo enfoque
```js
enterFocus()  // switchTab() y restoreRoute() con tab en la URL
exitFocus()   // botón "‹ Ver todas las herramientas"
```
```css
#page-herramientas.focus .seg-wrap  { max-height:0; opacity:0; transform:translateY(-10px); }
#page-herramientas.focus .tools-back-row { max-height:60px; opacity:1; }
```

## Microcopys y disclaimers
- `.tool-lead` → una línea por subsección (`lead_auto`, `lead_matches`, `lead_adapter`, `lead_analysis`, `lead_role`).
- `.disclaimer.ai` → "La IA puede cometer errores; revisá siempre los datos. Jamás recomendamos mentir en tu CV."
- `.bot-note` → la misma advertencia dentro del chat.
- `.helper-note` → "Si no seleccionás ninguna opción… buscamos de forma masiva cualquier oferta compatible."

## Animaciones firmadas
```css
.feature:hover, .value:hover  /* scale(1.07) + translate(-3px,-3px) + sombra dura 8px 8px 0 */
#botPanel.closing             /* botOut: rebote y caída hacia la esquina inferior derecha */
.prof-box.syncing             /* profSync: fade + scale + halo + chips en cascada */
```

## Editor de CV (paywall)
`cvCanEdit()` = `isPremium() && cvEditOn`. Sin Pro, la hoja se renderiza con `contenteditable="false"`,
clase `.locked` (oculta ✕ y "+ agregar") y el botón `.cv-lock-btn` 👑 abre el upgrade.
Con backend, `PUT /cv/:id` devuelve 403 igual: el cliente nunca es la autoridad.
