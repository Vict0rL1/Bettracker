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
  en la URL). Solo se monta la vista activa. La cabecera solo tiene el
  nombre, la sincronización y el menú ☰, donde están los **Ajustes de
  gastos** (tarjetas, presupuestos y moneda, desde cualquiera de las dos
  vistas); la barra de la vista, solo el mes, su moneda y las flechas. El
  **+** de abajo a la derecha, en el ordenador como en el móvil, y `T` abren
  la hoja de gasto, que empieza por **Escanear recibo**. Las flechas cambian
  el mes, compartido con el calendario de apuestas.
- **El mes**: gastado (los reembolsos restan) y cómo va frente al mes
  anterior, presupuesto restante, gasto
  por tarjeta (las tres primeras y «+n más», que enseña todas), media diaria
  de los días hasta hoy y a qué ritmo va el mes (ver «Pulido 2.0»); un
  gráfico que apila el gasto de cada tarjeta con tintas neutras
  («Sin tarjeta», punteada) en dos vistas, acumulado contra la línea del
  presupuesto o por día; barras de presupuestos; desglose por categoría; y la
  lista agrupada por día, tabla en escritorio y tarjetas en el móvil, con
  búsqueda y filtros por tarjeta y categoría. Cada línea que nombra una
  tarjeta o una categoría enseña sus gastos al tocarla (ver «Tocar una
  tarjeta o una categoría»).
- **Un gasto**: fecha, importe, tarjeta (opcional), comercio, categoría (11
  fijas: café, comida y restaurantes, supermercado, transporte, compras, ocio,
  salud, casa y servicios, suscripciones, viajes, otros), nota y origen (a
  mano o IA). Un importe negativo es un reembolso o abono: sale en verde y
  baja lo gastado. El importe se lee como se teclea: «4,50», «1.234,50»,
  «1,234.50» y, en una moneda sin céntimos, «12.500»; debajo de la casilla se
  ve cómo se ha entendido («= $4.50»). La hoja recuerda la última tarjeta y
  categoría del dispositivo, sugiere los comercios ya escritos y, con uno de
  ellos, trae la categoría y la tarjeta con que se archivó la última vez
  (ver «Pulido de noviembre»). Alta, edición y borrado tienen Deshacer y
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
  GBP y CAD). Es la moneda principal del usuario. Cambiarla no convierte
  nada, y la app lo dice. Las apuestas siguen en dólares y las unidades nunca
  se aplican a los gastos (la vista tiene su propio `MoneyContext`).
- **Gastos en otra moneda**: un gasto se puede pagar en una moneda que no es
  la principal; la app guarda lo pagado y lo convierte (ver «Otras monedas y
  tasas de cambio» abajo).
- **Escanear recibo** (lo primero de la hoja de gasto): una foto de un
  recibo o una captura de Apple Wallet se lee con IA y se **revisa** antes de
  guardar nada (ver «IA» abajo).
- **CSV de gastos** desde la lista (todas las columnas, con las guardas de
  fórmula del CSV de apuestas; lo pagado en otra moneda, su código y la tasa
  van en tres columnas al final). El CSV de apuestas no cambia.
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

## Otras monedas y tasas de cambio (migración 009)

Petición del usuario, tal cual: «la moneda principal que quiero es dólar
canadiense pero en algunas transacciones tengo usd entonces me gustaría que
en la app registrara los gastos y los convierta a cad».

**Qué hace.** La moneda de los ajustes (CAD) es la principal: en ella están
todos los totales, presupuestos, gráficos y categorías, igual que antes. Un
gasto pagado en otra moneda (USD) guarda además lo que se pagó, en qué
moneda y con qué tasa, y cuenta por su importe convertido.

**Datos** (`supabase/migrations/009_expense_original_currency.sql`, aditiva y
re-ejecutable, después de la 008; se para con un mensaje si falta la tabla;
`schema.sql` la repite igual). Tres columnas nuevas en `expenses`:

| Columna | Tipo | Qué es |
|---|---|---|
| `original_amount` | `numeric(12,2)` | lo pagado, en su moneda; con el mismo signo que `amount`, nunca 0, mismo tope |
| `original_currency` | `text` | su código ISO 4217 (`^[A-Z]{3}$`) |
| `fx_rate` | `numeric(18,8)` | unidades de la moneda principal por 1 de la original, mayor que 0 |

Las tres nulas (un gasto en la moneda principal: todas las filas de antes) o
las tres con valor; cinco constraints con nombre lo exigen. **`amount` no
cambia de significado**: sigue siendo el importe en la moneda principal.
Normalmente es `round(original × tasa)`, pero el usuario puede escribir lo
que cobró el banco (que añade su comisión), así que la base no comprueba que
los tres cuadren. `checks.sql` (sección 12) lo prueba en las tres variantes
de `run.sh`: filas de antes, altas de una app anterior a la 009, la regla de
conflicto, cada constraint y las policies.

En el código: `Expense` y `ExpenseInput` ganan `originalAmount`,
`originalCurrency` y `fxRate`; `normalizeExpense` los valida (todos o
ninguno, código ISO, tasa finita mayor que 0 redondeada a 8 decimales,
original al céntimo y con el signo del importe); `expenseSpecs.ts` los lee,
escribe e hidrata (un trío a medias o sin sentido se lee como «sin original»,
nunca como medio original: el gasto se sigue viendo y enviando por su
importe); la copia completa los guarda (opcionales en el archivo: una copia
anterior sigue leyéndose) y el CSV los añade al final (`original_amount`,
`original_currency`, `fx_rate`).

**Antes de la 009** (la base tiene la 008). Se sigue el precedente de
`closing_odds` en las apuestas: toda alta o edición de un gasto envía las
tres columnas (nulas si está en la moneda principal), PostgREST contesta
PGRST204 («Could not find the 'original_amount' column of 'expenses' in the
schema cache») y `data/errors.ts` lo clasifica como «falta actualizar»: el
cambio **espera en la cola**, nunca se rechaza, y se envía solo cuando corre
la 009. Se avisa una vez, no en cada reintento, y la vista Gastos muestra un
aviso fijo que nombra el archivo de la 009 (`migration009` en
`useRowSync.ts`: la tabla se ha leído o escrito en esta sesión y hay un
cambio de gastos esperando una migración). Leer, los presupuestos y la
moneda funcionan igual que con la 009. Un detalle de la capa de
sincronización: para las tarjetas y los presupuestos una lectura que funciona
da por terminada la espera (la tabla existe); para los gastos ya no, porque
la tabla puede leerse mientras sus escrituras esperan una columna
(`columnsMayLag` en la descripción de la tabla). Sin eso, cada lectura
«curaba» el estado y el siguiente reintento volvía a avisar.

