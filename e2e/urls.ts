/**
 * Where the e2e suite serves the app: one place for the config and the specs.
 * The defaults stay off 4173, the port another `vite preview` usually holds;
 * E2E_PORT, E2E_DEMO_PORT and E2E_DEV_PORT move them.
 */
const port = (name: string, fallback: number): number => {
  const raw = process.env[name]
  return raw ? Number(raw) : fallback
}

/** The production build the suite runs against (`vite preview`). */
export const APP_PORT = port('E2E_PORT', 4183)
/** `npm run demo` as built (e2e/demo.spec.ts). */
export const DEMO_PORT = port('E2E_DEMO_PORT', 4182)
/** `npm run dev` with a .env that can't work (e2e/setup.spec.ts). */
export const DEV_PORT = port('E2E_DEV_PORT', 4181)

export const APP_URL = `http://localhost:${APP_PORT}`
export const DEMO_URL = `http://localhost:${DEMO_PORT}`
export const DEV_URL = `http://localhost:${DEV_PORT}`
