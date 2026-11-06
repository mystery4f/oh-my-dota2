import React from 'react'
import ReactDOM from 'react-dom/client'
import { PanelApp } from './panel/panel-app'
import './styles.css'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <PanelApp />
  </React.StrictMode>
)