**De dónde salen las tasas.** De Frankfurter (`api.frankfurter.dev`), un
servicio gratuito, sin cuenta ni clave, que publica las tasas de referencia
del Banco Central Europeo: una por día hábil, hacia las 16:00 CET, de unas
treinta monedas (USD, CAD, EUR, GBP, MXN, BRL…; no COP, ARS, CLP ni PEN).
`GET /v1/{fecha | latest}?base=USD&symbols=CAD` responde
`{"amount":1.0,"base":"USD","date":"2026-11-13","rates":{"CAD":1.4034}}`; un
fin de semana o un festivo responde con el día hábil anterior (el `date` de
la respuesta dice cuál), y para hoy o una fecha futura se pide `latest`.

- `lib/fx.ts` es la parte pura, **sin imports**: la URL, la lectura
  defensiva de la respuesta (objeto, misma base, fecha real, tasa numérica,
  finita y mayor que 0; cualquier otra forma es «sin tasa», nunca una tasa
  inventada), la conversión en unidades enteras (`convert`: céntimos × la
  tasa con 8 decimales en `BigInt`, redondeo a la mitad hacia arriba, a los
  decimales de la moneda principal), `rateFrom` (la tasa que hay detrás de lo
  que cobró el banco) y la caché (forma, vigencia y poda).
- `data/fxRates.ts` hace la petición: `getRate(de, a, fecha, { signal })`
  devuelve `{ ok: true, rate, asOf, source: 'service' | 'cache' | 'last' }` o
  `{ ok: false, reason: 'offline' | 'unsupported' | 'unavailable' }` y **nunca
  lanza**. Un `fetch` normal con `credentials: 'omit'` y `referrerPolicy:
  'no-referrer'`, sin cabeceras propias (así no hay preflight) y con un
  plazo de 8 s; **no** pasa por el cliente de Supabase. Un 4xx para un par
  (salvo 408, 425 y 429, que son «ahora no») es «sin tasas para este par» y
  se recuerda durante la sesión.
- **Caché**: una sola clave del dispositivo, `bettracker:fx` (no por
  usuario: una tasa no es dato de nadie; cerrar sesión no la borra y «Empezar
  de cero» de la demo tampoco). Prescindible (se va con las demás cachés si
  el almacenamiento se llena) y con tope de 300 entradas. La tasa de un día
  ya publicado no se vuelve a pedir; la de hoy pedida antes de que el banco
  publique (que es la de ayer) vale 6 horas. Sin poder llegar al servicio se
  usa esa misma entrada o, si no hay, la más reciente del par (`source:
  'last'`), y la interfaz dice de qué día es.
- **CSP**: `connect-src` de `src/renderer/index.html` admite
  `https://api.frankfurter.dev` además de Supabase (es el único sitio donde
  se define; Electron carga el mismo archivo).

**Privacidad.** Lo único que sale del dispositivo hacia el servicio son dos
códigos de moneda y una fecha: ni el importe, ni el comercio, ni la cuenta,
ni cookies, ni la clave de Supabase, ni el referrer. En la moneda principal
no se pide nada. La suite e2e lo comprueba en cada petición que intercepta.
La demo (`npm run demo`) pregunta al mismo servicio de verdad cuando se elige
otra moneda (corre en el navegador del usuario): es lo único que envía a
alguna parte; la lectura con IA de la demo sigue sin salir del navegador.

**La hoja de gasto.** Junto al importe hay un selector nativo con la moneda
del pago: la principal por defecto; después, la última otra moneda usada en
el dispositivo (`data/expenseLast.ts`), el dólar y el resto de la lista. Con
otra moneda aparece debajo un bloque con la **tasa** y el importe **en la
moneda principal**, los dos editables, y una línea que dice de dónde sale la
tasa («Tasa del 13 nov (BCE)», «Guardada con este gasto», «Escrita por ti»,
la tasa guardada de tal día si no hay conexión).

- Escribir la tasa recalcula el importe convertido; escribir el importe
  convertido (lo que cobró el banco) recalcula la tasa. Solo se guarda como
  texto la casilla en la que escribió el usuario; la otra se deriva siempre
  (`fxView` en `lib/expenseFx.ts`), así que no pueden desajustarse.
- Cambiar la fecha o la moneda vuelve a pedir la tasa, **salvo** que el
  usuario haya escrito la suya (se respeta). Vaciar la casilla y salir de
  ella devuelve la tasa del día.
- Mientras se pide: texto («Buscando la tasa…»), sin animación, y nada
  bloquea el teclado.
- Sin tasa (sin conexión y sin ninguna guardada, o un par que el servicio no
  publica), las casillas quedan vacías con una indicación, y guardar muestra
  un error en la casilla: **un importe en dólares nunca se guarda como si
  fuera la moneda principal**.
- Editar un gasto en otra moneda muestra lo guardado y no pide nada hasta
  que cambian la fecha o la moneda. Si entonces no se consigue la tasa nueva,
  se conserva la guardada y la línea lo dice.
- Se guarda `amount` = convertido, con `originalAmount`, `originalCurrency`
  y `fxRate`; un reembolso es negativo en los dos importes. Volver a la
  moneda principal borra el original.
- Cambiar la moneda principal en los ajustes sigue sin convertir nada. Un
  gasto cuyo original está en la que ahora es la principal se muestra y se
  edita por su importe.

**Listas e importes.** Los importes van en la moneda principal, escrita con
su símbolo estrecho (`currencyDisplay: 'narrowSymbol'`: `$` para el dólar
canadiense, `€`, `£`; el código sale junto al título del mes). Un gasto en
otra moneda enseña además lo pagado, pequeño y en tinta neutra, escrito con
el código («USD 12.00», `codeAmount`): un `$` a secas siempre es la moneda
principal. En la tabla va al lado del importe y en el móvil, bajo él; la tasa
está en el `title` y en la hoja.

**La revisión del escaneo.** Así quedó con la 009: la lectura traía un solo
`currency` por imagen y arriba había un selector «Moneda de la imagen». Desde
«La moneda de cada gasto» (abajo) cada fila tiene la suya y ese selector es
«Moneda de todas las filas». El aviso antiguo de «la moneda no coincide»
desaparece: ahora es este flujo.

