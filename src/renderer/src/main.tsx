import './assets/main.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

// Set theme before first render to prevent flash
const savedTheme = localStorage.getItem('csm:theme')
const systemLight = window.matchMedia('(prefers-color-scheme: light)').matches
document.documentElement.setAttribute(
  'data-theme',
  savedTheme === 'dark' || savedTheme === 'light' ? savedTheme : systemLight ? 'light' : 'dark'
)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
