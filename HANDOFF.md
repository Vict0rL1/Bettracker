# BetTracker · Handoff

Estado a fecha 2026-10-09. Este repositorio contiene solo BetTracker: su
código, sus migraciones, sus tests y su CI. Cada commit pasa typecheck,
tests unitarios, build y la suite e2e.

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

1. **Migraciones en Supabase**, en este orden, en el SQL editor del proyecto:
   `supabase/migrations/002_stake_and_tags.sql` → `003_odds_and_status.sql`
   → `004_user_settings_and_closing_odds.sql`. Las tres son aditivas y
   re-ejecutables (`if not exists`, `drop … if exists` antes de cada
   constraint y policy). `supabase/schema.sql` contiene lo mismo acumulado
   por si prefieres ejecutar un solo archivo desde cero. La 001 ya estaba
   aplicada antes de este trabajo. Hasta que corras la 004, al guardar un
   ajuste la app mostrará "Your database is behind the app…" con la lista de
   archivos; las apuestas siguen funcionando.
2. **Decidir la feature 4** (unidades y bankroll). Ver "Pendiente" abajo.
3. **Despliegue.** Si la PWA está en Vercel, en el proyecto que ya existe:
   Settings → Git, conectar este repositorio y poner el directorio raíz en
   `/`. Así se conservan el dominio y las variables. Un dominio nuevo dejaría
   la app instalada en el móvil apuntando al viejo, con lo guardado sin
   conexión allí, y obligaría a cambiar las URL de redirección en Supabase
   Auth. El instalador de escritorio se construye con `npm run build:desktop`.

## Cómo probar

```bash
npm ci
npm test            # 212 tests unitarios (vitest)
npm run typecheck   # web + escritorio + e2e
npm run build       # PWA en dist/
npm run test:e2e    # 33 comprobaciones Playwright, sin backend
```

CI (`.github/workflows/ci.yml`) corre en cada push y PR: escaneo de secretos
con gitleaks, tests y build, y la suite e2e.

La suite e2e construye a `dist-e2e/`, sirve con `vite preview` e inyecta un
mock de Supabase (`window.__supabaseMock`) más una caché sembrada en
`localStorage`, de modo que lo que se ejercita es el camino real offline de la
app. En este entorno hizo falta `NO_PROXY='*'` para que Playwright llegara a
`localhost`; en CI no.

## Qué cambió, por fases

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
  atan importe y estado, índice de pendientes.
- `amount` sigue siendo el **resultado neto**, nunca el pago; `stake`
  `null` sigue siendo "sin registrar" (fuera del ROI), `0` es apuesta gratis
  (ganancia reportada aparte como *bonus*).
- ROI: solo ganadas/perdidas con stake real; push y void fuera del
  denominador; muestra tamaño de muestra y aviso *small sample* por debajo
  de 50. Probabilidad implícita media junto al strike rate.
- **Conflictos entre dispositivos:** gana la última edición por hora de
  edición (`updated_at = editedAt`, `update … where updated_at <= editedAt`);
  una edición rechazada se descarta con aviso y se refresca. Sin columna
  extra ni triggers; se confían los relojes de los dispositivos.
- CSV: columnas `date,status,stake,odds,closing_odds,amount,sport,book,bet_type,note`,
  alias de otros trackers, columna `result` numérica detectada como importe.
  Exportaciones antiguas (sin estas columnas) importan sin cambios.
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
  y de red quedan en inglés (decisión acordada); el dinero se formatea en USD.

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
3. **Panel de pendientes** (`PendingPanel.tsx`): contador en la cabecera,
   lista de más antigua a más reciente, un toque resuelve, fecha pasada en
   ámbar.
4. **Unidades y bankroll**: *pendiente de tu OK* (ver abajo).
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
   aviso ámbar al 80 % y rojo al superarlo; nunca bloquea; se puede cerrar
   por mes y nivel.

**Ajustes** viven en `user_settings` (migración 004): `odds_format`,
`unit_size`, `show_units`, `starting_bankroll`, `default_stake`,
`loss_limit`. Capa `data/settings.ts` + `data/useSettings.ts`: misma regla de
conflicto que las apuestas, caché offline y outbox de un solo parche
fusionado. `unit_size`, `show_units` y `starting_bankroll` ya existen pero
la interfaz aún no los usa (feature 4).

## Pendiente · feature 4 (unidades y bankroll)

El plan de la fase 5 pide: ajustes de bankroll inicial y tamaño de unidad,
interruptor dólares/unidades, **seguimiento de ingresos y retiradas** para
que el bankroll cuadre, línea de bankroll en el gráfico y aviso (sin
bloquear) cuando un stake supere el 5 % del bankroll actual.

Propuesta de datos (migración `005_bankroll_moves.sql`, aditiva):

```sql
create table if not exists public.bankroll_moves (
  id         uuid primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  date       date not null,
  amount     numeric(12, 2) not null check (amount <> 0),  -- + ingreso, − retirada
  note       text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- RLS como entries/user_settings, publicación realtime, índice (user_id, date).
```

Bankroll actual = `starting_bankroll` + Σ movimientos + P/L neto de las
apuestas resueltas. Pendientes se muestran como "en juego". Unidades:
`unit_size` aplicado a todo el historial (un solo tamaño, lo habitual).
La capa offline sería un tercer par caché/outbox con los mismos helpers.
La alternativa sin tabla (solo `starting_bankroll`) no cumple el punto de
ingresos y retiradas; por eso la recomendación es la tabla.

## Decisiones tomadas y por qué

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

## Mapa de archivos nuevos o muy cambiados

```
src/shared/types.ts                 Bet, BetInput, Settings, OddsFormat
src/renderer/src/lib/
  stats.ts      resumen, ROI, CLV, breakdown por tag/banda/día/mes
  bands.ts      bandas de cuota (único lugar)
  odds.ts       conversión y parseo de formatos
  range.ts      rangos de fecha + persistencia
  bulk.ts       planes de edición masiva y su inverso
  pending.ts    apuestas abiertas, orden y "pasada"
  lossLimit.ts  niveles del límite mensual
  quick.ts      valores por defecto del registro rápido
  csv.ts        export/import con guardas de fórmula
  strings.ts, i18n.ts
src/renderer/src/data/
  bets.ts, offline.ts, useBetSync.ts      apuestas: servidor, caché, outbox
  settings.ts, useSettings.ts             ajustes: lo mismo en pequeño
src/renderer/src/components/
  QuickAdd, SettingsDialog, PendingPanel, RangeBar, LossBanner,
  HistoryTable (selección + barra masiva), DayModal (cuota de cierre),
  Breakdown (seis pestañas), HeroStats (tarjeta CLV), Toast (acción)
e2e/*.spec.ts                       33 comprobaciones
supabase/migrations/00{2,3,4}_*.sql, supabase/schema.sql
```
