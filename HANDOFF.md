# BetTracker · Handoff

Estado a fecha 2026-10-11. Este repositorio contiene solo BetTracker: su
código, sus migraciones, sus tests y su CI. El CI corre aquí desde 2084828
(antes, en el repositorio de origen) y todo PR tiene que pasarlo entero:
typecheck, tests unitarios, build, esquema SQL y la suite e2e.

## Origen

Hasta el 2026-10-09 BetTracker vivía en la carpeta `bettracker/` del
repositorio `Vict0rL1/s`. Se movió aquí con todo su historial: los mismos
commits, mensajes, fechas y autores, con el contenido idéntico al de la rama
`claude/bettracker-deleted-knaa6m` de `s`. Al pasar de la carpeta a la raíz
cambian los identificadores de los commits; los originales siguen en `s`, y
la conversación de revisión sigue en el PR #10 de `s`, ya cerrado.

## Reglas del proyecto

Las fijó el dueño del proyecto y siguen vigentes:

- Sin acceso a Supabase desde el código de trabajo. Cada cambio de esquema
  va en una migración nueva (`supabase/migrations/005_…`, `006_…`) y
  `supabase/schema.sql` se actualiza a la par, siempre re-ejecutable. Las
  migraciones las corre el dueño. Nunca pedir la clave `service_role`.
- Migraciones solo aditivas. Las filas antiguas, las cachés offline antiguas
  (`hydrateBet`) y los CSV exportados antes deben seguir funcionando.
- Mantener intacto el modo offline (escrituras optimistas, outbox,
  reconcile) y añadir tests para cada rama nueva de esa lógica.
- Semántica que no cambia: `amount` es el resultado neto, no el pago, y un
  `stake` nulo significa "no registrado".
- Cada feature funciona offline vía outbox, tiene sus textos en en y es,
  tests unitarios y al menos una comprobación e2e. Los ajustes por usuario
  viven en la tabla `user_settings` y se cachean offline.
- Preguntar antes de: quitar Electron, cerrar o fusionar cualquier PR, o
  cualquier cambio que pueda perder datos.
- Tras cada bloque de trabajo: `npm test`, `npm run build` y la suite e2e en
  verde, commit con mensaje claro y un informe corto (qué cambió, cómo se
  probó, dudas).

## Qué hay que hacer a mano

Antes que nada, **las reglas de `main` en GitHub** (Settings → Rules →
Rulesets): exigen los checks `check`, `e2e (celular)`, `e2e (celular-pequeno)`,
`e2e (escritorio)` y `deploy-preview / Cloudflare Pages`, que son de otro
proyecto; el CI de este repositorio no los produce, así que ningún PR puede
fusionarse. Hay que cambiarlos por los de este CI: `Secretos`,
`Tests y build`, `Esquema SQL` y `e2e con Playwright`.

Luego, por este orden (ver "Orden de despliegue seguro" justo debajo):

1. **Migraciones en Supabase**, en el SQL editor del proyecto:
   `supabase/migrations/002_stake_and_tags.sql` → `003_odds_and_status.sql`
   → `004_user_settings_and_closing_odds.sql` → `005_bankroll_moves.sql`
   (la 005, ingresos y retiradas, no depende de la 004: pueden ir en
   cualquier orden) → `006_lost_free_bets.sql` (después de la 003: solo
   sustituye su trigger para que una apuesta gratis perdida, stake 0 y
   resultado 0, siga perdida al editarla; sin ella todo funciona, pero esa
   edición la convierte en push) → `007_deleted_rows.sql` (después de la
   005: una fila borrada ya no vuelve cuando otro dispositivo reenvía un alta
   cuya respuesta se perdió; sin ella todo funciona, pero ese reintento la
   resucita) → `008_expenses.sql` (después de la 007 y la 004, y se para con
   un mensaje si falta alguna: las tablas de gastos, tarjetas y presupuestos
   mensuales y la moneda de los gastos en `user_settings`; sin ella las
   apuestas funcionan igual, y la vista Gastos avisa y guarda lo que se añada
   en el dispositivo) → `009_expense_original_currency.sql` (después de la
   008, y se para con un mensaje si falta: tres columnas en `expenses` para un
   gasto pagado en otra moneda, lo pagado, su moneda y la tasa; sin ella todo
   se ve y los presupuestos y la moneda funcionan, pero cada gasto que se
   añada o edite espera en el dispositivo como «Falta actualizar», y la vista
   Gastos dice qué archivo falta). Todas son aditivas y re-ejecutables (`if
   not exists`, `drop … if exists` antes de cada constraint, policy y
   trigger). `supabase/schema.sql` contiene lo mismo acumulado por si
   prefieres ejecutar un solo archivo. La 001 ya estaba aplicada antes de
   este trabajo. **Para saber cuáles faltan**: pegar
   `supabase/check_migrations.sql` en el editor SQL; solo lee, y lista de la
   002 a la 009 con «yes» o «NO».
2. **Lectura con IA (opcional)**, después de la 008 y la 009 y antes de
   publicar la app. Es la Edge Function `extract-expenses`; se despliega con la CLI de
   Supabase desde la raíz del repositorio (importa
   `src/shared/expenseExtraction.ts`, así que el editor del panel no sirve).
   Pasos, coste y privacidad en el README, «AI reading of receipts
   (optional)»; en corto:

   ```bash
   npx supabase@3.2.0 login
   # supabase/functions/.env (ignorado por git), con:
   #   ANTHROPIC_API_KEY=<clave de un workspace de Anthropic solo para esto, con límite de gasto mensual>
   #   EXTRACT_ALLOWED_USERS=<tu id de usuario de Supabase>
   npx supabase@3.2.0 secrets set --remote=<ref> --env-file supabase/functions/.env
   rm supabase/functions/.env
   npx supabase@3.2.0 functions deploy extract-expenses --remote=<ref> --no-verify-jwt
   ```

   `EXTRACT_ALLOWED_USERS` es la lista de quién puede escanear (ids, o
   correos confirmados, separados por comas). Sin ella nadie puede; `*` deja
   a cualquier usuario con sesión, y nunca debe usarse con el registro
   abierto (Authentication → Sign In / Providers → «Allow new users to sign
   up»). La clave va solo en los secretos de la función: nunca en `.env` ni
   en una variable `VITE_` (el build se para si la ve). El límite de gasto
   del workspace es el único tope duro. Sin desplegar la función, escanear
   dice que la lectura con IA no está configurada y escribir el gasto a mano
   funciona. La CLI 3.2.0 acepta `supabase/config.toml` (comprobado en la
   etapa 2) y los parámetros de arriba (etapa 4); no se ha desplegado nada.
3. **Despliegue**, después de las migraciones. Si la PWA está en Vercel, en
   el proyecto que ya existe: Settings → Git, conectar este repositorio y
   poner el directorio raíz en `/`. Así se conservan el dominio y las
   variables. Un dominio nuevo dejaría la app instalada en el móvil apuntando
   al viejo, con lo guardado sin conexión allí, y obligaría a cambiar las URL
   de redirección en Supabase Auth. En Supabase, Authentication → URL
   Configuration: **Site URL** = la dirección de la app publicada, y en
   **Redirect URLs** las demás desde las que te registres
   (`http://localhost:5173`); si no, el correo de confirmación lleva a
   `http://localhost:3000` (la cuenta queda confirmada igual). La misma
   regla vale para el enlace de **¿Olvidaste la contraseña?**: comprobar
   en Supabase que la dirección publicada está en Site URL o en Redirect
   URLs y que la plantilla **Reset Password** (Authentication → Emails)
   está activa. El correo integrado de Supabase envía muy pocos mensajes
   por hora: para uso real, configurar SMTP. Nada de esto se ha probado
   contra el proyecto real (no hay acceso desde aquí y no se enviaron
   correos): está pendiente una prueba en vivo. Si está en
   Netlify subida a mano (Netlify Drop): `npm run build` con el `.env` bueno
   y arrastrar `dist/` a
   la página **Deploys** del sitio que ya existe; soltarlo en la lista de
   sitios crea otro, con otra dirección. El build comprueba antes la URL y
   la clave (ver "Decisiones"). El instalador de escritorio se construye
   con `npm run build:desktop`.
4. **Actualizar cada dispositivo**: la PWA se actualiza sola al abrirla con
   conexión (una recarga basta); el escritorio hay que reinstalarlo.
5. **Revisar la feature 4** (unidades y bankroll, su propio PR) y las
   preguntas que deja abiertas: ver "Feature 4 · preguntas abiertas"
   abajo.

### Orden de despliegue seguro

- **Migrar antes de desplegar.** La versión desplegada hoy no conoce
  `status` y la 003 lo hace obligatorio. Para que siga funcionando, la 003
  crea un trigger (`entries_status_from_amount`): a un alta sin `status` le
  pone el que implica su importe (la misma regla del backfill), y a una
  edición que cambia el importe sin tocar un `status` que ya no encaja se lo
  recalcula. Lo que envía la versión nueva siempre encaja (valida el signo
  del importe ya redondeado a céntimos, como se guarda), así que no lo toca.
  Así, entre las migraciones y el despliegue, los dispositivos con la
  versión antigua siguen guardando sin perder nada.
- **Si se invierte el orden, tampoco se pierde nada.** La versión nueva
  contra una base sin migrar no puede dar altas ni editar (cada alta o
  edición lleva `closing_odds`, de la 004; los borrados sí pasan), pero ya
  no tira esas operaciones: las deja en la cola del dispositivo, como sin
  conexión, con la insignia "Falta actualizar · n en cola" y un aviso (una
  vez por cola, la de apuestas y la de ajustes, no en cada reintento), y
  las envía solas en cuanto corren las
  migraciones (reintenta cada 20 s, al volver la conexión y al volver a la
  app). Un ajuste cambiado entretanto espera igual: el diálogo de ajustes lo
  dice y la insignia muestra "Falta actualizar". Mientras tanto, no cerrar
  sesión en ese dispositivo: cerrar sesión borra su cola.
