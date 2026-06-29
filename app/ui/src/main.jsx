import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import AuthGate from './auth/AuthGateProvider.jsx'
import { DialogProvider } from './components/DialogProvider.jsx'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AuthGate>
      <DialogProvider>
        <App />
      </DialogProvider>
    </AuthGate>
  </StrictMode>,
)