- Una fila en una moneda distinta de la principal es un gasto en otra
  moneda: se pide la tasa de cada moneda y fecha distintas (la caché lo deja
  en pocas llamadas), cada fila enseña lo leído y lo convertido, y al abrirla
  tiene tasa e importe convertido como la hoja.
- Una fila sin tasa lo dice y **no entra en «Añadir N»** hasta tenerla; un
  campo arriba por moneda, «Tasa para las filas sin tasa», rellena las de esa
  moneda. Si se añaden las que sí la tienen, las demás se quedan en la
  revisión.
- **Duplicados**: misma moneda y mismo importe pagados, o mismo importe en la
  moneda principal (más las reglas de fecha, tarjeta y comercio de antes).
  Así la misma compra leída dos veces se reconoce aunque cada vez tocara una
  tasa distinta. Se vuelven a mirar cuando cambia la moneda de una fila o
  llega una tasa.

### La moneda de cada gasto (noviembre)

Petición del dueño, tal cual: «que la IA pueda reconocer los gastos mejor,
porque en algunas capturas gasta en USD pero la IA lo puso aún así como CAD y
lo tuve que cambiar manualmente». Su moneda principal es CAD; algunas compras
son en USD; escanea capturas de Apple Wallet y recibos. Antes la lectura daba
una sola moneda por imagen (nula para un `$` a secas) y la revisión la
aplicaba a todas las filas, así que una lista de Wallet con compras en CAD y
en USD, o un recibo de EE. UU. con solo «$», acababa en CAD.

**Lo que lee la IA** (`src/shared/expenseExtraction.ts`). Cada gasto trae:

| Campo | Qué es |
|---|---|
| `currency` | código ISO 4217 de `amount`, o nulo |
| `currencyBasis` | `"code"`: la imagen lo muestra para ese importe (un código, una palabra de moneda o un símbolo de una sola moneda: US$, C$, CA$, €, £, MX$); `"place"`: un `$` a secas que el lugar de la compra, tal como sale en la imagen, decide (dirección con estado de EE. UU. o provincia de Canadá, ZIP o código postal, «Sales tax» frente a GST/HST/PST/QST/TPS/TVQ, teléfono, dominio del país); `"none"`: nada lo decide, y `currency` es nulo |
| `chargedAmount`, `chargedCurrency` | cuando la imagen enseña además lo que se cobró a la tarjeta en otra moneda por esa compra (Wallet: «USD 12.00» con «CA$16.95» debajo): ese importe, con el signo de `amount`, y su moneda; si no, los dos nulos. `amount` y `currency` siguen siendo lo pagado |

El `currency` de arriba se queda por compatibilidad: es el que comparten
todas las filas cuando coinciden, y si no, nulo (lo calcula el validador, no
se fía de lo que diga el modelo). El prompt explica las reglas por
transacción: primero las marcas explícitas; un `$` a secas solo por lo que
muestra esta imagen; nunca suponer la moneda del usuario; una lista de
Wallet puede mezclar monedas, así que no se arrastra la moneda de una fila a
otra; nunca inventar ni calcular lo cobrado. Las líneas de seguridad de
antes siguen (el texto de la imagen es contenido, no instrucciones; nada de
números de tarjeta ni enlaces). En el esquema, `currencyBasis` va justo
detrás de `amount` (la prueba antes que el código), y el `currency` de
arriba detrás de la lista; todo objeto cerrado, todo requerido, los nulos con
`anyOf` y sin límites numéricos ni de longitud (lo comprueba el test que
recorre el esquema). El modelo, las betas, el respaldo y `output_config` de
la función no cambian.

**El validador** (`normalizeExtraction`): un código en mayúsculas con su
base `code` o `place`, o nulo con `none` (una base sin código o un código sin
base válida es `none`); lo cobrado necesita número y código, en una moneda
distinta de la de la fila, se redondea al céntimo y lleva el signo de la
fila. **Una respuesta de una función anterior** (ninguna fila trae
`currency` ni `currencyBasis`) se lee como entonces: todas las filas en la
moneda de la imagen, como leída (`code`), o sin moneda si la imagen no la
tenía. **Una app anterior con la función nueva** también funciona: su
validador arma cada fila campo a campo e ignora los cuatro nuevos, y usa el
`currency` de arriba para todas, que solo existe cuando todas coinciden; si
se mezclan, ve una imagen sin moneda y las pone en la principal, como hacía
con un `$` a secas. Lo comprueba `expenseExtraction.compat.test.ts` contra
una copia congelada del módulo tal como estaba
(`src/shared/compat/expenseExtraction-2026-11-18.ts`, con su hash), que ni la
app ni la función importan.

**La revisión** (`lib/expenseReview.ts`, `ScanReview.tsx`). La moneda con
que empieza cada fila (`rowCurrency`): la que la imagen muestra para ella
(`code` o `place`); si no, la del último gasto guardado del mismo comercio
(`merchantMemory`: el más reciente por fecha y alta con el mismo
`normalizeMerchant`, su `originalCurrency` o la principal si no tenía); si
no, la de la imagen; si no, la principal. Una fila en otra moneda es un
gasto en otra moneda, con sus tasas por (moneda, fecha). Cuando lo cobrado
está en la moneda principal, **eso es el importe convertido** (`chargedFx`:
la tasa sale de `rateFrom`) y no se pide tasa; la fila dice «Según lo
cobrado» y, abierta, «Lo que se cobró a la tarjeta, según la imagen». Como
una tasa guardada, se queda tal cual mientras el importe es el leído; si se
cambia el importe, sigue a esa tasa; lo que se escriba en la fila manda.

- Cada fila enseña su moneda cuando no es la principal (lo leído con su
  código bajo lo convertido) y, abierta, tiene un selector «Moneda del
  pago». Cambiarla quita una tasa escrita para la otra moneda y conserva un
  importe en la principal escrito a mano (salvo que la fila pase a la
  principal).
- **«Moneda de todas las filas»** (antes «Moneda de la imagen») pone todas
  en una; mientras difieren dice «Varias».
- **«Moneda supuesta: CAD»**, una nota discreta, en una fila cuya moneda no
  se leyó ni se recordó, solo cuando importa: el usuario tiene gastos en
  otra moneda, la imagen mezcla monedas o la fila trae lo cobrado en otra.
  Una imagen toda en la principal de alguien que nunca paga en otra no dice
  nada. Una fila que sale del comercio dice «USD, como la última vez en este
  comercio».
