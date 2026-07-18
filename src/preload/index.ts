import { contextBridge } from 'electron'

// The renderer talks to Supabase directly over the network, so there is no
// privileged main-process surface to expose. A tiny flag lets the UI know it's
// running inside the desktop shell if it ever needs to adapt.
contextBridge.exposeInMainWorld('bettracker', { desktop: true })
