import { createRoot } from 'react-dom/client'
import { warmMic } from '../lib/mic'
import { App } from './app'
import './overlay.css'

const root = document.getElementById('root')
if (root) createRoot(root).render(<App />)
void window.api
  .getSettings()
  .then((settings) => warmMic(settings.micDevice))
  .catch(() => warmMic())
