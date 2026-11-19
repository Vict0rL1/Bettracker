# Pulido 2.0 de Apuestas (noviembre 2026)

## La petición

Del dueño, en el encargo de BetTracker 2.0: mejorar la app que ya existe sin
rediseñarla («menos es más»), con la precisión de los cálculos por delante de
cualquier adorno, y que en tres segundos se entienda la situación. Para
Apuestas: conservar el P/L, el bankroll, las pendientes, el mes y el ROI tal
como están, sin KPI nuevos, y revisar que cada cifra sea correcta y que
nunca se invente un dato que falta. Dos auditorías de solo lectura dejaron
una lista; lo decidido se hizo aquí, sin migración, sin dependencias nuevas y
sin tocar la sincronización. Gastos tuvo su parte aparte.

## Qué cambió y por qué

### Cálculos

- **ROI con céntimos, no con polvo de coma flotante.** `roi()` dividía los
  flotantes sin redondear: con resultados de 45,45, −50, 30 y −25,45 (stake
  50 cada uno) la suma daba 1,8 × 10⁻¹⁵ en vez de 0, y la tarjeta decía
  «+0.0%» en verde mientras el P/L decía «$0.00». Ahora el porcentaje sale del
  beneficio y de lo apostado **redondeados al céntimo, como se muestran**
  (`pct = round2(profit) / round2(staked) × 100`), la tinta sigue al beneficio
  redondeado (0 → neutra) y `fmtPctSigned` pone el signo sobre la cifra ya
  redondeada: un ±0,04 % de verdad se lee «0.0%», nunca «+0.0%» ni «−0.0%»
  (la misma regla que ya seguían los importes en unidades). Nada más cambia:
  los mismos criterios de qué entra en el ROI (ganadas y perdidas con stake
  mayor que 0) y el mismo `missing`.
- **Un solo origen para el dinero en juego.** La tarjeta de pendientes, el
  panel de pendientes, el resumen (`pendingStaked`) y el bankroll (`inPlay`)
  sumaban cada uno los stakes de las pendientes por su cuenta. Ahora todos
  usan `riding(bets)` de `lib/stats.ts` (suma al céntimo, cuántas hay y
  cuántas no tienen stake). El retorno de cada apuesta del historial
  (`returnPct`, en tabla y en tarjetas) también es una sola función, y la
  probabilidad implícita vive solo en `lib/odds.ts` (stats la importa).
- **La fecha de la primera apuesta** la da `firstBetDate()` una vez; el
  bankroll la lleva **también cuando aún no se conoce** (cargando o sin
  configurar), porque el diálogo que lo configura necesita la pista «lo que
  tenías antes de tu primera apuesta, el 1 ago» justo entonces. `App` lee
  `bankroll.firstBetDate` en vez de recalcularla.
- Se borró lo que no usaba nadie: `riskedOf` (stats), `isSettled`,
  `hasStake`, `SettledBet` y `StakedBet` (`shared/types.ts`), la insignia
  `cal-count` del calendario (el CSS la ocultaba) y la segunda copia de
  `dollarsTitle` en `HeroStats`.

### Lo que dicen las tarjetas

- **Lo que está en juego se dice una vez.** «$40.00 en juego» salía tres
  veces en la franja: en el P/L («· 1 pendiente, $40.00 en juego»), en el
  bankroll («$40.00 en juego») y en pendientes («$40.00 en juego»). Ahora
  solo la tarjeta de **pendientes** lo dice; la línea del bankroll dice
  **siempre** lo aportado («$1,380 aportados» / «$1,380 contributed», o
  «retirados» si es negativo) y la del P/L cuenta apuestas y días.
- **Pendientes a cero**: el «0» va en la tinta neutra (`flat`, `--text-3`),
  no como titular; «Nada esperando resultado» se queda.
- **La media del stake** deja la cabecera del ROI (había cuatro cifras a
  primer nivel) y entra en su línea: «−$20.00 sobre $110.00 apostados · media
  $55.00 · 2 de 3 apuestas con stake». La cabecera conserva solo el aviso
  ámbar de «muestra pequeña».
- **Un rango sin apuestas lo dice.** Con un rango elegido y nada dentro, la
  línea del P/L, la del ROI y el gráfico dicen «Sin apuestas en Esta semana»
  (el nombre del rango, tal cual). «Registra tu primera apuesta…» solo sale
  cuando la cuenta no tiene ninguna apuesta.
