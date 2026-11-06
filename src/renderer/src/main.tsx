import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { PanelPrototype } from './prototype/variants'
import { PanelApp } from './panel/panel-app'
import './styles.css'

const params = new URLSearchParams(window.location.search)

// PROTOTYPE (throwaway): ?variant=a|b|c renders the panel-redesign prototype
// instead of the real panel. Drop this gate when the redesign lands.
const variant = params.get('variant')

// M1 gate: ?panel=v2 renders the new shell while the old panel stays the default,
// so the two can be compared side by side until M5 flips the entry over.
const panelV2 = params.get('panel') === 'v2'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    {variant ? <PanelPrototype initialVariant={variant} /> : panelV2 ? <PanelApp /> : <App />}
  </React.StrictMode>
)