- Debajo del selector, la línea dice cómo se convierten las filas en otra
  moneda o, si todas están en la principal, que la imagen no dice su moneda
  (todas o algunas filas).

**Desplegar.** Tras actualizar, volver a desplegar la función (el mismo
`functions deploy`, sin tocar los secretos). Hasta entonces la función
anterior sigue funcionando con la app nueva, con una moneda por imagen, y la
memoria del comercio ya se aplica a las filas que esa lectura deja sin
moneda.

**Comprobación con el servicio de verdad.** Las pruebas nunca tocan la red:
la suite e2e intercepta el host en `e2e/harness.ts` (opción `fx`: tasas fijas
como USD→CAD 1,4000, y modos para fallar, no llegar, «par sin tasas» o
tardar). Sin esa opción, **cualquier petición al host hace fallar la prueba**
y, además, el Chromium de la suite no puede resolver ese nombre
(`playwright.config.ts`). Lo que sí habla con el servicio real es
`scripts/check-rates.mjs` (`npm run check:rates`): pide `latest`, un día
laborable pasado y un sábado pasado, lee las respuestas con el **mismo**
`lib/fx.ts` (lo compila con el paquete `typescript`), comprueba
`access-control-allow-origin` enviando un `Origin`, imprime lo recibido y
sale con error si algo no cuadra. Tiene su propio workflow,
`.github/workflows/rates-contract.yml` (a mano, y en los PR que tocan el
módulo de tasas, el script o el propio workflow), **fuera del CI principal**,
que no debe depender de un tercero.

**Qué migraciones tengo.** `supabase/check_migrations.sql` es una consulta de
solo lectura para el editor SQL: lista de la 002 a la 009 con «yes» o «NO».
`run.sh` la prueba tras cada migración.

## Pulido de noviembre

De la misma petición («aparte de mejorar la estética de la app que tú
sugieras y mejoras que sientas que necesite la app»). Cuatro cosas, ninguna
con migración ni cambios en la sincronización.

**Iconos de categoría.** `components/expenses/CategoryIcon.tsx` tiene los
once, uno por clave (`coffee`, `food`, `groceries`, `transport`, `shopping`,
`entertainment`, `health`, `home`, `subscriptions`, `travel`, `other`):
taza, tenedor y cuchillo, carro, coche, bolsa, entrada, cruz de farmacia,
casa, flechas que vuelven, avión y tres puntos. Dibujados para esta app (no
salen de ninguna colección): `viewBox` de 16, trazo de 1,5 con extremos
redondos, sin relleno y con `currentColor`. Reglas:

- Son adorno junto a un nombre que ya está escrito: `aria-hidden` y
  `focusable="false"`. El nombre accesible de cada ficha, fila o casilla
  sigue siendo solo su texto.
- Tinta neutra (`--text-3`; la de la ficha cuando está elegida). Nunca
  verde, rojo ni ámbar: el color es dinero.
- Dónde: las fichas de categoría de la hoja, la columna de categoría de la
  tabla, delante de cada tarjeta de la lista en el móvil (la fila pasa a ser
  una rejilla: icono | dos líneas), el desglose por categoría, la revisión
  del escaneo, las filas de categoría del panel de presupuestos y sus
  casillas en el editor. El total y las tarjetas no llevan icono.
- Una categoría que la app no conoce se dibuja como «Otros», igual que se
  archiva.

**Frente al mes anterior.** Bajo «Gastado en…» hay una línea más:
`vsLastMonth(gastos, mes, hoy)` en `lib/spend.ts`.

- El **mes en curso** se compara **día por día**: los dos meses hasta el
  número de día de hoy (el 31 contra un mes más corto cuenta ese mes hasta su
  último día). Nunca diez días contra un mes entero. Un gasto fechado después
  de hoy está en el total del mes, pero no en lo comparado.
- Un **mes pasado** se compara entero con el anterior. Un mes futuro, nada.
- No sale si el mes anterior **no tiene ningún gasto**.
- Cómo se dice (`comparisonChange`): «12% más que el mes pasado a estas
  alturas», «8% menos que en octubre de 2026», «Lo mismo que…» (solo si
  coincide al céntimo; una diferencia que redondea a 0 es «<1%»). Si el mes
  anterior no llevaba nada neto gastado a esas alturas, o tan poco que el
  porcentaje pasaría de 1000, se dice el importe («$45.00 más…»).
- Una flecha (un SVG, oculta al lector) y las palabras, en la tinta de la
  línea de arriba. **Sin color**: gastar más no es perder. El `title` da la
  cifra con la que se compara («Hasta el 18 oct 2026: $1,204.31»).
- Las sumas van en céntimos enteros, como el resto de `spend.ts`.

**El comercio trae su categoría y su tarjeta.** La hoja ya tenía la lista de
comercios escritos (`merchantSuggestions`: cada uno una vez, el más reciente
primero, 50 como mucho). Ahora, en un **gasto nuevo**:

- `merchantLast(gastos, texto)` da la categoría y la tarjeta del gasto más
  reciente de **exactamente** ese comercio (sin contar mayúsculas ni espacios
  de los extremos; «Uber» no es «Uber Eats»).
- `followMerchant` (en `lib/expenseForm.ts`, pura) las pone en la hoja
  mientras el usuario **no haya elegido** categoría o tarjeta en esa hoja;
  cada una por separado (`free`). Lo que el usuario elige no se toca más.
- Sigue al texto **tal como está**: si se sigue escribiendo y deja de ser un
  comercio conocido, las casillas vuelven a como abrió la hoja (`base`). Así
  el resultado no depende de por dónde se pasó al teclear.
- «Sin tarjeta» se adopta como una tarjeta más. Una tarjeta archivada o que
  este dispositivo no conoce no: se queda la de la hoja.
- Bajo la casilla, una línea dice qué trajo («Como la última vez: Café ·
  Visa»), en una región `aria-live` que está siempre en la página.
- **No** actúa al editar un gasto (sus datos son suyos) ni en una hoja que
  vuelve de «Añadir tarjeta» (se queda con lo que traía).

**Datos de ejemplo de la demo.** La barra de la demo tiene «Cargar datos de
ejemplo» junto a «Empezar de cero». Sirve para ver la app llena antes de
decidir nada: migrar, cambiar la moneda, usar los presupuestos.