- **«Todas las fechas» solo cuando hace falta.** Las etiquetas de alcance
  (bankroll, pendientes, ROI, analítica, historial) y la nota bajo la barra de
  rangos salen solo con un rango distinto de «Todo»: con todo, todas las
  tarjetas cubren lo mismo y decirlo en cada una era ruido. La nota sigue en
  el DOM, oculta visualmente, como descripción del grupo para el lector de
  pantalla (`aria-describedby`).
- **Plurales** por `tn()`: «1 pendiente», «1 día ganador, 1 día perdedor»
  (bases nuevas `pending`, `winningDay`, `losingDay` en `i18n.ts` y
  `strings.ts`; las dos claves sueltas del calendario, `cal.betsTip` y
  `cal.pendingTip`, pasan por `tn('bet')` y `tn('pending')`).
- **«Últimos 30 días»** no cabía en su segmento a 320 px y se partía en dos
  líneas: en español pasa a «30 días» (el inglés «Last 30 days» cabe).

### Gráfico

- **Líneas rectas** (`type="linear"`) para el P/L y para el bankroll: una
  curva entre dos días sugería que el dinero se movía el día anterior. La
  línea de lo aportado sigue en escalón (`stepAfter`): un ingreso es
  instantáneo. El comentario del componente lo dice ahora bien: en cada
  punto, la distancia entre las dos líneas es el P/L hasta ese día.
- **Punto de apertura en el P/L**: la curva empieza en $0 el día anterior al
  primer día resuelto (como ya hacía `bankrollSeries`), así que **una sola
  apuesta ya dibuja** una línea de 0 a su resultado. El texto «Registra al
  menos dos días…» desaparece: `chart.emptyAll` dice dónde empieza la curva
  («La curva de balance empieza con tu primera apuesta resuelta») y
  `chart.emptyMonth`, «Sin apuestas resueltas en {mes}».
- **Eje del P/L con marcas redondas**, como el del bankroll (`bankrollAxis`
  sobre el mínimo y el máximo con el 0 dentro). Una serie toda a cero (todo
  «push») tiene dominio con hueco, nunca `[0, 0]`.
- La burbuja del P/L escribe el acumulado **con signo** (`fmt.signed`); la
  del bankroll, como nivel, con su signo natural.
- `margin.right` de 10 a 24 px: la última etiqueta de fecha, centrada en el
  último punto, ya no se cortaba.
- La lógica pura del gráfico está en `lib/chartView.ts`, con tests: qué
  fechas llevan etiqueta (`xTicks`), el eje (`yAxisFor`, también el caso todo
  a cero) y el punto de apertura (`withOpening`); el tipo `ChartPoint` vive
  allí.
- **El trozo del gráfico que no se pudo descargar ya no tumba la app.** El
  gráfico se carga aparte (Recharts es lo más pesado del bundle). En una
  primera ejecución sin conexión, la primera apuesta resuelta pedía ese
  archivo, el `import()` fallaba y, sin nadie que lo recogiera, React
  desmontaba toda la app (lo destapó la suite: en la demo, una apuesta
  añadida sin conexión; antes hacían falta dos días resueltos para pedir el
  gráfico, ahora basta uno). Un *error boundary* en `BalanceChart`
  (`ChartBoundary`) deja la tarjeta con una línea («El gráfico no se pudo
  cargar sin conexión. Se carga la próxima vez que abras la app con
  conexión») y el resto del panel en pie. **Sin reintento en la misma
  página**: Chromium recuerda la URL del módulo que falló y la rechaza otra
  vez sin preguntar a la red (comprobado: ni una petición), así que el archivo
  llega con la siguiente carga; la app instalada lo guarda en su *service
  worker* desde entonces.

### Calendario

- A 360 px o menos, un día con |P/L| ≥ 1.000 se leía «-$1….». Las celdas usan
  `fmtMoneyCell`: por debajo de $1.000 igual que antes («-$335»), y desde
  $1.000 **miles enteros** («-$1k», «+$12k»; redondeado), sin décima. La cifra
  exacta sigue en el `title` de la celda y en el diálogo del día. En unidades
  se mantiene el compacto de unidades.
