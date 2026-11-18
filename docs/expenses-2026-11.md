# Gastos del día a día (noviembre 2026)

## La petición

Del usuario, tal cual: «quiero que me agregues una pestaña para agregar mis
gastos de mi día a día, quiero poder registrar mis gastos que hago al día como
comprando café y cosas, quiero poner mi presupuesto y ahora tengo dos tarjetas
entonces me gustaría tener gastos de las diferentes tarjetas y también un
gráfico unificando ambos gastos, quiero también que para registrar los datos
sea manual y también sea por inteligencia artificial, que pueda mandar captura
de mi factura o de mi captura de mi apple wallet para registrar cada gasto».

Y en las respuestas que siguieron: la moneda se elige dentro de la app, y los
presupuestos son a la vez un total al mes, uno por tarjeta y uno por
categoría.

Se hizo en cinco etapas en la rama `claude/adoring-franklin-dgfuo6`: (1) SQL,
sincronización y moneda; (2) lógica, módulo compartido de la IA, Edge Function
y servidor falso; (3) la interfaz; (4) la copia, el CSV y la documentación;
(5) las pruebas e2e que faltaban y la validación completa.

## Qué hace

- **Una pestaña Gastos** al lado de Apuestas, bajo la cabecera (un
  `tablist`; cada dispositivo recuerda la última en `bettracker:view`, nunca
  en la URL). Solo se monta la vista activa. La cabecera sigue teniendo dos
  botones: en Gastos el principal es **Añadir gasto**; `T` y el **+** del
  móvil abren la hoja de gasto. Las flechas cambian el mes, compartido con el
  calendario de apuestas.
- **El mes**: gastado (los reembolsos restan), presupuesto restante, gasto
  por tarjeta (las tres primeras y «+n más»), media diaria y a qué ritmo va el
  mes; un gráfico que apila el gasto de cada tarjeta con tintas neutras
  («Sin tarjeta», punteada) en dos vistas, acumulado contra la línea del
  presupuesto o por día; barras de presupuestos; desglose por categoría (cada
  fila filtra la lista); y la lista agrupada por día, tabla en escritorio y
  tarjetas en el móvil, con búsqueda y filtros por tarjeta y categoría.
- **Un gasto**: fecha, importe, tarjeta (opcional), comercio, categoría (11
  fijas: café, comida y restaurantes, supermercado, transporte, compras, ocio,
  salud, casa y servicios, suscripciones, viajes, otros), nota y origen (a
  mano o IA). Un importe negativo es un reembolso o abono: sale en verde y
  baja lo gastado. El importe se lee como se teclea: «4,50», «1.234,50»,
  «1,234.50» y, en una moneda sin céntimos, «12.500»; debajo de la casilla se
  ve cómo se ha entendido («= $4.50»). La hoja recuerda la última tarjeta y
  categoría del dispositivo. Alta, edición y borrado tienen Deshacer y
  funcionan sin conexión.
- **Tarjetas**: las que se quieran (nombre de hasta 40 caracteres, últimos 4
  dígitos opcionales, crédito o débito). Borrar una que tiene gastos la
  archiva: sale de los selectores y sus gastos la siguen nombrando. Solo se
  borra de verdad cuando la lista de gastos está cargada, se leyó en esta
  sesión y ninguno la usa.
- **Presupuestos mensuales** (iguales todos los meses): total, por tarjeta y
  por categoría, todos opcionales. Ámbar desde el 80 %, rojo al pasarse;
  nunca bloquean nada.
- **Moneda** de los gastos (ISO 4217, USD por defecto; la lista ofrece USD,
  EUR, MXN, COP, ARS, CLP, PEN, UYU, BOB, PYG, CRC, GTQ, HNL, NIO, DOP, BRL,
  GBP y CAD). Cambiarla no convierte nada, y la app lo dice. Las apuestas
  siguen en dólares y las unidades nunca se aplican a los gastos (la vista
  tiene su propio `MoneyContext`).
- **Escanear recibo**: una foto de un recibo o una captura de Apple Wallet
  se lee con IA y se **revisa** antes de guardar nada (ver «IA» abajo).
- **CSV de gastos** desde la lista (todas las columnas, con las guardas de
  fórmula del CSV de apuestas). El CSV de apuestas no cambia.
- **Copia completa**: incluye los gastos, tarjetas, presupuestos y la moneda;
  esta versión aún no los restaura (ver «Copia»).
- Todo en inglés y español (`i18n.test` exige que estén las mismas claves).