- `demo/sample.ts`, `sampleData(ahora, { userId, lang })`: **siempre las
  mismas filas**, con las fechas contadas desde hoy y nada fechado después.
  Las apuestas salen de un generador con semilla (`BET_SEED`); los gastos,
  de dos meses escritos a mano (`THIS_MONTH`, hasta el día de hoy, y
  `LAST_MONTH`, entero).
- Qué trae: 60 apuestas en 58 días (ganadas, perdidas, alguna en «push» y 4
  abiertas; deporte según el día de la semana, casa, tipo, cuota y, en
  muchas, cuota de cierre), banca inicial de 500 y un ingreso de 250; dos
  tarjetas («Visa TD» y «Amex Cobalt»); gastos en **CAD** con comercios de
  Canadá, varios **pagados en USD** con sus tres campos (`original_amount`,
  `original_currency`, `fx_rate` entre 1,38 y 1,41; `amount` es la conversión
  que haría la app, con `convert` de `lib/fx.ts`), un reembolso, filas con
  origen IA y alguna sin tarjeta; y cuatro presupuestos: total, Visa TD,
  suscripciones y ocio.
- **Uno cerca del límite y otro pasado, cualquier día**: las suscripciones
  y las entradas del concierto son del día 1, así que el mes en curso los
  enseña aunque se cargue el día 1 (un test recorre 400 días seguidos).
- Las pocas palabras que no son nombres propios (algunas notas, «Fútbol»)
  salen en el idioma de la interfaz al cargar.
- Los sellos (`created_at`, `updated_at`) nunca son posteriores al momento
  de cargar: una fila sellada en el futuro ganaría todos los conflictos a
  las ediciones del usuario.
- `loadSampleData` llama a `resetDemo` y escribe las tablas del servidor
  falso (`demo:rows`, `demo:moves`, `demo:settings`, `demo:expenses`,
  `demo:expense-cards`, `demo:expense-budgets`); la app recarga y las lee
  del «servidor» como cualquier dispositivo. `bettracker:view` es del
  dispositivo, así que vuelve a la misma vista. Los presupuestos llevan el
  id que la app misma les daría (`budgetId`).
- Reemplaza todo lo que haya. Si la demo ya tiene algo (`demoHasData`: una
  fila en el servidor falso, ajustes cambiados o un cambio en cola en el
  dispositivo), **pregunta antes** con el mismo gesto que «Empezar de cero»
  (segundo clic en 4 s). Vacía, carga al primer clic.
- Cargar no pide ninguna tasa de cambio (las filas ya la traen).
- **Solo en la demo**: `DemoBanner` es lo único que lo importa y solo se
  monta con `MODE === 'demo'`. `e2e/demo.spec.ts` lee todos los scripts del
  build real (también los que se cargan a demanda) y comprueba que no llevan
  ni un comercio del ejemplo ni la semilla de sus ids.

## Tocar una tarjeta o una categoría (noviembre)

Petición del dueño, tal cual: «Quiero que en esta parte de expense, al
presionar una tarjeta que me salga los gastos que usé con esta tarjeta y así
con lo demás. […] Quiero que se mire todo limpio y minimalista». Sin
migración y sin tocar la sincronización.

- **Qué se toca**: cada tarjeta de «Por tarjeta» (también «Sin tarjeta»),
  cada línea de presupuesto de una tarjeta o de una categoría y cada fila de
  «Por categoría». La lista del mes pasa a enseñar **exactamente** eso:
  `drillFilter` (`lib/spend.ts`) pone la tarjeta o la categoría y **quita**
  la búsqueda y el filtro del otro tipo. Tocar otra vez la misma línea no
  quita el filtro (antes, en el desglose, sí): sigue enseñando esos gastos.
  La línea **«Total del mes»** de los presupuestos enseña el mes entero
  (quita los filtros): cada línea enseña lo que cuenta. El «+n más» de «Por
  tarjeta», la leyenda del gráfico y las demás cifras no cambian.
- **La lista viene a la vista**: la tarjeta de la lista sube hasta arriba de
  la ventana con un desplazamiento suave (al instante con «reducir
  movimiento») y su título (`tabIndex=-1`) se lleva el foco, así que el
  teclado y el lector de pantalla siguen ahí. Nada fijo tapa arriba; en el
  iPhone la página corre bajo la barra de estado, así que el margen es
  `12px + env(safe-area-inset-top)` (`scroll-margin-top`). Si la página es
  demasiado corta para subirla del todo, llega hasta el final.
- **El filtro se ve y se quita fácil**: sobre las filas, una línea discreta
  con una ficha por tarjeta y por categoría («Promerica ×»: tocarla quita ese
  filtro), cuántos gastos y cuánto suman en el mes («12 gastos · $561.63»,
  `listSummary`, en céntimos) y **«Ver todo»**. Sale con cualquier filtro,
  también con solo la búsqueda, y sustituye a «Quitar filtros», que estaba
  junto a las casillas. Las casillas siguen diciendo lo mismo que la ficha.
  El título lleva el resumen para el lector de pantalla («…, filtrados por
  Promerica: 12 gastos, $561.63»). Al quitar una ficha el foco pasa a «Ver
  todo», o al título si ya no queda filtro.
- **Aspecto**: las líneas son las de antes. El nombre es un `<button>` sin
  aspecto de botón, y su `::after` cubre la línea entera (`.drill-row` en
  `index.css`): se toca en cualquier punto, mientras las cifras siguen siendo
  texto y la barra de un presupuesto sigue siendo una barra de progreso para
  el lector de pantalla. Un tono al pasar el ratón (solo con ratón), otro
  algo más firme al pulsar (`--dur-press`, sin escala) y en la línea que la
  lista enseña (`aria-current`), y el anillo neutro del foco alrededor de la
  línea. Nombre accesible: «Ver los gastos de Promerica», «Ver los gastos
  sin tarjeta», «Ver los gastos de Supermercado», «Total del mes: ver todos
  los gastos». En el móvil cada tarjeta de «Por tarjeta» mide 44 px y las
  fichas y «Ver todo» se tocan en 44 px. Sin color: el color es dinero.
