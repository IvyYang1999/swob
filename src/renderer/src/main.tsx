import './assets/main.css'
import React from 'react'
import ReactDOM from 'react-dom/client'

// Set theme before first render to prevent flash
const savedTheme = localStorage.getItem('csm:theme')
const systemLight = window.matchMedia('(prefers-color-scheme: light)').matches
document.documentElement.setAttribute(
  'data-theme',
  savedTheme === 'dark' || savedTheme === 'light' ? savedTheme : systemLight ? 'light' : 'dark'
)

const isSpotlight = window.location.hash === '#spotlight'
const isAgent = window.location.hash === '#agent'

if (isAgent) {
  import('./AgentApp').then(({ AgentApp }) => {
    ReactDOM.createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <AgentApp />
      </React.StrictMode>
    )
  })
} else if (isSpotlight) {
  import('./SpotlightApp').then(({ default: SpotlightApp }) => {
    document.body.style.background = 'transparent'
    ReactDOM.createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <SpotlightApp />
      </React.StrictMode>
    )
  })
} else {
  import('./App').then(({ default: App }) => {
    ReactDOM.createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    )
  })
}