## Modelo de datos (migración 008)

`supabase/migrations/008_expenses.sql`, aditiva y re-ejecutable, después de
la 007 (usa sus triggers) y de la 004 (añade una columna a `user_settings`);
si falta alguna se para con un mensaje. `schema.sql` la repite igual.

| Tabla | Columnas propias | Notas |
|---|---|---|
| `expenses` | `date`, `amount numeric(12,2)` (≠ 0, mismo tope que los movimientos), `card_id uuid` (nulo, **sin FK**), `merchant`, `category` (lista fija), `note`, `source` (`manual`/`ai`) | índice `(user_id, date)` |
| `expense_cards` | `name` (1–40, sin espacios en los extremos), `last4` (`''` o 4 dígitos), `kind` (`credit`/`debit`), `archived` | |
| `expense_budgets` | `scope` (`total`/`card`/`category`), `target` (`''`, id de tarjeta o clave de categoría), `monthly_limit` (> 0) | `unique (user_id, scope, target)` |
| `user_settings` | `expense_currency text not null default 'USD'`, `check (~ '^[A-Z]{3}$')` | |

Las tres tablas tienen `id`, `user_id` (con `on delete cascade`),
`created_at` y `updated_at` (la hora de la edición puesta por el dispositivo,
clave del conflicto como en apuestas y movimientos; ningún trigger la toca),
cuatro policies de RLS, publicación de realtime y los dos triggers de la 007
(una fila borrada no vuelve con un alta reenviada). `supabase/tests/checks.sql`
(sección 11) lo comprueba todo contra Postgres, con RLS ejercida como un
usuario conectado, en las tres variantes de `run.sh`.

## Sincronización

Una capa genérica para tablas sencillas de un usuario, en vez de copiar
`useMoves` tres veces (que no se tocó):

- `data/rowTable.ts`: lectura por páginas, alta, edición con la regla de
  conflicto (`lte('updated_at', sello)`), borrado, envío de una operación y
  suscripción a realtime, a partir de la descripción de la tabla
  (`data/expenseSpecs.ts`). Toda alta escribe `created_at` con la hora en que
  se encoló, para que el orden no cambie al sincronizar. Un alta que choca
  (23505) relee la fila: si su sello es más reciente aplica su contenido; si
  no, adopta la del servidor. En presupuestos busca además por
  `scope`+`target`.
- `data/rowStorage.ts`: caché, cola y rechazadas en el almacenamiento, aplicar
  la cola sobre la caché y conciliar la respuesta.
- `data/useRowSync.ts`: el hook, con `useOpQueue`, `drainOutbox`, el registro
  de confirmaciones entre pestañas y `afterFailedRead`, como los movimientos,
  sin lotes ni restauraciones. `data/rowOps.ts` tiene sus partes puras.

| Nombre | Tabla | Caché (prescindible) | Cola · rechazadas (duraderas) | Canal |
|---|---|---|---|---|
| `expenses` | `public.expenses` | `bettracker:expenses:<uid>` | `bettracker:expenses-outbox:<uid>` · `bettracker:expenses-refused:<uid>` | `expenses-sync` |
| `expense-cards` | `public.expense_cards` | `bettracker:expense-cards:<uid>` | `bettracker:expense-cards-outbox:<uid>` · `…-refused:<uid>` | `expense-cards-sync` |
| `expense-budgets` | `public.expense_budgets` | `bettracker:expense-budgets:<uid>` | `bettracker:expense-budgets-outbox:<uid>` · `…-refused:<uid>` | `expense-budgets-sync` |

Además, por tabla: el registro de confirmaciones `bettracker:confirmed-<nombre>:<uid>`
(prescindible) y los candados `bettracker:queue:<nombre>:<uid>`,
`bettracker:refused:<nombre>:<uid>`, `bettracker:drain:<nombre>:<uid>` y
`bettracker:lock:confirmed-<nombre>:<uid>`. Por usuario,
`bettracker:expense-last:<uid>` (última tarjeta y categoría). Del
dispositivo, `bettracker:view` y `bettracker:spend-chart`. Cerrar sesión
borra todo lo del usuario (`clearUserData`), y cada lista de claves de la app
(la insignia, el contador de la cola, las rechazadas, el aviso de cerrar
sesión con cambios, la demo, el servidor falso) conoce las tres tablas.

