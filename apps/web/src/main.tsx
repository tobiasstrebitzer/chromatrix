import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/globals.css'
import { applyTheme } from './lib/theme'
import { App } from './App.tsx'

// Keep <html data-theme> in sync with the persisted pref (the inline head script already does this
// pre-paint; this re-asserts after load and seeds from the OS preference on first launch).
applyTheme()

const root = document.getElementById('root')
if (!root) throw new Error('Root element #root not found')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
