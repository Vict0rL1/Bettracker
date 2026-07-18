import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import SetupNeeded from './components/SetupNeeded'
import { AuthProvider } from './auth/AuthProvider'
import { isConfigured } from './lib/supabase'
import './index.css'

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    {isConfigured ? (
      <AuthProvider>
        <App />
      </AuthProvider>
    ) : (
      <SetupNeeded />
    )}
  </StrictMode>
)