- **La 005 tampoco es necesaria para arrancar.** Sin ella, leer los
  ingresos y retiradas encuentra la tabla ausente y no es un error: el
  servidor no tiene ninguno todavía (el bankroll cuenta solo el inicial y
  las apuestas resueltas), no sale aviso, y la app vuelve a leer cada 20 s
  para notar la migración. Un ingreso o una retirada hechos entretanto se
  quedan en su propia cola ("Falta actualizar · n en cola", aviso una vez)
  sin frenar la de apuestas, y se envían en cuanto corre la 005. Cerrar
  sesión con cambios en cola pide un segundo clic, porque los borra del
  dispositivo.
- **Lo que un dispositivo tenga en cola al actualizarse se envía igual que
  lo habría enviado la versión antigua.** Esa versión guardaba las ediciones
  sin hora de edición y solo con los campos que conocía. Al cargar esa cola,
  la versión nueva las marca `legacy`, les pone la hora de carga (ella
  sellaba al sincronizar) y las envía solo con esos campos y sin `status`
  (`updateBetLegacy`): no borra cuotas, cuota de cierre ni nada que esa
  versión no conocía, y el trigger de la 003 calcula el estado como para
  cualquier escritura suya.
- **Mientras convivan versiones**, una versión antigua ve una apuesta
  pendiente (creada desde la nueva) como $0. Si la edita escribiendo un
  importe distinto de 0, queda resuelta con ese importe; si deja el $0 (por
  ejemplo, solo cambia la nota), sigue pendiente, así que un push de una
  pendiente solo se puede registrar desde una versión actualizada. Por eso,
  actualizar todos los dispositivos pronto.
- **La 007 tampoco hace falta para arrancar, y conviene aplicarla antes.**
  Sin ella la app nueva funciona igual (Deshacer de una importación o
  restauración ya borra solo lo que escribió, comprobando el sello en el
  mismo `delete`), pero un reintento de un alta cuya respuesta se perdió
  puede devolver una fila borrada en otro dispositivo. La 007 crea
  `public.deleted_rows` (sin políticas: ningún cliente la lee ni la
  escribe), un trigger `after delete` que guarda el último `updated_at` de
  cada fila borrada y un trigger `before insert` que deja pasar en silencio
  (sin fila, sin error) un alta de ese id que no sea más nueva. Un Deshacer
  de un borrado sella su alta justo después (`readdStamp`) y entra. Las
  versiones antiguas no envían `updated_at` en el alta: reciben `now()` y
  entran como antes. Borrar una cuenta borra también sus registros.
  Reversión, si hiciera falta: `drop trigger entries_skip_deleted on
  public.entries; drop trigger bankroll_moves_skip_deleted on
  public.bankroll_moves;` (y los dos `*_remember_deleted`); la tabla puede
  quedarse o borrarse después, no la usa nada más.
- **La 008 tampoco hace falta para arrancar.** Sin ella, leer gastos,
  tarjetas o presupuestos encuentra la tabla ausente y no es un error (no sale
  aviso; la vista Gastos muestra un aviso fijo que dice que falta la 008); lo
  que se añada espera en su cola con «Falta actualizar · n en cola» y un solo
  aviso para las tres tablas, y se envía en cuanto corre la 008. Los
  presupuestos y la moneda se quedan desactivados hasta que una lectura o una
  escritura de esas tablas funcione en esa sesión (prueba positiva: sin
  conexión no se sabe y tampoco se activan), porque una moneda enviada a una
  base sin la columna frenaría el resto de ajustes. Una restauración tampoco
  toca la moneda sin esa prueba.
- **La 009 tampoco hace falta para arrancar.** Con la 008 y sin la 009, leer
  gastos, tarjetas y presupuestos funciona, y los presupuestos y la moneda se
  pueden cambiar. Lo que espera son las altas y ediciones de gastos: todas
  envían las tres columnas de la 009 (nulas si el gasto está en la moneda
  principal), como toda apuesta envía `closing_odds`, y la base las rechaza
  con PGRST204. Se quedan en la cola («Falta actualizar · n en cola», un
  aviso, no uno por reintento; la vista Gastos muestra un aviso fijo con el
  nombre del archivo) y se envían solas en cuanto corre la 009. Nunca se
  rechazan ni se pierden. Los borrados de gastos sí pasan.
- Las comprobaciones de esto contra un Postgres real están en
  `supabase/tests/` (ver "Cómo probar").

## Cómo probar

