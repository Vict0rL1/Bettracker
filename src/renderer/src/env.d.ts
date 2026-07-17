/// <reference types="vite/client" />
import type { BetTrackerApi } from '../../shared/types'

declare global {
  interface Window {
    api: BetTrackerApi
  }
}

export {}