**Presupuestos con id determinista** (`lib/stableId.ts`, un hash de usuario,
ámbito y destino con forma de UUID): dos dispositivos que ponen el mismo
presupuesto sin conexión llegan a una sola fila. Quitar un presupuesto borra
su fila; volver a ponerlo sella el alta después de la última fila conocida
para que la lápida de la 007 no se la trague.

### Antes de la 008

Solo cuenta la prueba positiva: `has008` es verdadero cuando en esta sesión
una lectura o una escritura de alguna de las tres tablas funcionó. Sin
conexión no se sabe nada.

- Una lectura que no encuentra la tabla es «ninguno todavía», sin aviso; la
  vista muestra un aviso fijo («falta la 008») mientras ninguna prueba diga lo
  contrario. La app vuelve a leer cada 20 s, al volver la conexión y al volver
  a la app.
- Lo que se añade espera en su cola con «Falta actualizar · n en cola» y un
  solo aviso para las tres tablas (`sharedMigrationNotice`), nunca rechazado;
  se envía en cuanto corre la 008.
- Presupuestos y moneda se quedan desactivados hasta `has008` («Conéctate
  una vez…» o «cuando se haya ejecutado la migración 008»): un parche de
  ajustes con `expense_currency` contra una base sin la columna frenaría todos
  los ajustes. Por lo mismo, una restauración no toca la moneda sin esa
  prueba (`planRestore` con `currencyWritable`).

## IA

**Flujo.** En la hoja de gasto (o con «Escanear recibo» en la barra de la
vista) se elige, pega o suelta una imagen. El cliente la decodifica
(`createImageBitmap`; HEIC solo donde el navegador sepa), la reduce a 1600 px
en el lado largo y la vuelve a codificar como JPEG (≤ ~1,5 MB en base64; eso
quita la ubicación y los datos de la cámara). Llama a la Edge Function
`extract-expenses` con `supabase.functions.invoke` (la app espera hasta 115
s). La respuesta se **revisa**: cada fila se puede editar o desmarcar; la
tarjeta se reconoce en el cliente por los 4 últimos dígitos o el nombre que
la imagen muestra (`lib/cardMatch.ts`); una fila que parece un gasto ya
guardado (misma fecha, importe y tarjeta, comercio parecido) sale
desmarcada junto a ese gasto; las filas dudosas o sin fecha salen abiertas;
se avisa si la moneda leída no es la de los gastos. «Añadir N gastos» encola
N altas normales, con Deshacer. La imagen no se guarda en ningún sitio: ni en
el almacenamiento, ni en borradores, ni en la copia, ni en el servidor.

**La función** (`supabase/functions/extract-expenses/index.ts`, Deno):
CORS con preflight, solo POST, cuerpo con tope, sesión del usuario comprobada
con `auth.getUser` (con la `apikey` de la petición), lista de permitidos
`EXTRACT_ALLOWED_USERS` (sin ella, nadie; un correo solo si está confirmado),
un freno por instancia (una lectura a la vez y 20 cada 10 minutos por
usuario) y la llamada a Claude: `claude-opus-5-5`, `max_tokens` 16000,
`effort: 'medium'`, salida con esquema JSON, el respaldo del servidor ante un
rechazo (`fallbacks: 'default'`), sin reintentos del SDK y con un plazo de
108 s (como mucho un reintento propio tras un fallo rápido de conexión o del
servidor). Registra códigos, tamaños, tiempos y tokens, nunca la imagen, un
importe o un comercio.

**Lo compartido.** `src/shared/expenseExtraction.ts` no importa nada y lo
usan la función, la app y los tests: las categorías, el prompt de sistema
(fijo, sin fechas), el prompt de usuario (hoy y su día de la semana, la zona
horaria, el idioma, la moneda y las tarjetas como pistas: nombre, últimos 4 y
tipo, nunca sus ids), el esquema JSON (`additionalProperties: false`, todo
requerido, sin límites de longitud: se validan en código), la validación de
la petición y de la respuesta (importes redondeados a céntimos, una fecha
futura o de hace más de 400 días se deja en blanco para revisarla, números de
tarjeta y enlaces tapados en los textos, 50 filas como mucho), la lectura del mensaje de
Claude (`stop_reason` antes que el contenido) y la traducción de los errores
del SDK a códigos. Un recibo da un gasto (el total, propina incluida); una
captura de Wallet, uno por transacción visible (las rechazadas fuera, los
reembolsos en negativo, el Daily Cash ignorado, las pendientes marcadas).

