import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import AuthGate from './auth/AuthGateProvider.jsx'
import { DialogProvider } from './components/DialogProvider.jsx'
import AppRoot from './AppRoot.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AuthGate>
      <DialogProvider>
        <AppRoot />
      </DialogProvider>
    </AuthGate>
  </StrictMode>,
)