- **El gráfico**: un día que aún no ha llegado y no tiene nada no tiene
  tooltip ni cursor, en las dos vistas (`chartDayHasTip`; un día pasado sin
  gasto sigue diciendo $0.00, y un gasto fechado por adelantado tiene el
  suyo en «Por día»). En «Acumulado» los días que faltan se añaden como días
  vacíos (`wholeMonthPoints`), para que el puntero caiga en su día y no se
  pegue al último real; el área sigue parando hoy. **La línea blanca** de la
  captura del dueño era el cursor del tooltip: un `ComposedChart` de
  Recharts siempre dibuja una línea como cursor, con su trazo por defecto
  `#ccc`, y el `fill` que pedía la vista «Por día» no hacía nada. Ahora el
  cursor lo dibuja la app: una franja tenue en el día (`--tint-2`) o una
  línea fina (`--grid-strong`). **La columna que se desvanece** sobre la
  barra más alta no era un artefacto: era el tramo de arriba de esa barra
  apilada (la segunda tarjeta), que en la captura queda bajo la barra de
  estado del iPhone, y el sistema la difumina igual que la etiqueta «$400».
  De paso salió otro artefacto al tocar: Recharts mete cada capa del
  gráfico en un `<g tabindex="-1">` y hace enfocable el dibujo (para sus
  flechas), así que un toque o un clic enfocaba uno y el navegador le ponía
  su anillo (un rectángulo alrededor de las barras o del gráfico). Ahora solo
  el teclado deja anillo, el neutro de la app; vale también para el gráfico
  de apuestas.

## Pulido 2.0 (noviembre 2026)

Del «master prompt» de BetTracker 2.0 del dueño (mejorar lo que hay sin
rediseñar; menos es más; la exactitud financiera antes que la analítica
decorativa; el panel de presupuestos sin presupuestos no puede ser un hueco)
y de dos auditorías de solo lectura. Sin migración y sin tocar la
sincronización. Lo que cambió en Gastos:

### Cálculos

- **Media diaria y proyección** (`pace` en `lib/spend.ts`). Antes la media
  dividía el total del mes, con lo fechado después de hoy dentro: un alquiler
  del 30 apuntado el día 2 triplicaba la media de dos días y la proyección lo
  contaba quince veces. Ahora la media es el neto de las filas fechadas
  **hasta hoy** (fecha local) entre el número de día de hoy, y la proyección
  es esa media por los días del mes **más el neto de lo fechado después de
  hoy** (ya está comprometido, vaya al ritmo que vaya). Ejemplo: el 2 de
  noviembre, $40 el día 1 y $1.500 el día 30 → media $20.00, proyección
  $2,100.00 (antes: media $770.00 y proyección $23,100.00). Un mes pasado: la
  media sobre todos sus días, sin proyección (el mes ya es lo que fue). Un mes
  futuro: nada. Todo en céntimos enteros. `pace` recibe las filas, no el
  total, y el reductor «hasta el día n» (`netThroughDay`) es el mismo que usa
  la comparación con el mes anterior. `Pace` trae además `counted`, el neto
  del que sale la media, para el `title` de la ficha.
- **Nada es cero antes de cargar.** Hasta que los gastos han cargado en el
  dispositivo (o si está sin conexión y nunca cargaron) la franja enseñaba
  $0.00 como si fuera real. Ahora lo gastado, el presupuesto restante y la
  media son «—», igual que «Por tarjeta», el panel de presupuestos y las
  categorías. El porqué se dice una vez en la franja (bajo el total), en el
  hueco del gráfico y en la lista («Cargando tus gastos…» o «Tus gastos se
  cargan cuando este dispositivo tenga conexión», la frase que ya usaba la
  lista), no en cada ficha: siete veces la misma frase era ruido. Un cero
  solo aparece cuando es un cero de verdad.
- **Las categorías suman 100 %.** El denominador de «Por categoría» era lo
  gastado en positivo (`month.spent`), así que con un reembolso parcial las
  cuotas no sumaban 100. Ahora es la suma de los netos positivos de las
  categorías: comida 30, compras 100 y −20 → comida 27 %, compras 73 %. Una
  categoría que solo devolvió dinero es 0 %.
- **El presupuesto de una tarjeta archivada** no se lista (`budgetLines`):
  la tarjeta ya no está en el editor. Vuelve si se restaura la tarjeta.
- **Importes compactos**: `lib/currency.ts` añade el tramo M («$1.5M») a
  `compact` y `axis`, para pesos y ejes que lleguen al millón.

### Interfaz

- **Presupuestos**: cada línea son dos renglones, el nombre y «$338.81 de
  $400.00 · Quedan $61.19» (o «· $12.00 de más»), con la barra debajo; el
  ámbar y el rojo de la barra y de las palabras siguen, y el nivel se dice
  siempre con palabras (también para el lector de pantalla). Sin
  presupuestos, una sola línea («Sin presupuesto») y el botón fantasma de la
  cabecera dice «Ponerlo» (abre los Ajustes de gastos en los presupuestos);
  la tarjeta mide lo que su línea (`align-self: start`), no lo que el
  gráfico de al lado. Cargando, la línea de carga.
- **La media diaria dice cómo se hace**: «19 días · a este ritmo, $1,685.40»
  en el mes en curso y «En 31 días» en un mes pasado; el `title` lleva la
  cifra de la que sale («Hasta el 19 nov 2026: $1,061.80»), como la línea
  del mes anterior. La proyección vive solo en esa línea: lo gastado es
  siempre lo gastado.
- **«+n más»** de «Por tarjeta» es un botón: enseña todas las tarjetas, de
  mayor a menor (44 px en el móvil).
- **Teléfono (≤ 640 px)**: la franja va en dos columnas: lo gastado a lo
  ancho, Presupuesto restante y Media diaria lado a lado, Por tarjeta a lo
  ancho. Solo CSS (`order`); el DOM y el teclado no cambian. A 320 y 390 px
  nada desborda y las cifras caben en una línea (20 px en las dos mitades).
- **Las cuatro cifras comparten línea base**: cada valor va bajo su
  etiqueta y la línea de abajo se empuja al fondo (`margin-top: auto`).
- **Gráfico**: el acumulado se dibuja con segmentos rectos (`linear`, no
  `monotone`): la curva se doblaba antes del día del gasto y parecía dinero
  gastado la víspera. Las barras por día no cambian. Margen derecho de 24 px
  para que la última fecha del eje no se corte.
- **Mes vacío** que no es el primer uso: «Por categoría» es una línea, no un
  hueco de 160 px; los presupuestos, como arriba; el gráfico conserva su
  estado vacío (da la altura de la fila).

### Código