**Códigos de error** (y su estado HTTP): `bad_request` 400, `too_large` 413,
`unsupported` 415, `unauthorized` 401, `not_allowed` 403, `not_configured`
503, `limit_reached` 402, `rate_limited` 429, `refused` 422, `too_long` 422,
`bad_output` 502, `ai_rejected` 502, `unavailable` 503, `timeout` 504,
`internal` 500. El cliente añade `offline`, `signed_out`, `not_deployed` (el
404 de la plataforma), `network`, `cancelled`, `heic` y `unreadable`. Cada uno
tiene su texto en en y es, y la entrada a mano siempre sigue disponible.

**Privacidad.** Del dispositivo, por la función, a Anthropic con la clave del
proyecto: la imagen, los nombres y los 4 últimos dígitos de las tarjetas, la
fecha de hoy, la zona horaria, la moneda y el idioma. La función no guarda
nada; la app tampoco guarda nada de la imagen. Anthropic la trata según sus
condiciones comerciales de la API (el texto de la app no promete un plazo de
retención). En la demo no sale nada del navegador: se ve un resultado de
ejemplo y la nota lo dice.

**Coste** (Opus 5.5: 4 $ / 20 $ por millón de tokens de entrada / salida):
una imagen de 1600×1200 son unos 2.600 tokens (ancho × alto / 750; una
captura de Wallet de 739×1600, unos 1.600) más ~1.500 de instrucciones, unos
0,017 $; la salida con el razonamiento a esfuerzo medio, 1.000 a 4.000
tokens, 0,02 a 0,08 $. En total, **unos 3 a 10 céntimos de dólar por
escaneo**. Si Claude rechaza una imagen y responde el modelo de respaldo, ese
intento se cobra a su precio (queda en el registro como `fallback: true`). No
se usa caché de prompt: solo compensa con varios escaneos en 5 minutos; medir
antes de activarla.

**Demo y pruebas.** `demo/fakeSupabase.ts` implementa `functions.invoke`
sin red: valida la petición con el mismo módulo y contesta dos filas de
ejemplo, o lo que digan `e2e:ai-rows`, `e2e:ai-fail`, `e2e:ai-hold` y
`e2e:ai-ignore-abort`, y anota `ai-calls`, `ai-answered` y `ai-last` (solo los
32 primeros caracteres de la imagen, para comprobar que no queda guardada en
ningún otro sitio).

## Copia y CSV

- La copia completa sigue siendo la versión 1 y añade, opcionales,
  `expenses`, `expenseCards`, `expenseBudgets` y `settings.expenseCurrency`.
  Una copia de antes sigue valiendo (sin moneda no se toca la moneda) y una
  app de antes ignora lo nuevo.
- `readBackup` los lee y los cuenta: una lista que falta o no es una lista
  cuenta como ausente (nunca «copia dañada»: no puede impedir restaurar las
  apuestas); una entrada que no pasa las validaciones se descarta sin más.
  La moneda se acepta si es un código ISO (en mayúsculas); otra cosa es
  «ajustes sin sentido», como los demás ajustes.
- La revisión de una restauración dice «Esta copia también contiene N
  gastos, N tarjetas y N presupuestos. Esta versión aún no puede
  restaurarlos» y nunca los cuenta como restaurados. La moneda de la copia se
  ofrece con los demás ajustes solo con `has008`.
- «Descargar copia» espera a que carguen gastos, tarjetas y presupuestos (y
  movimientos y ajustes); «Restaurar» solo a movimientos y ajustes, así que
  un dispositivo que nunca cargó los gastos puede restaurar apuestas.
- El CSV de gastos (`date, amount, currency, card, card_last4, merchant,
  category, note, source`; BOM, CRLF y guardas de fórmula) sale de la lista
  de la vista; el diálogo de importar y exportar lo menciona.

## Decisiones (y por qué)

Las de producto y arquitectura se tomaron antes de empezar y no se
reabrieron; las que más pesan:

- **Capa genérica nueva, `useMoves` intacto**: menos código que tres copias
  y ningún riesgo para lo que ya funciona.
- **`card_id` sin clave foránea**: tarjetas y gastos van por colas distintas;
  un gasto puede llegar antes que su tarjeta.
- **Ids deterministas de presupuesto**: un presupuesto por ámbito y destino
  aunque dos dispositivos lo creen a la vez.
- **Moneda solo de los gastos, sin conversión**, y activable solo con
  prueba de la 008.
- **IA en una Edge Function con la clave en sus secretos y lista de
  permitidos**; el build rechaza una clave de Anthropic en el `.env`.
