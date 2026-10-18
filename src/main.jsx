import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import RoadWeather from './RoadWeather'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <main className="min-h-screen bg-slate-600 text-white">
      <RoadWeather />
    </main>
  </StrictMode>,
)