- `cardInk(cards)` en `lib/spend.ts` es la única fuente de la tinta de cada
  tarjeta (gráfico, leyenda y «Por tarjeta»); desaparece
  `components/expenses/inks.ts`.
- `monthOrder(ym, hoy)` en `lib/dates.ts`: mes en curso 0, pasado < 0,
  futuro > 0; lo usan `pace`, `vsLastMonth` y `spendChartData`.
- `cardBudget(budgets, cardId)`: la búsqueda del presupuesto de una tarjeta
  (sin distinguir mayúsculas en el id), en `budgetLines`, el editor y
  `App.tsx` al borrar una tarjeta.
- `cardLines(month, cards)` y `TOP_CARDS`: la selección de líneas de «Por
  tarjeta» (las tarjetas activas más las claves que movieron dinero, de
  mayor a menor), probada aparte.
- `levelClass(level)`: la clase de la barra (`over` / `near` / `ink`),
  compartida por la franja y el panel.
- `App.tsx` calcula `monthSpend` una vez (`useMemo`) y se lo pasa a la vista
  y a los Ajustes de gastos, que antes lo recalculaban en cada render.

### Pruebas

- Unitarias: `spend.test.ts` (`pace` con filas: el 2 de noviembre, un
  reembolso fechado por delante, un mes pasado, uno futuro, céntimos;
  `monthOrder`; `categoryShares` con el reembolso parcial; `budgetLines` con
  la tarjeta archivada; `cardBudget`, `cardLines`, `cardInk`, `levelClass`) y
  `currency.test.ts` (el tramo M). **Expectativas que cambiaron**: `pace`
  recibe filas en vez del total, y las dos cuotas de `categoryShares` son de
  50 (los netos positivos), no de 55 (lo gastado).
- e2e: `e2e/expenses-summary.spec.ts` (8): la media y la proyección en el mes
  en curso, en uno pasado y en uno futuro, en en y es, con la cifra del
  `title`; sin conexión sin haber cargado (ni un «$» en la vista); la primera
  carga («—», la frase una vez en la franja, y la tarjeta de primeros pasos
  al terminar vacía);
  «+n más» en el ordenador y a 390 px en español; sin presupuestos y
  «Ponerlo», luego las dos líneas de un presupuesto cerca y pasado; la franja
  en dos columnas a 390 y 320 px, sin nada de lado y cada cifra en su línea.
  Ninguna e2e anterior cambió.

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