- **La tarjeta la decide el cliente**: al modelo solo van pistas.
- **La copia guarda los gastos pero aún no los restaura**: restaurarlos pide
  decidir cómo mezclar tarjetas y presupuestos de otra cuenta; mientras, no
  se pierde nada.
- **`deno.json` con `"lock": false`**: sin eso cada `deno check` escribe un
  `deno.lock` en el repositorio. Las dependencias directas van fijadas en el
  import; versionar el lock (que fija las transitivas con su hash) tiene
  sentido cuando haya un `deno check` en CI que lo mantenga.
- **Versión del SDK** (`@anthropic-ai/sdk@1.8.0`): la más nueva con al menos
  7 días al escribirla; al moverla, la misma regla y otro `deno check`.

## Pruebas

- **Unitarias** (vitest): `rowStorage`, `rowTable`, `rowOps`, `useRowSync`
  (con `describe.each` sobre las tres tablas), `stableId`, `categories`,
  `currency`, `spend`, `cardMatch`, `expenseReview`, `expenseCsv`,
  `scanImage`, `expenseForm`, `view`, `extract`, `expenseExtraction` (con una
  guarda que impide imports y globales de un entorno concreto en el módulo
  compartido), `backup` (listas opcionales, moneda, `currencyWritable`) y los
  cambios que forzaron en `errors`, `drain`, `offline`, `store`, `settings`,
  `validate`, `supabaseEnv`, `timeoutFetch`, `demo` y `fakeSupabase`.
- **SQL**: `checks.sql` sección 11 en las variantes A, B y C de `run.sh`.
- **e2e** (Playwright, sin red): `expenses.spec.ts` (12 pruebas: pestañas y
  teclado; alta, edición y borrado sin conexión con Deshacer; sincronización y
  cierre de sesión con una escritura en vuelo; tarjetas; presupuestos;
  moneda; gráfico; escaneo con tarjeta reconocida, duplicado desmarcado,
  reembolso y Deshacer, sin que la imagen quede guardada; fallos de la IA y
  sin conexión; cancelar a media lectura aunque la respuesta llegue después;
  antes de la 008; la revisión a 320 px en es y en), `expenses-sync.spec.ts`
  (3), y añadidos en `mobile.spec.ts` (la vista en un mes pasado y sus dos
  diálogos a 320 y 390 px, en es y en, sin desbordar; ningún campo por debajo
  de 16 px), `demo.spec.ts` (escaneo de ejemplo; «Empezar de cero» vacía los
  gastos) y `backup.spec.ts` (la copia lleva gastos, tarjetas, presupuestos y
  moneda; la moneda solo se ofrece con la 008 probada).
- **La función**: `deno check` (Deno 2.9.6) pasó en la etapa 2 contra los
  tipos reales del SDK y de supabase-js. Nunca se ha llamado a Anthropic ni a
  un proyecto de Supabase real.

## Despliegue

En el README, «AI reading of receipts (optional)», y en `HANDOFF.md`, «Qué
hay que hacer a mano». Orden: (1) la 008 en el editor SQL, después de la 007;
(2) la función y sus secretos con la CLI (`npx supabase@3.2.0`, desde la
raíz del repositorio, con `--env-file` y `--no-verify-jwt`;
`supabase/config.toml` guarda `verify_jwt = false`); (3) la app. En otro
orden no se pierde nada. Si una versión de la CLI no acepta el import de
fuera de `supabase/`, copiar el módulo a
`supabase/functions/_shared/expenseExtraction.ts`, cambiar ese import y
añadir un test que compare los dos archivos.

## Pendiente

- **Restaurar gastos, tarjetas y presupuestos** desde una copia (el formato
  ya los guarda): decidir ids de otra cuenta y presupuestos con id por
  usuario.
- **Endurecer `isOurs` en Electron**: un archivo soltado fuera de la hoja aún
  puede hacer navegar la ventana (pasaba ya antes).
- **Un job de CI** con `denoland/setup-deno` que ejecute el `deno check` de
  la función (y entonces decidir si se versiona `deno.lock`).
- **Una cuota diaria duradera por usuario** para la IA: necesitaría una
  tabla y una función en la base, es decir, una migración y una decisión
  nuevas. Hoy el tope de verdad es el límite de gasto del workspace de
  Anthropic, más la lista de permitidos.
- Probar en vivo, contra el proyecto real: la 008, el despliegue de la
  función y una lectura de verdad (latencia de 10 a 60 s; el límite de tiempo
  de las Edge Functions del plan tiene que pasar de ~110 s).
