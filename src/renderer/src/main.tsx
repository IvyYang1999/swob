import './assets/main.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

// Debug: capture ALL drop events at the earliest stage
document.addEventListener('drop', (e) => {
  document.title = `DROP@${Date.now()}: types=${e.dataTransfer?.types?.join(',') || 'none'}`
}, true) // capture phase

document.addEventListener('dragover', (e) => {
  // Must preventDefault on dragover to allow drops
  e.preventDefault()
}, false)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
