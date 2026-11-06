import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { PanelPrototype } from './prototype/variants'
import './styles.css'

// PROTOTYPE (throwaway): ?variant=a|b|c renders the panel-redesign prototype
// instead of the real panel. Drop this gate when the redesign lands.
const variant = new URLSearchParams(window.location.search).get('variant')

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    {variant ? <PanelPrototype initialVariant={variant} /> : <App />}
  </React.StrictMode>
)
