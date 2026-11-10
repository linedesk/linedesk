import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import './styles.css'
import './app.css'
import { installTooltips } from './ui/tooltips.ts'

installTooltips()

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