Para verla sin Supabase ni `.env`: `npm run demo` (http://localhost:5172).
Entra ya con sesión y sin datos, contra un backend falso que guarda todo en
el navegador; funciona igual que contra Supabase, sin conexión incluido.
Una barra arriba dice que es la demo, con "Empezar de cero" (doble clic).
Tras cerrar sesión, cualquier email y una contraseña de 6 caracteres o más
vuelven a entrar. En el móvil, por la URL `Network`, también funciona.

```bash
npm ci
npm test            # 1531 tests unitarios en 58 archivos (vitest)
npm run typecheck   # web + escritorio + e2e
npm run build       # PWA en dist/
npm run test:e2e    # 260 comprobaciones Playwright, sin backend (puertos 4183, 4182 y 4181)
bash supabase/tests/run.sh   # migraciones y schema.sql contra un Postgres real
npm run check:rates # el servicio de tasas de cambio DE VERDAD (necesita internet; no está en el CI principal)
# La Edge Function de la lectura con IA (opcional; npx descarga Deno):
npx --yes deno@2.9.6 check --config supabase/functions/extract-expenses/deno.json supabase/functions/extract-expenses/index.ts
```

El `deno check` de la función se ejecutó en la etapa 2 de los gastos y pasó
(Deno 2.9.6, contra los tipos reales de `@anthropic-ai/sdk@1.8.0` y
`@supabase/supabase-js@2.110.7`; una copia con campos mal escritos falló con
10 errores, así que comprueba de verdad). Detrás de un proxy con certificado
propio hace falta `DENO_CERT` apuntando a él. No está en CI todavía (ver
pendientes en `docs/expenses-2026-11.md`). Ninguna prueba llama a Anthropic
ni a Supabase: la lectura con IA de la demo y de la suite e2e la contesta el
servidor falso. Tampoco al servicio de tasas de cambio: lo contesta el
harness (opción `fx`). Lo único que habla con él es `npm run check:rates`
(`scripts/check-rates.mjs`), que lee sus respuestas con el mismo
`lib/fx.ts` de la app y tiene su propio workflow
(`.github/workflows/rates-contract.yml`, a mano y en los PR que tocan las
tasas). En este entorno no llega al host y solo dice, sin más, que no pudo
conectar: **está por ejecutar desde una máquina con internet**.

CI (`.github/workflows/ci.yml`) corre en cada push y PR: escaneo de secretos
con gitleaks, tests y build, el esquema SQL contra un Postgres de usar y
tirar, y la suite e2e.

`supabase/tests/run.sh` monta la base de tres formas: (A) el esquema con el
que se publicó la app (`supabase/tests/original_schema.sql`) con filas,
subido con las migraciones 001→009, cada una dos veces (y, tras cada una,
comprueba que `supabase/check_migrations.sql` dice «yes» justo para las que
ya han corrido); (B) lo mismo subido
con `schema.sql` dos veces; (C) una instalación desde cero con `schema.sql`
dos veces y todas las migraciones encima, con filas escritas como las
escribe una versión antigua (sin `status`). En A y B comprueba el backfill;
en C, el trigger; en las tres, las escrituras de versiones antiguas y
nuevas, las constraints y, para `bankroll_moves` y las tres tablas de gastos
(sección 11 de `checks.sql`; la 12 es la 009: las tres columnas del gasto en
otra moneda, sus cinco constraints, una app anterior que no las nombra), la
regla de conflicto, la cascada al borrar el
usuario y las policies ejercidas como un usuario
conectado (rol `authenticated`, que crea `stubs.sql`; por eso necesita un
superusuario, como el `postgres` de CI: hace falta crear el rol y luego
poder hacer `set role` a él). Luego compara las tres estructuras (tablas,
columnas, constraints, índices, policies, trigger y función, y qué publica
realtime; el orden de las columnas aparte, que migraciones aditivas no
pueden igualar). Necesita
`psql`, `createdb`, `dropdb` y `pg_dump` con las variables `PG*` apuntando a
un servidor donde pueda crear bases (todas se llaman `bettracker_test_*`).
En local, como root: `su postgres -c 'bash supabase/tests/run.sh'`.

La suite e2e construye a `dist-e2e/`, sirve con `vite preview` e inyecta un
mock de Supabase (`window.__supabaseMock`) más una caché sembrada en
`localStorage`, de modo que lo que se ejercita es el camino real offline de la
app. Con `backend: 'live'`, `'behind'` o `'behind-005'` el mock es un
pequeño servidor en memoria (apuestas, ajustes e ingresos/retiradas; altas,
ediciones con la regla de conflicto, borrados, upserts; latencia y caída de
conexión opcionales) para probar la sincronización de verdad. Es el mismo
que usa `npm run demo` (`src/renderer/src/demo/fakeSupabase.ts`), con su
estado bajo `e2e:` en vez de `demo:`; `e2e/demo.spec.ts` prueba la demo tal
cual se construye (`npm run demo:serve`, en el puerto 4182). `'behind'` es
una base sin la 004 ni la 005; `'behind-005'`, con la 004 y sin la 005
(`e2e:migrated-005` la "ejecuta"); `'behind-008'`, con la 004, la 005 y la
007 y sin la 008 (`e2e:migrated-008`); `'behind-009'`, con todo hasta la 008
y sin la 009 (`e2e:migrated-009`: sin ella las lecturas de gastos no traen
las tres columnas y una escritura que las nombre recibe PGRST204). La opción
`fx` hace que el harness conteste por el servicio de tasas de cambio
(`api.frankfurter.dev`; por defecto 1 USD = 1,4 CAD, con modos `fail`,
`offline`, `unsupported`, `garbage` y `delayMs`; `setFx` lo cambia a mitad
de prueba y `fxRequests` da lo pedido). **Sin `fx`, una petición a ese host
hace fallar la prueba**, y el Chromium de la suite tampoco puede resolver su
nombre (`playwright.config.ts`): ninguna prueba toca la red. La opción `moves` siembra la caché de
ingresos y retiradas del dispositivo (sin ella, el dispositivo nunca los ha
cargado); `expenses`, `cards` y `budgets`, las de gastos, tarjetas y
presupuestos (con `moves` y sin ellas valen `[]`; `null`, ninguna caché);
`view: 'expenses'` abre en la vista Gastos; `ai` dirige la lectura con IA
falsa (`rows`, `fail` con un código, `hold`, `ignoreAbort`), y el harness
exporta `TINY_PNG`, `scanFile` y `bigPng` (un recibo de 1200×1600 dibujado en
la página). En este entorno hizo falta `NO_PROXY='*'` para que
Playwright llegara a `localhost`; en CI no.

## Qué cambió, por fases

### Gastos en otra moneda (noviembre 2026)

Petición del usuario: «la moneda principal que quiero es dólar canadiense
pero en algunas transacciones tengo usd entonces me gustaría que en la app
registrara los gastos y los convierta a cad». Detalle completo en
`docs/expenses-2026-11.md`, «Otras monedas y tasas de cambio». En corto:

- **La moneda de los ajustes es la principal** (CAD) y todo lo que suma
  sigue en ella. Un gasto se puede pagar en **otra moneda** (USD): la hoja
  tiene un selector junto al importe y, debajo, la **tasa** del día y el
  importe **en la moneda principal**, los dos editables (escribir uno
  recalcula el otro; lo que escribe el usuario se respeta al cambiar la
  fecha). Una línea dice de dónde sale la tasa. Sin tasa no se guarda: nunca
  un importe en dólares como si fuera la moneda principal.
- **Datos**: migración 009, tres columnas opcionales en `expenses`
  (`original_amount`, `original_currency`, `fx_rate`; las tres o ninguna).
  `amount` no cambia de significado: es el importe en la moneda principal, y
  puede ser lo que cobró el banco en vez de original × tasa. La copia
  completa y el CSV de gastos (tres columnas al final) los llevan.
- **Tasas**: del Banco Central Europeo, por Frankfurter
  (`api.frankfurter.dev`, gratis y sin clave). La petición lleva dos códigos
  de moneda y una fecha, nada más, y no pasa por Supabase. Se guardan en el
  dispositivo (`bettracker:fx`, una clave sin usuario, prescindible), así
  que sin conexión se convierte con la última guardada y se dice de qué día
  es. La CSP admite ese host. Monedas que el servicio no publica (COP, ARS,
  CLP, PEN…): la tasa se escribe a mano.
- **Listas**: la moneda principal se escribe con su símbolo estrecho (`$`
  para CAD; el código va junto al título del mes) y lo pagado en otra moneda,
  pequeño y con su código («USD 12.00»).
- **Revisión del escaneo**: selector «Moneda de la imagen» arriba (Wallet
  enseña `$` a secas para CAD y USD); en otra moneda cada fila se convierte
  con la tasa de su día, una fila sin tasa no entra en «Añadir N» y un campo
  da una tasa a todas las que no tienen. Los duplicados se reconocen por lo
  pagado (misma moneda e importe) o por el importe en la moneda principal. El
  aviso antiguo de «la moneda no coincide» desaparece.
- **Antes de la 009** los gastos esperan como «Falta actualizar» (ver «Orden
  de despliegue seguro»).
- **`supabase/check_migrations.sql`**: consulta de solo lectura que dice qué
  migraciones tiene ya el proyecto.
- **Comprobación del servicio real**: `npm run check:rates`
  (`scripts/check-rates.mjs`) y el workflow `rates-contract.yml`, aparte del
  CI principal.

**Cómo se probó.** Unitarios nuevos: `fx`, `fxRates`, `expenseFx`, y casos
en `validate`, `rowTable`, `rowStorage`, `rowOps`, `errors`, `fakeSupabase`,
`backup`, `expenseCsv`, `currency`, `expenseForm`, `expenseReview`,
`expenseLast`, `useRowSync`, `store` y `demo`. SQL: sección 12 de
`checks.sql` y `check_migrations.sql` tras cada migración. e2e:
`expenses-fx.spec.ts` (7). **No se ha podido hablar con el servicio de tasas
desde este entorno** (el host no es alcanzable): su contrato está escrito
según su documentación y `npm run check:rates` aquí solo llega a decir que
no pudo conectar. Hay que ejecutarlo (o el workflow) desde una máquina con
internet. Tampoco se ha aplicado la 009 al proyecto real.

**Expectativas de pruebas que cambian a propósito.** `currency.test.ts`: la
moneda principal usa el símbolo estrecho (`$` en vez de `MX$`, `CA$`,
`COP`…). `expenseCsv.test.ts`: tres columnas más. Los tests de
`rowTable`, `rowOps`, `rowStorage`, `validate` y `expenseForm` esperan los
tres campos nuevos (nulos). `expenseReview.test.ts`: una lectura en USD con
otra moneda principal ya no es un importe «con decimales de más» sino una
fila en otra moneda. e2e: en `expenses.spec.ts` la prueba del símbolo ancho
usa soles (`PEN`) porque el peso colombiano ahora es `$`, y las dos pruebas
que «ejecutan» la 008 a mano ejecutan también la 009.

### Gastos (noviembre 2026)

Petición del usuario: una pestaña para los gastos del día a día (un café,
cosas), con presupuesto, sus dos tarjetas por separado y un gráfico que las
una, y el registro a mano o con IA a partir de la foto de una factura o de
una captura de Apple Wallet. Detalle completo en `docs/expenses-2026-11.md`.
En corto:

- **Vista Gastos** junto a Apuestas (pestañas bajo la cabecera, recordadas
  por dispositivo; solo se monta la activa). En ella el botón principal es
  **Añadir gasto**, y `T` y el **+** del móvil abren la hoja de gasto. Mes
  con flechas (compartido con el calendario de apuestas), resumen (gastado,
  presupuesto restante, por tarjeta, media diaria y proyección), un gráfico
  que apila el gasto de cada tarjeta (acumulado contra la línea del
  presupuesto, o por día), barras de presupuestos, desglose por categoría y
  la lista (tabla en escritorio, tarjetas en el móvil; búsqueda y filtros).
- **Gasto**: fecha, importe (negativo = reembolso, en verde), tarjeta
  opcional, comercio, una de 11 categorías fijas, nota y origen (a mano o
  IA). Se escribe como se teclea («4,50», «1.234,50», «12.500» en COP).
  Deshacer en cada alta, edición y borrado; todo funciona sin conexión.
- **Tarjetas** (las que se quieran; nombre, últimos 4, crédito o débito);
  borrar una con gastos la archiva. **Presupuestos** mensuales: total, por
  tarjeta y por categoría, ámbar desde el 80 % y rojo al pasarse, nunca
  bloquean. **Moneda** de los gastos a elegir (USD por defecto); cambiarla
  no convierte nada y las apuestas siguen en dólares.
- **Lectura con IA**: «Escanear recibo» envía la imagen (reducida a 1600 px,
  JPEG) a la Edge Function `extract-expenses`, que la lee con Claude Opus 5.5
  con la clave de Anthropic del proyecto (solo en sus secretos) y devuelve los
  gastos para **revisarlos** antes de guardar nada: tarjeta reconocida por
  sus 4 últimos dígitos, posibles duplicados desmarcados, filas dudosas
  abiertas. La imagen no se guarda en ningún sitio. Unos 3 a 10 céntimos de
  dólar por escaneo.
- **Copia completa**: el archivo incluye ahora `expenses`, `expenseCards`,
  `expenseBudgets` y `settings.expenseCurrency` (sigue siendo la versión 1;
  una copia anterior sigue valiendo y una app anterior los ignora). Esta
  versión los lee y los cuenta pero **aún no los restaura**: la revisión lo
  dice. «Descargar copia» espera a que carguen gastos, tarjetas y
  presupuestos; «Restaurar» solo a apuestas, movimientos y ajustes. **CSV de
  gastos** aparte, desde la lista; el CSV de apuestas no cambia.
- **Datos**: migración 008 (tres tablas con RLS, realtime y los triggers de
  la 007; `card_id` sin clave foránea; ids de presupuesto deterministas) y
  una capa de sincronización genérica para las tres (`data/useRowSync.ts`),
  con las mismas reglas que apuestas y movimientos.

**Cómo se probó.** Unitarios de toda la lógica nueva (sincronización por
tabla con `describe.each`, gasto del mes y proyección, presupuestos, moneda,
lectura de importes, tarjeta por últimos dígitos, duplicados, CSV, imagen,
el módulo compartido de la IA con su prompt, esquema y validación, el
cliente de la función, la copia); `checks.sql` sección 11 contra Postgres;
e2e: `expenses.spec.ts` (12: pestañas, alta/edición/borrado sin conexión,
sincronización y cierre de sesión con una escritura en vuelo, tarjetas,
presupuestos, moneda, gráfico, escaneo con duplicado y Deshacer sin guardar
la imagen, fallos de la IA, cancelar a media lectura, antes de la 008, la
revisión a 320 px en es y en), `expenses-sync.spec.ts` (3), y añadidos en
`mobile.spec.ts` (la vista y sus diálogos a 320 y 390 px, campos de 16 px),
`demo.spec.ts` (escaneo de ejemplo; «Empezar de cero» vacía los gastos) y
`backup.spec.ts` (la copia lleva los gastos; la moneda solo se ofrece con la
008 probada). La lectura con IA nunca se ha probado contra Anthropic de
verdad, ni la 008 ni la función contra el proyecto real: no hay acceso desde
aquí.

**De paso**, en las apuestas: al pulsar el lápiz de una apuesta en el
diálogo del día, el foco saltaba a la casilla del stake un instante después
aunque ya se hubiera pasado a otra casilla, y lo que se escribía acababa en el
stake (por eso `e2e/clv.spec.ts` fallaba de vez en cuando, más con la app más
cargada). Ahora `DayModal.startEdit` solo mueve el foco si sigue donde estaba
al pulsar; `forms.spec.ts` lo comprueba de forma determinista. Y un aviso de
conexión, una vuelta a la app o un cambio nuevo que llegaban mientras la cola
se estaba enviando se perdían (`syncNow` volvía sin hacer nada) y lo pendiente
esperaba al reintento de 20 s (por eso `migration.spec.ts` «says so once…»
fallaba a veces). Ahora una llamada durante un envío pide otro justo después
(`drainTurns` en `data/oneAtATime.ts`, con su test), en apuestas, movimientos
y las tres tablas de gastos; tras un fallo pasajero sigue mandando la espera.

**Dudas abiertas.** Restaurar gastos, tarjetas y presupuestos desde una
copia (el formato ya los guarda); un `deno check` de la función en CI; una
cuota diaria duradera por usuario para la IA (hoy el límite de verdad es el
del workspace de Anthropic); si conviene versionar un `deno.lock` (hoy
`"lock": false`, ver «Decisiones»). Lista completa en
`docs/expenses-2026-11.md`.

### Rediseño visual «Graphite Ledger» (noviembre 2026)

Detalle en `docs/design-2026-11.md`. En corto:

- **El color es dinero:** verde ganado, rojo perdido, ámbar en juego. El botón
  principal es tinta invertida (blanco en oscuro, negro en claro), no verde;
  el foco, la selección y los segmentos son neutros.
- **Paleta grafito** (`#0e0f11` / `#f7f7f8`), tarjetas planas con borde fino,
  KPI en dos franjas con divisores, estados como punto + palabra, etiquetas
  como texto con «·», controles segmentados con «pulgar».
- **Inter Variable** incluida (`assets/fonts`, OFL), pesos 400/500/600, sin
  versalitas espaciadas, cifras tabulares.
- **Movimiento:** solo entradas cortas con `ease-out` (diálogos, hoja en
  móvil, menú, avisos, cifras nuevas, acordeón); nada se mueve en reposo; con
  «reducir movimiento» solo quedan fundidos.
- **JSX tocado:** `HeroStats` (`key` por cifra), `BalanceChartInner` (eje de
  P/L con marcas redondas), `CalendarView` (`data-heat` por tercios),
  `App`/`Toast` (región `role="status"` siempre montada).
- Mismas clases, textos y orden en el DOM: las 232 e2e pasan sin cambios.

### Auditoría del 5 de noviembre (base 2bc6310)

Informe en `docs/audit-2026-11-06.md`. En corto:

- Importar, restaurar y Deshacer son **operaciones durables**
  (`data/operations.ts`): cada parte se escribe en el historial con lo que va
  a encolar (`prepared`), se encola y se marca (`queued`). Cualquier ventana
  reanuda lo que quedó preparado (al arrancar y cada 20 s), una sola vez, bajo
  el candado de la operación; no encola si la cola ya tiene esa generación
  (por sello e ids) o si el servidor ya respondió por ella.
- El historial guarda **qué dijo el servidor de cada fila** (`made`,
  `present`, `absent`, `rejected`, `missing`) y de cada ajuste (`confirmed`,
  `kept`, `rejected`, `missing`); `lib/batchStatus.ts` no deduce nada de una
  cola vacía.
- Cada respuesta lleva su **generación**: el sello de las filas
  (`BatchEvent.stamp`) o el `editedAt` de la escritura de ajustes
  (`settingsAnswer`). Tras un Deshacer del Deshacer (`redoBatch`), una
  respuesta tardía del envío anterior no completa el nuevo (`ofThisGeneration`),
  y el borrado de un Deshacer solo mira su generación (`generationStart`).
- Los ajustes pendientes llevan su **origen** (`PendingSettings.fieldOrigin`):
  solo la respuesta a esa escritura cuenta para esa restauración o su Deshacer.
  Qué hace un Deshacer con cada ajuste lo decide `undoSettingsPlan` (y lo anota
  `undoSettingsLog`): el valor de la copia se devuelve; el de antes, si nunca
  se confirmó el reemplazo, no se toca ni se llama «tu cambio posterior».
- **«Comprobar de nuevo»** solo dice lo que el servidor tiene; si falta algo,
  ofrece reintentar, nunca lo hace solo.
- El **registro de confirmaciones entre pestañas** (`data/confirmed.ts`) va
  numerado con suelo y época; una lectura que no puede verificarse se descarta
  y se repite, y un fallo al escribirlo se avisa a las demás ventanas. Lo
  validado se aplica en el orden del servidor (también lo propio), y tras
  cerrar sesión no se escribe en él.
- Los **ajustes pendientes se envían por sentencias** (`settingsGroups` en
  `data/useSettings.ts`): cada escritura de una operación a su hora, y los
  campos del usuario a la última. Si una escritura pierde por la hora de la
  fila, App la reclasifica con la fila (`checkSettings`): «conservado» solo si
  el campo cambió de verdad.
- **Deshacer** se planifica bajo el candado de su operación (un segundo clic u
  otra ventana no lo repiten), espera a que los datos estén cargados y descarta
  las altas rechazadas del lote. «Retenido» (solo en esta ventana) sale del
  estado en vivo del almacenamiento, no de la fase guardada.
- Un primer trabajo de esta auditoría se perdió con un reinicio del contenedor
  (commits locales sin subir); se rehízo y desde entonces se sube a la rama.

### Auditoría del 2 de noviembre (base df13583)

Los informes de auditoría no estaban en este contenedor (están en el Mac del
usuario); se trabajó con la lista de hallazgos del encargo. El informe
actualizado está en `docs/audit-2026-11-03.md`.

- **Restaurar y Deshacer seguros**: cada importación o restauración escribe
  todas sus filas con el mismo `updated_at` (su *sello*, `ImportBatch.stamp`),
  que en el servidor es su recibo. El servidor dice qué filas hizo el lote
  (`addBets` devuelve las insertadas y relee el sello de las demás: una
  respuesta perdida cuenta), y Deshacer borra solo con
  `delete … where id = … and updated_at = sello` (`deleteBet`/`deleteMove`
  con `ifStamp`): nunca una fila que ya estaba, la de otro dispositivo con el
  mismo id ni una editada después, sepa lo que sepa este dispositivo. El plan
  se rehace antes de aplicar (`RestorePlan.signature`) y la revisión se
  actualiza sola si los datos cambian. Los ajustes reemplazados se guardan
  (antes/después) y su Deshacer los devuelve campo a campo, con guarda en el
  servidor (`PendingSettings.guard`, `saveGuarded`): un cambio posterior se
  queda. El historial (`data/imports.ts`) es ahora un almacén con candado que
  registra lo que hizo el servidor (`BatchEvent`) y qué no se pudo encolar.
- **Resultado de la restauración** (`RestoreResult` en `DataDialog`,
  `lib/batchStatus.ts`): añadidos (confirmados por el servidor), ya
  presentes, duplicados omitidos, ajustes, pendientes de sincronizar (nunca
  «añadidos»), fallos y qué hacer (Guardar de nuevo, Volver a enviar, Elegir
  la copia otra vez), y luego qué hizo Deshacer.
- **Rechazadas**: una operación rechazada no sale de la cola hasta que su
  registro está guardado (`queueStore.update(…, { hold: false })`,
  `drainOutbox` → `stop: 'storage'`); el aviso `refusal-blocked-notice` lo
  dice.
- **Reintentos de importación**: migración 007 (lápidas, ver "Orden de
  despliegue seguro").
- **Lecturas de ajustes tardías**: solo hacia delante en `updated_at`
  (`newerSettings`); "sin fila" nunca sustituye a una fila.
- **Lecturas entre pestañas**: las confirmaciones se publican en
  `localStorage` (`data/confirmed.ts`) y cada lectura les superpone las de
  otras ventanas confirmadas mientras estaba fuera (apuestas y movimientos).
- **Ajustes guardándose / guardados aquí**: cada edición va primero a un
  diario de la ventana (`data/settingsJournal.ts`), sin candado; al arrancar
  se encolan los diarios de ventanas cerradas. El diálogo distingue
  «Guardando en este dispositivo…», «Guardado en este dispositivo:
  sincronizando…» y «…se sincronizará al volver la conexión».
- **Duplicados por fila** en la revisión de importación (y de restauración
  de otra cuenta): cada uno junto a la apuesta a la que se parece (fecha,
  resultado, stake, beneficio, cuota, cierre, etiquetas, nota), omitido por
  defecto, con «Importar las N» / «Omitir todas», totales exactos y listas
  largas paginadas.
- **Alta rápida con fecha**: hoy por defecto, Hoy/Ayer y un selector; el
  borrador guarda la fecha; una hoja abierta al pasar la medianoche registra
  el día que mostraba.
- **Acciones en móvil**: «Editar» / «Ver día» / «Eliminar» en una línea,
  con nombres accesibles completos.

### Revisión de funciones y auditoría (octubre 2026)

Hecho a partir de la revisión práctica y de la auditoría (los informes no
estaban en este contenedor; se trabajó con la lista de hallazgos):

- **Fiabilidad**: los seis defectos de la auditoría ya estaban resueltos;
  se volvieron a comprobar (`e2e/resilience.spec.ts`, 38 casos).
- **Alta rápida**: stake 0 + cuota 2.0 + GANADA ya no se cierra en
  silencio: pide el beneficio de la promoción (`QuickAdd`, `lib/betForm.ts`).
  Una gratis perdida queda perdida a 0 (`normalizeInput`, migración 006).
  Un beneficio que se redondea a 0,00 se pide con su motivo. Los errores
  van junto a su casilla (`aria-describedby`, foco al primero); un rechazo
  deja el formulario abierto con lo escrito (`refusalText`) y solo se
  cierra cuando se acepta. Los manejadores de `App` lanzan el error al
  formulario en vez de solo mostrar un aviso.
- **Importación CSV**: paso de revisión (`DataDialog`, `lib/importPlan.ts`):
  listas, rechazadas con su motivo (traducido) y posibles duplicados
  (omitidos salvo que se conserven; dos filas iguales del archivo se
  importan las dos). Cada importación es un lote (`data/imports.ts`) que se
  puede deshacer entero; el mismo archivo se reconoce (en curso o ya
  importado).
- **Edición directa y borradores**: el lápiz del historial abre esa
  apuesta en edición; la fecha abre el día. Los formularios guardan
  borrador al cerrarse sin querer (`data/drafts.ts`), con **Descartar**.
- **Historial en móvil**: tarjetas compactas que se despliegan
  (`HistoryTable`, ≤640 px); la tabla sigue en escritorio.
- **Alcance**: cada cifra dice qué fechas cubre; el historial puede
  limitarse al rango; la barra masiva dice cuántas hay seleccionadas y
  cuántas ocultan los filtros; días ganadores y apuestas ganadas separados;
  la tasa de equilibrio con su propio recuento.
- **Copia completa** (`lib/backup.ts`): JSON versionado con apuestas,
  movimientos y ajustes; se valida antes de aplicar y restaurar solo añade.
  **¿Olvidaste la contraseña?** y pantalla de contraseña nueva
  (`auth/NewPassword.tsx`).
- **Panel**: P/L, bankroll y pendientes primero; analítica avanzada
  plegable; guía de primeros pasos para cuentas nuevas; **Añadir apuesta**
  y el **+** del móvil abren la misma hoja.
- **Cabecera**: solo **Añadir apuesta** (y la insignia de sincronización);
  lo demás (cuenta, Importar y exportar, Pendientes, Ajustes, tema, idioma
  y Salir) está en el menú ☰ (`Header.tsx`), que cuenta las pendientes y se
  maneja con el teclado.

### Fase 1 · red de seguridad
- Workflow de CI con jobs `calidad` (ci/test/build) y `e2e`; hoy es
  `.github/workflows/ci.yml` y añade el escaneo de secretos.
- Suite Playwright en `e2e/` con harness (`e2e/harness.ts`): usuario falso,
  semilla de tres apuestas, mock de Supabase, opción `settings` para sembrar
  ajustes.

### Fase 2 · modelo de datos
- **Una fila = una apuesta.** `Bet` en `src/shared/types.ts`; la tabla sigue
  llamándose `entries` (renombrarla no sería aditivo).
- Migración 003: `odds` (decimal, > 1), `status`
  (`pending|won|lost|push|void`) con backfill desde el signo de `amount`,
  `amount` nullable (solo `null` mientras está pendiente), constraints que
  atan importe y estado, índice de pendientes, y un trigger que da a las
  escrituras de versiones antiguas (sin `status`) el que implica su importe.
- `amount` sigue siendo el **resultado neto**, nunca el pago; `stake`
  `null` sigue siendo "sin registrar" (fuera del ROI), `0` es apuesta gratis
  (ganancia reportada aparte como *bonus*).
- ROI: solo ganadas/perdidas con stake real; push y void fuera del
  denominador; muestra tamaño de muestra y aviso *small sample* por debajo
  de 50. Probabilidad implícita media junto al strike rate.
- **Conflictos entre dispositivos:** gana la última edición por hora de
  edición (`updated_at = editedAt`, `update … where updated_at <= editedAt`);
  una edición rechazada se descarta con aviso y se refresca. La regla no
  necesita columna extra ni triggers (el único trigger, el de la 003, es de
  compatibilidad de `status`); se confían los relojes de los dispositivos.
- CSV: columnas `date,status,stake,odds,closing_odds,amount,sport,book,bet_type,note`,
  alias de otros trackers, columna `result` numérica detectada como importe.
  Exportaciones antiguas (sin estas columnas) importan sin cambios. Las
  cuotas se leen en decimal, americano o fraccionario (ver "Decisiones").
- `hydrateBet` rellena cachés antiguas (sin stake/odds/status/closingOdds).

### Fase 3 · seguridad
- Celdas de texto del CSV que empiezan por `= + - @ \t \r '` se exportan con
  apóstrofo delante; el import quita exactamente uno (ida y vuelta exacta).
- Electron: `contextIsolation`, `sandbox`, bloqueo de navegación y de
  ventanas nuevas a orígenes ajenos, permisos denegados, CSP con
  `object-src 'none'`, `base-uri`, `form-action`, `frame-src 'none'`.

### Fase 4 · interfaz
- Contraste AA en ambos temas (tokens `--text-3`, `--green`, `--amber`,
  `--red`, `--push` ajustados), token de foco, un solo `.field`, escalas de
  tipografía y espaciado, breakpoints 1120/640, Recharts cargado en diferido.
- Toda la interfaz en `lib/strings.ts` (en/es) con `t()`/`tn()` y botón de
  idioma; el idioma sigue al navegador y se recuerda. Mensajes de validación
  y de red quedan en inglés (decisión acordada; los de inicio de sesión y los
  del `.env` sí se traducen, ver "Decisiones"); el dinero se formatea en USD.

### Fase 5 · features (orden del plan)
1. **Registro rápido** (`QuickAdd.tsx`): botón flotante y tecla `T`; stake,
   cuota y un toque en WON/LOST/PUSH/PENDING; stake por defecto de ajustes o
   el último; etiquetas del último registro; ganada sin cuota pide la
   ganancia. La tecla `T` cancela su propia pulsación para no caer en el
   campo recién enfocado.
2. **Formatos de cuota** (`SettingsDialog.tsx`, `lib/odds.ts`): americana
   (por defecto), decimal o fraccionaria; se guarda siempre decimal; la caja
   de cuota entiende `+150`, `1.91` y `3/2` siempre; al editar sin tocar la
   caja se conserva el valor exacto.
3. **Panel de pendientes** (`PendingPanel.tsx`): contador en el botón del
   menú (☰) y en la tarjeta del panel,
   lista de más antigua a más reciente, un toque resuelve, fecha pasada en
   ámbar.
4. **Unidades y bankroll** (`lib/bankroll.ts`, `BankrollDialog.tsx`,
   `StakeNote.tsx`, `data/moves.ts`, `data/useMoves.ts`, migración 005):
   bankroll inicial + ingresos − retiradas + P/L resuelto = bankroll actual,
   en un diálogo que lo desglosa y donde se añaden, editan y borran (con
   Deshacer) ingresos y retiradas, offline vía su propia cola; mini-tarjeta
   Bankroll en el panel; gráfico P/L o Bankroll (un solo eje, con lo
   aportado en línea discontinua); nota bajo el stake con su porcentaje del
   bankroll, ámbar por encima del 5 %, sin bloquear nunca; tamaño de unidad
   e interruptor dólares/unidades en ajustes, con todo importe del panel,
   el gráfico, el calendario, el historial, el desglose, los pendientes y
   el aviso de pérdidas mostrado en unidades. Siguen en dólares las
   casillas, el diálogo de bankroll y la fila Bankroll de ajustes (donde el
   dinero se escribe; la cifra actual lleva al lado sus unidades), la base
   y el CSV.
5. **CLV** (`closing_odds`, `lib/stats.ts`): cuota de cierre por apuesta en
   el modal del día; CLV = cuota / cierre − 1 por apuesta (historial, modal),
   media en una tarjeta ("batió el cierre n de m") y por fila del desglose;
   columna `closing_odds` en el CSV.
6. **Rangos de fecha** (`RangeBar.tsx`, `lib/range.ts`): todo / esta semana
   (domingo a sábado) / este mes / últimos 30 días / este año / personalizado;
   aplica a tarjetas, gráfico y desglose; calendario, tarjeta del mes,
   historial y contador de pendientes ven todo; se recuerda en
   `bettracker:range`.
7. **Desgloses** (`lib/bands.ts`): por banda de cuota (favorito claro ≤ 1.50,
   favorito ≤ 1.90, parejo ≤ 2.10, underdog ≤ 3.50, sorpresa), día de la
   semana y mes, con tamaños de muestra; sin etiqueta o sin cuota queda
   fuera.
8. **Edición masiva + Deshacer** (`lib/bulk.ts`): selección de filas,
   reetiquetar, resolver pendientes, eliminar (doble clic); Deshacer en el
   toast de cualquier eliminación y de cada edición masiva, vía outbox
   (funciona offline). Una apuesta restaurada conserva su id pero recibe
   una hora de registro nueva.
9. **Límite mensual de pérdidas** (`lib/lossLimit.ts`, `LossBanner.tsx`):
   aviso ámbar al 80 % y rojo al alcanzarlo; nunca bloquea; se puede cerrar
   por mes y nivel.

**Ajustes** viven en `user_settings` (migración 004): `odds_format`,
`unit_size`, `show_units`, `starting_bankroll`, `default_stake`,
`loss_limit`. Capa `data/settings.ts` + `data/useSettings.ts`: misma regla de
conflicto que las apuestas, caché offline y outbox de un solo parche
fusionado. `unit_size`, `show_units` y `starting_bankroll` los usa la
feature 4; el bankroll inicial se edita en el diálogo de bankroll.

## Feature 4 · preguntas abiertas

Hecha según la propuesta que había aquí (tabla `bankroll_moves`, migración
005). Quedan decisiones de producto que tomé por defecto y puedes cambiar:

- **Dólares/unidades sincronizado** entre dispositivos (`show_units` en
  `user_settings`, para lo que lo creó la 004), solo en Ajustes. Un
  interruptor de un toque en el panel sería cómodo, pero entonces convendría
  guardarlo por dispositivo: los ajustes comparten una sola clave de
  conflicto, y un cambio frecuente ahí puede pisar una edición offline del
  bankroll inicial hecha en otro dispositivo.
- **Ingresos y retiradas no van en el CSV**, que sigue siendo solo de
  apuestas e idéntico byte a byte. Un export de movimientos sería aparte.
- **Los importes se escriben en dólares** aunque se muestren en unidades
  (la nota bajo el stake da la cifra en unidades).
- **Sin "pon tu saldo de hoy"**: el bankroll inicial es lo que había antes
  de la primera apuesta (el diálogo dice su fecha).
- **Conflicto de ajustes**: un cambio del bankroll inicial hecho offline en
  un dispositivo se descarta (con el aviso de siempre) si entretanto otro
  dispositivo cambió cualquier otro ajuste. Es la regla de toda la fila de
  ajustes desde la 004; arreglarlo por campo pediría guardar la base de cada
  parche y reintentar solo lo no tocado.

## Decisiones tomadas y por qué

- **El `.env` se comprueba antes de usarlo** (`src/shared/supabaseEnv.ts`):
  - `npm run build` (y el de escritorio) se para si la URL o la clave no
    pueden funcionar o publicarían un secreto, y dice qué poner. `npm run
    dev` y `preview` solo avisan, y la app enseña lo mismo en la pantalla de
    configuración, en vez de quedarse en blanco (una URL sin `https://` hacía
    que supabase-js lanzara un error al cargar). La demo no se comprueba;
  - detecta: URL sin `https://`, la del panel, la cadena de conexión de
    Postgres (lleva la contraseña), una ruta de la API detrás, los ejemplos
    sin cambiar, la clave secreta o `service_role`, una clave cortada o con
    comillas o espacios, algo que no es una clave (el JWT secret) y una clave
    anon de otro proyecto que el de la URL (lo que Supabase llama "Invalid
    API key"). Una clave publishable no lleva su proyecto: ese caso sale al
    iniciar sesión, con el mensaje que dice qué clave poner;
  - la clave recomendada es la publishable (`sb_publishable_…`). La anon
    antigua funciona, pero Supabase retira las claves antiguas a finales de
    2026: el build lo avisa. La variable sigue llamándose
    `VITE_SUPABASE_ANON_KEY`, para no romper los `.env` que ya existen;
  - el idioma de lo que imprime el build es el de la terminal (`LANG`).
- **Los errores de inicio de sesión salen en palabras** (`auth/authErrors.ts`):
  clave rechazada, sin conexión, contraseña mal, correo sin confirmar, cuenta
  ya existente, demasiados intentos, registro desactivado y correo no
  aceptado, en en y es. Se guardan tal cual y se traducen al mostrarlos; lo
  que no se reconoce sale con las palabras de Supabase, como antes.
- **Auditoría de sincronización (seis defectos, todos con test que los
  reproduce con el código anterior):**
  1. *Reintentar una importación pisaba ediciones nuevas.* El upsert de
     `addBets` sobrescribía las filas que ya habían llegado (y bajaba su
     `updated_at`). Ahora la operación guarda `done` (filas confirmadas,
     por lotes de 250), el reintento empieza después y usa `ON CONFLICT DO
     NOTHING`: una fila que ya está se queda como la tiene el servidor.
     `applyOutbox` y `reconcile` muestran la del servidor. El Deshacer de un
     borrado sigue siendo un alta normal (no pasa por aquí).
     `supabase/tests/checks.sql` (9) lo comprueba con RLS en Postgres.
     Cada lote confirmado pasa a la copia del servidor en ese momento
     (`landImport`) y la importación solo muestra las filas sin confirmar:
     una fila que llegó y se borró en otro dispositivo no vuelve. Solo puede
     volver una del lote que estaba en vuelo cuando se cortó. Las lecturas no
     esperan al envío (y una lista larga se lee por páginas): una que salió
     antes de que llegara un lote, una alta, una edición o un borrado vuelve
     con eso puesto encima (`confirmedLog`), en apuestas y en movimientos.
     Si no, las filas del lote desaparecían y una apuesta borrada volvía
     hasta la siguiente lectura.
  2. *Varias pestañas se pisaban la cola.* Cada una escribía la cola que
     leyó al arrancar. Ahora la cola guardada es la verdad: cada cambio es
     leer-modificar-escribir bajo un candado entre ventanas (Web Locks,
     `bettracker:queue:<cola>:<usuario>`), y solo una ventana la vacía a la
     vez (`bettracker:drain:…`), leyéndola antes de cada operación y
     enviando la versión guardada al marcarla `sent`. Las demás se enteran
     por el evento `storage`. Apuestas, movimientos y ajustes. Mismas
     claves y formato: nada que migrar. Sin Web Locks (http en la red
     local) el candado es solo de la ventana, como antes.
     El candado solo no basta: localStorage no es coherente entre procesos
     del navegador (cada ventana lee su copia, y la escritura de otra le
     llega un momento después), así que quien toma el candado podía leer la
     cola de antes de la última escritura y devolverla (en Chromium, tres
     ventanas a toda velocidad perdían una de cada cinco). Cada escritura
     bajo un candado sube una versión, en localStorage
     (`<candado>:version`) y en IndexedDB (`bettracker-locks`, que todas
     leen al día); el siguiente espera a que su copia la tenga antes de
     leer (como mucho 2 s, por si alguien borró el almacenamiento a mano).
     Sin IndexedDB lee enseguida, como antes. El drenado lee la cola igual
     (`fresh()`). Test: `e2e/resilience.spec.ts`, tres ventanas con el
     `store.ts` real (servidor de desarrollo).
     Una petición sin respuesta completa (cuerpo incluido) se abandona a los
     30 s (`lib/timeoutFetch.ts`, en `global.fetch` del cliente) y cuenta
     como sin conexión: si no, una ventana colgada se quedaba el candado de
     vaciado y ninguna otra sincronizaba. Si IndexedDB tarda más de 3 s en
     abrirse, la ventana sigue sin versiones mientras tanto y las usa desde
     que abre.
  3. *Un fallo al guardar se daba por guardado.* La caché se puede perder
     (`writeExpendable`); la cola no (`writeDurable`): si no cabe, se tiran
     las cachés y se reintenta, y si aun así falla la cola se queda en la
     ventana (`held`), sigue sincronizando, el aviso lo dice y el toast no
     dice "añadida". "Reintentar" la guarda cuando hay sitio, y también la
     lista de rechazadas si tampoco cupo (entonces cuenta en el aviso). Lo retenido
     es la lista de cambios hechos en la ventana, que se reaplican sobre la
     cola guardada en cada intento: lo que otras guardaron se queda y lo que
     esta quitó (una operación enviada, una apuesta borrada) no vuelve. Por
     eso cada cambio busca por id y decide una sola vez qué quita: la marca
     `sent` lleva el intento que la puso (`sentBy`, opcional) y solo ese
     intento la quita, el progreso de una importación no retrocede, la
     cabeza que se marca al arrancar se decide una vez (`markHeadSent`) y
     los ajustes se combinan campo a campo por hora (`editSettings`).
     "Volver a enviar" solo quita de la lista lo que la cola guardó: con
     la cola solo en la ventana, lo reenviado sale del aviso pero sigue
     guardado en la lista hasta que la cola se guarda o eso sale de ella
     (enviado, o rechazado otra vez en su propia entrada).
  4. *Errores temporales tiraban la cola.* `describeError` guarda status y
     código (`SyncError`). 5xx, 408, 429 y códigos PGRST000–003, 08…, 40001,
     40P01, 53…, 57P01–03, 57014 → `'retry'` con espera creciente (1 s, 2 s…
     hasta 2 min, ±20 %; un 429 empieza en 5 s); 401, clave o JWT →
     `'paused'`; solo un rechazo definitivo saca el cambio, a la lista de
     rechazadas (`bettracker:refused:<usuario>`, `moves-refused`), visible
     tras recargar, con "Volver a enviar" y "Descartar". Un alta rechazada
     (no como duplicada: una que llegó responde así y se lee de vuelta), en
     el intento que sea, se lleva lo que se encoló detrás para su apuesta
     (ediciones y borrado, hasta un Deshacer que la crea de nuevo), y entra
     en la lista antes de salir de la cola; lo que se pliega en ellas o se
     encola para la apuesta mientras tanto sale con ellas, y la entrada se
     reescribe. "Volver a enviar" encola primero
     y luego quita de la lista; cada entrada se pliega antes
     (`requeueRefused`: un alta y su borrado no son nada) y una edición
     rechazada no pisa una más nueva de la misma apuesta, ni su borrado
     (`requeueOp`). "Cerrar sesión" cuenta también las rechazadas antes de
     borrarlas. Cada parada limpia los motivos de la anterior en la
     insignia (solo el estado: cada aviso se dice una vez por episodio), y
     los ajustes pendientes también salen en ella; una lectura que funciona
     no da por enviado un ajuste que sigue fallando. Una primera
     lectura fallida se repite con el temporizador (`retryPlan`), como en
     movimientos y ajustes; lo confirmado antes de esa primera lectura se
     muestra aparte (`foldApplied`), sin contar como leído ni guardarse en
     caché como la lista entera. Sesión terminada → insignia "Sesión cerrada",
     "Volver a entrar" sin borrar la cola, y el aviso de cada cambio dice
     que se sincronizará al volver a entrar.
     Cada lectura y cada envío dicen para qué cuenta son
     (`signedInUserId(asUser)`): con la sesión de otra cuenta cuenta como
     sin sesión, así que una sincronización de A que sigue en marcha cuando
     entra B no lee las filas de B ni manda los cambios de A como B. Lo que
     esa sincronización traiga se descarta (los hooks comparan con
     `userRef`), y tras cerrar sesión nada de esa cuenta se vuelve a
     guardar en el dispositivo hasta que entre otra vez (`clearUserData`,
     `markSignedIn`). Cerrar sesión en una ventana la cierra también en las
     demás (`signedOutElsewhere`, en `AuthProvider`), aunque Supabase no se
     lo diga (sin conexión y con el token caducado no lo hace, ni la demo):
     si no, seguían mostrando la cuenta y lo que cambiaban no se guardaba.
  5. *Un rechazo de ajustes borraba un parche más nuevo.* Ahora cualquier
     respuesta solo liquida lo que se envió (`afterSettingsAnswer`): lo
     editado mientras tanto sigue pendiente y sale enseguida. Un ajuste se
     ve en pantalla en cuanto se cambia, antes de que acabe de guardarse.
     El parche guarda la hora de cada campo (`fieldEditedAt`, opcional: los
     guardados por versiones anteriores no la tienen), así que un campo
     vuelto al mismo valor mientras el envío estaba fuera también sigue
     pendiente si ese envío perdió contra otro dispositivo.
  6. *Un `max-rows` menor truncaba el historial.* `readAll` avanza por las
     filas recibidas y para con el total contado (o, sin total, con una
     página vacía). Apuestas y movimientos.
- **Puertos de la suite e2e**: 4183 (build), 4182 (demo), 4181 (dev), en
  `e2e/urls.ts`; ninguna spec lleva una URL fija.
- **El correo de confirmación vuelve a la app**: `signUp` pide
  `emailRedirectTo` = la dirección actual (solo http/https; Supabase la usa si
  está en Redirect URLs, si no, su Site URL). Un enlace caducado o ya abierto
  (los escáneres de correo los abren antes) deja el error en la dirección;
  la pantalla de entrada lo dice en en y es y lo quita de la dirección.
- **Sin sesión, la cola espera** (`data/session.ts`, `SignedOutError`):
  cerrar sesión en un dispositivo cierra la de todos (`signOut` es global), y
  cuando la sesión de otro caduca y no se puede renovar, supabase-js manda
  las peticiones como nadie. Antes, eso tiraba lo que hubiera en cola: un
  alta fallaba ("You are signed out") y se descartaba, una edición o un
  borrado no encontraban la fila y salían de la cola, y una lectura volvía
  vacía y borraba la copia del dispositivo. Ahora cada lectura y cada envío
  piden antes la sesión; sin ella, o con una clave que Supabase no acepta o
  un JWT caducado (`isAuthError`), el cambio se queda en cola, en pausa
  (`'paused'`), y sale tras el siguiente inicio de sesión. Un rechazo de RLS sigue
  siendo un rechazo: con la sesión pedida antes, ya no viene de esto.
- **En el móvil** (revisado con capturas a 320, 360, 390 y 430 px, en los dos
  temas y los dos idiomas):
  - nada puede ensanchar la página: el calendario y la rejilla usan
    `minmax(0, 1fr)`, y la tarjeta de inicio de sesión se encoge;
  - en el calendario, los días con solo apuestas abiertas llevan un punto
    ámbar en vez de la palabra;
  - los campos van a 16 px para que iOS no haga zoom;
  - los botones táctiles miden al menos 32–36 px;
  - el + deja libre el final de la página;
  - se respetan las zonas seguras (notch, barra de inicio);
  - el historial deja fijas a la derecha las acciones de cada fila, y la barra
    de selección flota abajo en vez de empujar las filas;
  - las cuotas americanas y fraccionarias abren el teclado completo (el
    numérico del iPhone no tiene signo menos ni barra);
  - en pantallas táctiles, el diálogo del día no pone el cursor en el stake al
    abrirse;
  - `e2e/mobile.spec.ts` vigila todo esto.


- Tabla `entries` conservada; "bet" en código e interfaz.
- Push y void fuera del denominador del ROI (devuelven el stake).
- `result` en un CSV ajeno significa estado si tiene palabras, importe si
  tiene números y no hay columna de importe.
- Última edición gana por hora de edición, sin columna de versión.
- Cuotas siempre guardadas en decimal; el formato es solo de entrada y
  presentación.
- Rango de fechas por dispositivo (no por usuario): es una vista, no un dato.
- Deshacer re-añade con el mismo id a través del outbox; por eso un segundo
  borrado de una apuesta restaurada conserva su `delete` en cola (bug
  encontrado y corregido en la feature 8).
- Semana de domingo a sábado, como el calendario.
- Import CSV de cuotas: las fracciones (`3/2`) y los precios con signo
  (`+150`, `-110`, `-110.00`, `+2,500`) dicen su formato; un número sin signo
  es decimal, salvo dos casos ambiguos: un valor entero desde 100 (`150` o
  `150.00` puede ser +150 sin el `+`, que Excel quita, o una cuota decimal de
  150, y así la escriben nuestras propias exportaciones) y `1,200` (miles o
  coma decimal). Se decide una vez por archivo y para las dos columnas de
  cuota: un export nuestro (se reconoce por su cabecera) es decimal, salvo
  que alguien haya escrito a mano cuotas americanas en él; una cabecera que
  nombra el formato manda; si no, precios con signo válidos y ningún
  decimal → americano; decimales válidos y ningún signo → decimal; ambos →
  esa línea se informa en vez de adivinar; ninguno → si hay algún `1,200`,
  decimal (coma decimal, como la caja de cuota), y si no, el formato de
  cuota del usuario. Solo cuenta como pista una cuota que se puede guardar
  (`storableOdds`): una errata no inclina el archivo.
- Una cuota se valida ya redondeada a 3 decimales, como la guarda la base
  (`storableOdds`, en `lib/validate.ts`): 1.0004 se marca inválida en el
  formulario y se rechaza en el import, en vez de pasar y que la base la
  rechace como 1.000 (lo que tiraba el import entero).
- La cola quita cada operación enviada por su `opId`, nunca por posición.
  Una operación que ya salió una vez queda marcada `sent` (guardado con la
  cola): haya respondido o no, puede estar en el servidor, así que nadie la
  reescribe ni la cancela; una edición o un borrado de esa apuesta hechos
  después se encolan detrás, y una edición se funde solo en la última
  operación sin enviar de esa apuesta. La cabeza de la cola al arrancar
  cuenta como enviada: una versión anterior no guardaba `sent` y su cola es
  idéntica (cuesta como mucho una petición de más).
- Si el servidor rechaza para siempre un alta en su primer intento (y no
  como duplicada), la apuesta no llegó a existir: se van con ella las
  ediciones encoladas para esa apuesta (solo podrían fallar, con un falso
  aviso de conflicto). Los borrados y un Deshacer detrás se quedan (borrar
  una fila que no existe no hace nada; el Deshacer es otra decisión del
  usuario). Tras un intento anterior (pudo llegar) o en una importación
  (pudo llegar un trozo) solo sale la operación rechazada. Si en su primer
  intento la base la rechaza por falta de migración, se desmarca `sent`:
  no se aplicó, así que borrarla aún la cancela.
- Un `update` rechazado por la regla de conflicto no avisa de "edición más
  reciente en otro dispositivo" si queda detrás otra operación de este
  dispositivo para esa apuesta: esa tiene la última palabra.
- Un alta lleva como `updated_at` la hora de su contenido en el dispositivo
  (la del registro o la de la última edición fundida en ella), no el
  `now()` del servidor: así una edición hecha mientras el alta viajaba no
  parece más antigua, y la regla de conflicto compara siempre horas de
  dispositivo.
- Una operación que la base rechaza porque le falta una migración se queda
  en la cola (como sin conexión) en vez de descartarse; cada cola
  (apuestas, ajustes, ingresos y retiradas) da el aviso una vez por episodio
  (hasta que una petición pasa o la cola se vacía), no en cada reintento.
  `data/drain.ts` decide qué sale de la cola y qué se queda, qué muestra la
  insignia, cuándo repetir el aviso, dónde va una fila que llega antes de la
  primera lectura (`foldApplied`) y qué hace el reintento lento
  (`retryPlan`); los hooks guardan el estado y aplican esas decisiones.
- El signo de un importe se valida ya redondeado a céntimos, como se
  guarda: 0.004 es un push de 0.00, no una ganada de 0.00.
- Las lecturas completas (apuestas e ingresos/retiradas) van por páginas
  (`data/readAll.ts`): Supabase devuelve como mucho 1.000 filas por
  petición y corta el resto sin avisar, así que con más de 1.000 apuestas el
  historial, el P/L y el bankroll perdían las más nuevas.
- Una casilla de ajustes o del bankroll inicial sigue al valor guardado
  hasta que el usuario escribe en ella (`useBox`), y al cerrar solo se
  guarda si la tocó: así un ajuste que se carga o cambia en otro dispositivo
  con el diálogo abierto no se pisa al cerrarlo.
- Ingresos y retiradas en su propia tabla y su propia cola, con las mismas
  reglas que las apuestas (`enqueueOp`, `drainOutbox`, `headAsSent` son
  genéricos por tipo, sin copiar cuerpos): en una cola compartida, uno
  frenado por la 005 frenaría todas las apuestas de detrás. Una lectura que
  no encuentra la tabla es "aún no hay ninguno", sin aviso; solo una
  escritura frenada avisa, una vez. Un movimiento que llega al servidor
  antes de la primera lectura se sigue mostrando, pero no se guarda en
  caché como si fuera la lista entera.
- El bankroll tiene tres estados: *cargando* ("…", mientras no han cargado
  en este dispositivo los ajustes y los movimientos), *sin configurar*
  ("—", sin inicial ni movimientos) y conocido. Así una primera apertura
  offline no enseña una cifra falsa. Cubre siempre todas las apuestas, sea
  cual sea el rango; se calcula en céntimos enteros.
- La nota del 5 % compara en céntimos (`stake × 20 > bankroll`): justo el
  5 % no es "más del 5 %", y el porcentaje mostrado redondea hacia arriba
  cuando está por encima (5.1 %, nunca "5.0 % · más del 5 %"). Ocupa
  siempre su línea, para que los botones de debajo no se muevan al
  escribir. En el modal del día solo aplica a apuestas de hoy en adelante o
  pendientes, y al editar mide contra el bankroll de antes de esa apuesta.
- Gráfico de bankroll como vista aparte (P/L o Bankroll), nunca con un
  segundo eje; marcas redondas (`niceScale`) y puntos unidos en recto,
  porque un ingreso es un salto, no una pendiente.
- Las unidades son solo de presentación (`moneyFormat`, `useMoney`): un
  único tamaño para todo el historial; quitar el tamaño apaga las unidades
  en el mismo parche, para que ponerlo luego no las encienda por sorpresa.
- Los montos de ajustes se validan ya redondeados (`parseMoneyBox`): un
  valor que la base rechazara tiraría el parche entero. De paso, un límite
  de pérdidas de 0.004 ya no se envía como 0 (rechazado) sino como "sin
  límite". Las casillas de ajustes y del bankroll guardan lo escrito también
  al cerrar con Esc o pulsando fuera.
- Ingreso/Retirada y "en juego" en español; los avisos que nombran uno u
  otro tienen clave propia por el género. El aviso de "guardado offline"
  en español es neutro ("se guarda en este dispositivo").
- La 003 se editó en su sitio (en vez de añadir una 005) para meter el
  trigger de compatibilidad, porque aún no se había ejecutado en ningún
  sitio; así el trigger existe desde el momento en que `status` pasa a ser
  obligatorio. La regla de "migraciones nuevas para cada cambio" sigue
  valiendo para todo lo ya aplicado.
- **Gastos: una capa de sincronización genérica** (`data/rowTable.ts`,
  `data/rowStorage.ts`, `data/useRowSync.ts`) para gastos, tarjetas y
  presupuestos, con las mismas piezas que los movimientos (`useOpQueue`,
  `drainOutbox`, registro de confirmaciones entre pestañas, lectura que no
  encuentra la tabla = ninguno todavía) pero sin lotes ni restauraciones.
  `useMoves` no se tocó: copiarlo tres veces habría triplicado el código, y
  refactorizarlo habría puesto en riesgo lo que ya funciona. Cada tabla tiene
  su cola, su caché y su canal (`bettracker:<nombre>…:<uid>`), así que una
  frenada no frena las demás, y un solo aviso de «falta actualizar» vale para
  las tres.
- **`expenses.card_id` sin clave foránea.** Las tarjetas y los gastos van
  por colas distintas: un gasto puede llegar al servidor antes que su
  tarjeta, y con una FK se rechazaría para siempre. Un id sin tarjeta se
  muestra como «Sin tarjeta». Borrar una tarjeta con gastos la archiva; solo
  se borra de verdad cuando la lista de gastos está cargada y leída en esta
  sesión y ninguno la usa.
- **Ids de presupuesto deterministas** (`lib/stableId.ts`, a partir de
  usuario, ámbito y destino): dos dispositivos que ponen el mismo
  presupuesto sin conexión acaban en una sola fila (`unique (user_id, scope,
  target)`); el alta que choca aplica su valor si es más reciente. El
  algoritmo está congelado por un test con valores fijos.
- **Moneda solo de los gastos, sin conversión.** `user_settings.expense_currency`;
  las apuestas siguen en dólares y las unidades nunca se aplican a gastos.
  Cambiarla solo cambia cómo se escriben los mismos números (la app lo dice).
  Se activa solo con prueba de que existe la 008 en esa sesión (una lectura
  o escritura de las tablas que funcionó): un parche con la columna contra
  una base sin ella frenaría todos los ajustes.
- **IA vía Edge Function, con la clave en sus secretos y lista de
  permitidos.** La clave de Anthropic nunca llega a la app (el build se para
  si ve una `VITE_*ANTHROPIC*` o un valor `sk-ant-`). La función comprueba
  la sesión del usuario (`auth.getUser`) y `EXTRACT_ALLOWED_USERS` (sin ella,
  nadie), sin reintentos del SDK y con un plazo de 108 s, por debajo de los
  115 s de la app, para no facturar dos veces. El prompt, el esquema JSON y
  la validación están en un módulo sin imports (`src/shared/expenseExtraction.ts`)
  que comparten la función, la app (que vuelve a validar la respuesta) y los
  tests. Las tarjetas se mandan como pistas (nombre, últimos 4, tipo), nunca
  sus ids: el cliente decide la tarjeta.
- **`deno.json` con `"lock": false`.** Sin eso, cada `deno check` escribe un
  `deno.lock` en el repositorio. Las dependencias directas ya van fijadas en
  el import (`npm:@anthropic-ai/sdk@1.8.0`, `npm:@supabase/supabase-js@2.110.7`);
  versionar un lock fijaría también las transitivas con su hash, y es una
  decisión para cuando haya un `deno check` en CI que lo mantenga al día.
- **La copia guarda los gastos pero aún no los restaura** (versión 1 del
  formato, claves opcionales). Restaurarlos pide decidir cómo se mezclan
  con lo que hay (ids de tarjeta de otra cuenta, presupuestos con id
  determinista por usuario); mientras, no se pierde nada: están en el
  archivo y la revisión dice cuántos hay. Una lista de gastos mal formada
  cuenta como ausente: nunca impide restaurar las apuestas.

## Mapa de archivos nuevos o muy cambiados

```
src/shared/types.ts                 Bet, BetInput, Settings, OddsFormat, BankrollMove, MoveInput, Expense, ExpenseCard, ExpenseBudget
src/shared/supabaseEnv.ts           comprueba VITE_SUPABASE_URL y _ANON_KEY (el build y la app); rechaza una clave de Anthropic
src/shared/expenseExtraction.ts     lectura con IA: categorías, prompt, esquema JSON, validación (app, función y tests)
src/renderer/src/auth/authErrors.ts los rechazos de Supabase Auth, en palabras (en y es)
src/renderer/src/lib/
  stats.ts      resumen, ROI, CLV, breakdown por tag/banda/día/mes
  bands.ts      bandas de cuota (único lugar)
  odds.ts       conversión y parseo de formatos
  range.ts      rangos de fecha + persistencia
  bulk.ts       planes de edición masiva y su inverso
  pending.ts    apuestas abiertas, orden y "pasada"
  lossLimit.ts  niveles del límite mensual
  bankroll.ts   bankroll actual, serie diaria, nota del 5 %, avisos de movimientos
  format.ts     formato de dinero en dólares o unidades (+ money.ts, el contexto)
  chartView.ts  vista del gráfico (P/L o Bankroll) y marcas redondas
  useBox.ts     casilla de dinero que sigue al valor guardado hasta que se escribe
  quick.ts      valores por defecto del registro rápido
  uuid.ts       ids nuevos, también por http en la red local (sin crypto.randomUUID)
  csv.ts        export/import con guardas de fórmula
  strings.ts, i18n.ts
  view.ts       vista Apuestas o Gastos, recordada por dispositivo
  categories.ts, stableId.ts            categorías de gasto; ids deterministas de presupuesto
  currency.ts   formato de la moneda de los gastos (símbolo estrecho la principal; con código lo pagado en otra)
  fx.ts         tasas de cambio, la parte pura y sin imports: URL, lectura de la respuesta, conversión, caché
  expenseFx.ts  gasto en otra moneda: las casillas de tasa e importe convertido y lo que se guarda
  spend.ts      gasto del mes, proyección, presupuestos, datos del gráfico, filtros
  expenseForm.ts, expenseReview.ts      la hoja de gasto (importes como se teclean); la revisión de lo leído por la IA
  cardMatch.ts  tarjeta por últimos 4 dígitos o nombre
  expenseCsv.ts CSV de gastos
  scanImage.ts, scanImageDom.ts         la imagen a escanear: tamaño, tipo, JPEG
src/renderer/src/demo/
  fakeSupabase.ts   el Supabase falso de la demo y de la suite e2e
  start.ts          entrada de `npm run demo` (va delante de main.tsx)
  demo.ts           usuario de la demo y "Empezar de cero"
src/renderer/src/data/
  bets.ts, offline.ts, useBetSync.ts      apuestas: servidor, caché, outbox
  settings.ts, useSettings.ts             ajustes: lo mismo en pequeño
  moves.ts, useMoves.ts                   ingresos y retiradas: servidor y sincronización
  readAll.ts                              leer todas las filas, por páginas
  drain.ts                                vaciar la cola: qué sale y qué se queda
  errors.ts                               leer un fallo: sin conexión, en pausa, reintentar, falta migración, rechazo
  session.ts                              ninguna petición de las filas de un usuario sin su sesión
  store.ts                                las colas en el almacenamiento, compartidas entre ventanas con candado
                                          y versión en IndexedDB; lo retenido se reaplica
  useOpQueue.ts                           una cola de operaciones (apuestas o movimientos): candados, rechazadas
  rowTable.ts, rowStorage.ts, useRowSync.ts, rowOps.ts
                                          gastos, tarjetas y presupuestos: servidor, almacenamiento y sincronización
  expenseSpecs.ts, expenses.ts            las tres tablas descritas para esa capa
  expenseLast.ts                          última tarjeta, categoría y otra moneda usadas en el dispositivo
  fxRates.ts                              tasas de cambio: la petición, la caché del dispositivo, qué se usa sin conexión
  extract.ts                              llamada a la Edge Function extract-expenses
src/renderer/src/lib/betForm.ts     los problemas de cada casilla, en palabras; rechazos
src/renderer/src/lib/importPlan.ts  revisión de una importación: duplicados, huella del archivo
src/renderer/src/lib/backup.ts      copia completa: formato, validación, plan de restauración
src/renderer/src/lib/useMedia.ts    media queries (tarjetas del historial en móvil)
src/renderer/src/data/drafts.ts     borradores de los formularios
src/renderer/src/data/imports.ts    lotes de importación (para deshacerlos)
src/renderer/src/auth/NewPassword.tsx  contraseña nueva desde el enlace de recuperación
src/renderer/src/index.css    todo el estilo: tokens grafito arriba, móvil al final (docs/design-2026-11.md)
src/renderer/src/assets/fonts/   Inter Variable (woff2) y su licencia OFL
src/renderer/src/components/
  DataDialog (importar/exportar/copias), FirstRun (primeros pasos), FieldError,
  QuickAdd, SettingsDialog, PendingPanel, RangeBar, LossBanner,
  HistoryTable (selección + barra masiva), DayModal (cuota de cierre),
  Breakdown (seis pestañas), HeroStats (tarjetas CLV y Bankroll), Toast (acción),
  BankrollDialog, StakeNote, BalanceChart (vista Bankroll), DemoBanner,
  ViewTabs (Apuestas | Gastos), Paged
src/renderer/src/components/expenses/
  ExpensesView, SpendSummary, SpendChart(+Inner), BudgetsPanel, CategoryBreakdown,
  ExpenseList, ExpenseSheet, ScanPanel, ScanReview, ExpenseSettings, CardsEditor,
  BudgetEditor, CurrencyPicker, useDialog, useRates (las tasas que pide una hoja o una revisión), fxText
e2e/*.spec.ts                       260 comprobaciones (mobile.spec.ts: el móvil;
                                    setup.spec.ts y login.spec.ts: el .env y el inicio de sesión;
                                    resilience.spec.ts: pestañas, almacenamiento, fallos del servidor,
                                    importación cortada, lecturas tardías, paginación, ajustes en vuelo;
                                    expenses.spec.ts y expenses-sync.spec.ts: los gastos;
                                    expenses-fx.spec.ts: los gastos en otra moneda)
e2e/urls.ts                         los puertos de la suite (E2E_PORT, E2E_DEMO_PORT, E2E_DEV_PORT)
supabase/migrations/00{2,3,4,5,6,7,8,9}_*.sql, supabase/schema.sql
supabase/check_migrations.sql       consulta de solo lectura: qué migraciones tiene ya el proyecto
scripts/check-rates.mjs             `npm run check:rates`: el servicio de tasas real, leído con lib/fx.ts
.github/workflows/rates-contract.yml  ese chequeo, aparte del CI (a mano y en PR que tocan las tasas)
supabase/functions/extract-expenses/ la Edge Function de la lectura con IA (index.ts, deno.json)
supabase/config.toml                ajustes de la CLI: sin la comprobación JWT de la pasarela para esa función
docs/expenses-2026-11.md            los gastos: decisiones, datos, sincronización, IA, pruebas, pendientes
supabase/tests/                     el esquema contra un Postgres real
```