**Flujo.** En la hoja de gasto (el **+**), con su «Escanear recibo», se
elige, pega o suelta una imagen. El cliente la decodifica
(`createImageBitmap`; HEIC solo donde el navegador sepa), la reduce a 1600 px
en el lado largo y la vuelve a codificar como JPEG (≤ ~1,5 MB en base64; eso
quita la ubicación y los datos de la cámara). Llama a la Edge Function
`extract-expenses` con `supabase.functions.invoke` (la app espera hasta 115
s). La respuesta se **revisa**: cada fila se puede editar o desmarcar; la
tarjeta se reconoce en el cliente por los 4 últimos dígitos o el nombre que
la imagen muestra (`lib/cardMatch.ts`); una fila que parece un gasto ya
guardado (misma fecha, importe y tarjeta, comercio parecido) sale
desmarcada junto a ese gasto; las filas dudosas o sin fecha salen abiertas;
cada fila tiene su moneda, la que la imagen muestra para ella o la que se
supone, y si no es la principal se convierte (ver «La moneda de cada
gasto»). «Añadir N gastos» encola
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
captura de Wallet de 739×1600, unos 1.600) más ~2.000 de instrucciones y
esquema (eran ~1.500 antes de la moneda de cada gasto), unos 0,018 $; la
salida con el razonamiento a esfuerzo medio, 1.000 a 5.000 tokens (cada fila
lleva también su moneda), 0,02 a 0,10 $. En total, **unos 3 a 12 céntimos de
dólar por escaneo**. Si Claude rechaza una imagen y responde el modelo de respaldo, ese
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
  category, note, source, original_amount, original_currency, fx_rate`; BOM,
  CRLF y guardas de fórmula) sale de la lista de la vista; el diálogo de
  importar y exportar lo menciona. Las tres últimas columnas llegaron con la
  009 y van al final para que una hoja hecha sobre las nueve primeras siga
  valiendo; están vacías en un gasto en la moneda principal.

## Decisiones (y por qué)

Las de producto y arquitectura se tomaron antes de empezar y no se
reabrieron; las que más pesan:

- **Capa genérica nueva, `useMoves` intacto**: menos código que tres copias
  y ningún riesgo para lo que ya funciona.
- **`card_id` sin clave foránea**: tarjetas y gastos van por colas distintas;
  un gasto puede llegar antes que su tarjeta.
- **Ids deterministas de presupuesto**: un presupuesto por ámbito y destino
  aunque dos dispositivos lo creen a la vez.
- **Moneda solo de los gastos**, activable solo con prueba de la 008.
  Cambiarla no convierte lo guardado; lo que se convierte es un gasto pagado
  en otra moneda, al añadirlo (009).
- **`amount` siempre en la moneda principal** y el original aparte, en tres
  columnas opcionales: ningún total, presupuesto ni gráfico tuvo que cambiar,
  y las filas y las apps de antes siguen valiendo.
- **La base no exige que `amount` sea original × tasa**: el importe es lo
  que el usuario dice que le cobraron.
- **Tasas del BCE por Frankfurter**: gratis, sin clave y con CORS abierto,
  así que la app pregunta directamente y no hace falta otra Edge Function ni
  otro secreto. A cambio no hay tasas de todas las monedas: donde no hay, se
  escribe a mano.
- **Sin tasa no se guarda**: mejor una casilla vacía que un importe en otra
  moneda contado como si fuera la principal.
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
  `validate`, `supabaseEnv`, `timeoutFetch`, `demo` y `fakeSupabase`. Con las
  otras monedas: `fx` (URL, lectura de la respuesta, conversión, caché; con
  una guarda de que el módulo no importa nada), `fxRates` (con un `fetch` de
  mentira: caché, sin conexión, 4xx, plazo, cancelación, nunca lanza),
  `expenseFx` (las dos casillas y lo que se guarda), y los casos nuevos de
  `validate`, `rowTable`, `rowStorage`, `errors`, `fakeSupabase`, `backup`,
  `expenseCsv`, `currency`, `expenseForm`, `expenseReview`, `expenseLast`,
  `useRowSync` y `store`. Con el pulido: `spend` (`vsLastMonth`,
  `comparisonChange`, `merchantLast`), `expenseForm` (`followMerchant`),
  `demo` (`demoHasData`) y `sample` (las filas del ejemplo pasan por
  `normalizeInput`, `normalizeExpense`, `normalizeCard` y `normalizeBudget`
  sin cambiar; ids únicos; nada en el futuro; presupuestos cerca y pasado
  los 400 días que recorre). Con la moneda de cada gasto:
  `expenseExtraction` (el esquema: los nulos con `anyOf`, nunca una lista de
  tipos, la base como enum, el orden de los campos; el prompt nombra cada
  campo y dice sus reglas; el validador fila a fila, lo cobrado, la moneda
  de arriba, una respuesta de una función anterior y que leer dos veces da
  lo mismo), `expenseExtraction.compat` (la app anterior con la función
  nueva), `expenseFx` (`chargedFx`, lo cobrado en `fxView`) y
  `expenseReview` (`merchantMemory`, `rowCurrency`, filas con lo cobrado,
  tasas por moneda y fecha, «Moneda supuesta» solo donde importa, cambiar la
  moneda de una fila o de todas). Con «Tocar una tarjeta o una categoría»:
  `spend` (`drillFilter`, `listSummary`, `wholeMonthPoints`,
  `chartDayHasTip` y la línea que enseña cada presupuesto). Con el pulido
  2.0: `spend` (`pace` con filas, `monthOrder`, `categoryShares` que suma
  100 %, `budgetLines` sin tarjetas archivadas, `cardBudget`, `cardLines`,
  `cardInk`, `levelClass`) y `currency` (el tramo M).
- **SQL**: `checks.sql` secciones 11 (008) y 12 (009) en las variantes A, B y
  C de `run.sh`, que además prueba `check_migrations.sql` tras cada
  migración.
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
  moneda; la moneda solo se ofrece con la 008 probada). Con las otras
  monedas, `expenses-fx.spec.ts` (7: un gasto en USD con CAD de principal, de
  la hoja al servidor, la lista y el CSV, y su edición sin pedir nada; sin
  tasa no se guarda, y sin conexión convierte la última tasa guardada; un
  servicio lento no bloquea nada; antes de la 009; la revisión en USD con
  duplicado por lo pagado; la revisión sin tasas y la tasa para todas; la
  hoja y la revisión a 320 px en español). El servicio de tasas lo contesta
  el harness, y una petición a él que una prueba no haya pedido la hace
  fallar. Con el pulido, tres más en `expenses.spec.ts` (cada categoría con
  su icono donde se nombra, oculto al lector y en tinta neutra, también en
  el móvil; la comparación con el mes anterior, sin color, en es y en, y
  ausente sin mes anterior; el comercio que trae categoría y tarjeta, lo que
  el usuario elige y la edición, que no cambia) y cuatro en `demo.spec.ts`
  (cargar el ejemplo en una demo vacía y volver a la misma vista, con sus
  presupuestos, sus USD y sus apuestas; preguntar antes si hay datos; en
  español; y que los scripts del build real no llevan el ejemplo). Con la
  moneda de cada gasto, `expenses-currency.spec.ts` (5: una lista de Wallet
  con filas en CAD y en USD, solo las USD convertidas y pedidas; un `$` a
  secas en un comercio pagado antes en USD, y otro sin historial marcado
  «Moneda supuesta» en tinta neutra; lo cobrado en CAD como importe, sin
  pedir ninguna tasa; cambiar la moneda de una fila; «Moneda de todas las
  filas» a EUR y de vuelta a CAD). Las pruebas de escaneo de antes no
  cambian: la lectura de mentira contesta como una función anterior (sin
  moneda por fila), así que también prueban esa compatibilidad. Con «Tocar
  una tarjeta o una categoría», `expenses-drill.spec.ts` (5: cada tipo de
  línea enseña solo sus gastos, con la ficha, las casillas y el resumen de
  acuerdo, la lista arriba y el foco en su título, y «Ver todo» y la × lo
  deshacen; Intro y Espacio, y al instante con «reducir movimiento»; en
  español a 390 px con 44 px para el dedo; y el gráfico, con la fecha fija,
  sin tooltip ni cursor en un día que no ha llegado, con el ratón y con el
  dedo, sin anillo tras un toque y con el del teclado). Con el pulido 2.0,
  `expenses-summary.spec.ts` (8; ver «Pulido 2.0»).
- **La función**: `deno check` (Deno 2.9.6) pasó en la etapa 2 contra los
  tipos reales del SDK y de supabase-js, y otra vez con la moneda de cada
  gasto. Nunca se ha llamado a Anthropic ni a un proyecto de Supabase real:
  el prompt nuevo solo está comprobado por los tests y leyéndolo.

## Despliegue

En el README, «AI reading of receipts (optional)», y en `HANDOFF.md`, «Qué
hay que hacer a mano». Orden: (1) la 008 y la 009 en el editor SQL, después de la 007;
(2) la función y sus secretos con la CLI (`npx supabase@3.2.0`, desde la
raíz del repositorio, con `--env-file` y `--no-verify-jwt`;
`supabase/config.toml` guarda `verify_jwt = false`); (3) la app. En otro
orden no se pierde nada. La función importa su propia copia del módulo
compartido, `supabase/functions/_shared/expenseExtraction.ts`, para que todo
lo que se despliega esté bajo `supabase/functions`: es idéntica byte a byte a
`src/shared/expenseExtraction.ts`, la escribe `npm run sync:function` y un
test falla mientras difieran.

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
- **El servicio de tasas, en vivo**: desde aquí no se puede llegar a
  `api.frankfurter.dev`, así que su contrato solo está comprobado contra lo
  documentado. Ejecutar `npm run check:rates` (o el workflow «Rates
  contract») desde una máquina con internet antes de darlo por bueno, y la
  009 en el proyecto real.
- **Monedas sin tasa publicada** (COP, ARS, CLP, PEN…): hoy se escribe la
  tasa o el importe a mano. Otra fuente de tasas sería otra decisión (clave,
  coste, privacidad).
- **Gastos guardados antes sin convertir**: un cargo en USD apuntado como si
  fuera CAD sigue como estaba; se corrige editándolo (elegir USD y guardar).
  La revisión del escaneo no lo marca como duplicado de la misma compra
  leída ahora en USD, porque es otro importe en otra moneda.