- `heatOf` (el tinte por tercios) y `heatSizes` (los |P/L| de los días
  decididos hasta hoy, sin los futuros) pasan a `lib/stats.ts` y tienen test.

### Teléfono

- A 640 px o menos, la tarjeta del **ROI va antes que la del mes** (CSS
  `order`), para que la del mes quede justo encima del calendario que
  gobierna. El DOM, y por tanto el teclado, no cambian; el divisor pasa a la
  tarjeta que se dibuja segunda.

## Textos

Nuevo: `hero.noBetsRange`, `chart.offline`, y los plurales `pending_*`, `winningDay_*`,
`losingDay_*`. Cambian: `hero.roiSub` (lleva `{avg}`), `hero.pendingSuffix`
(`{pending}`), `hero.daysRecord` y `hero.greenSub` (`{w}, {l}` ya contados),
`hero.bankrollFunded` (en: «contributed»), `chart.emptyAll`,
`chart.emptyMonth`, `range.30d` (es). Se borran: `hero.riding`,
`hero.bankrollRiding`, `hero.avgStakeTitle`, `cal.betsTip`, `cal.pendingTip`.
`i18n.test` sigue exigiendo las mismas claves en los dos idiomas.

## Pruebas

- **Unitarias** (vitest, 1695 en 62 archivos): `stats` (ROI exactamente 0 con
  beneficio 0; `riding`; `returnPct`; `heatOf` y `heatSizes`: tercios,
  empates, un solo día, futuros fuera), `format` (`fmtPctSigned(1e-15)` y
  `(-0.04)` → «0.0%»; `fmtMoneyCell`), `bankroll` (`firstBetDate` también sin
  conocer el bankroll; `inPlay` = `riding`; dos movimientos opuestos el mismo
  día: un solo punto con `moved: 0`, sin punto de ingreso y lo aportado igual,
  **tal como se comporta hoy**), `chartView` (`xTicks`, `withOpening`,
  `yAxisFor` con la serie toda a cero), `dates.test.ts` (nuevo:
  `firstWeekday`, `daysInMonth` con febrero bisiesto, `addDays` a través de
  los cambios de hora de Nueva York, `monthYearShort` en los dos idiomas) e
  `i18n` (los plurales nuevos en singular).
- **e2e**: `e2e/hero.spec.ts` (nuevo, 15): lo que está en juego una sola vez
  y lo aportado en el bankroll; pendientes a 0 en tinta neutra; etiquetas y
  nota solo con rango; un rango sin apuestas en es y en; la primera apuesta
  solo sin apuestas; la media en la línea del ROI; P/L $0.00 → ROI 0.0%
  neutro; singulares en es y en; el calendario a 320 px con «-$1k» y «+$12k»
  sin elipsis; el gráfico con una sola apuesta, su etiqueta final sin cortar
  (a 1280 y 320) y la burbuja con signo; el orden ROI → mes → calendario a
  390 px; los seis rangos en una línea a 320 px en español; el trozo del
  gráfico que no se descarga (abortado en la prueba) deja el panel en pie con
  su línea y se dibuja tras recargar con conexión.
- **Expectativas que cambian a propósito**: `dashboard.spec.ts` (sin rango
  no hay etiqueta «All dates» ni nota visible; «1 winning day, 1 losing day»),
  `history.spec.ts` (sin rango, sin etiqueta), `pending.spec.ts` (la línea
  del P/L ya no dice «riding»: lo dice la tarjeta de pendientes, «$70.00 at
  risk · 2 past their date»), `bankroll.spec.ts` («$1,000 contributed» en vez
  de «$40.00 riding», y «$40.00 at risk» en pendientes), `stats.spec.ts` (la
  línea del ROI con «avg $55.00»; el gráfico del mes dibuja con un solo día
  resuelto), `units.spec.ts` («avg 2.75u» en la línea del ROI en unidades),
  `bankroll.test.ts` (el bankroll no conocido lleva `firstBetDate`),
  `chartView.test.ts`, `stats.test.ts` (fuera `riskedOf`).

## Pendiente

- Nada que desplegar: sin migración ni cambios de esquema.
- El nombre del rango se usa tal cual en «Sin apuestas en {rango}» («Sin
  apuestas en Personalizado» es correcto pero seco); una redacción propia por
  rango sería otra decisión de textos.
