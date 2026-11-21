import { createRoot } from 'react-dom/client'
import { BoardApp } from './board-app'
import './board.css'

const root = document.getElementById('root')
if (root) createRoot(root).render(<BoardApp />)
