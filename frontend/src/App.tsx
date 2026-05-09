import { useEffect } from 'react'
import { api } from './api/client'
import { useApp } from './AppContext'
import Sidebar from './components/Sidebar'
import MapView from './components/MapView'
import RightPanel from './components/RightPanel'

export default function App() {
  const { dispatch } = useApp()

  // Initial data load
  useEffect(() => {
    async function init() {
      dispatch({ type: 'SET_LOADING', payload: true })
      try {
        const [airportsGeoJSON, routeList, routeGeoJSON, firGeoJSON] = await Promise.all([
          api.navdata.airports(),
          api.routes.list(),
          api.routes.geometry(),
          api.navdata.fir(),
        ])
        dispatch({ type: 'SET_AIRPORTS_GEOJSON', payload: airportsGeoJSON })
        dispatch({ type: 'SET_ALL_ROUTES', payload: routeList.routes })
        dispatch({ type: 'SET_ROUTE_GEOJSON', payload: routeGeoJSON })
        dispatch({ type: 'SET_FIR_GEOJSON', payload: firGeoJSON })
      } catch (e) {
        console.error('Failed to load initial data', e)
      } finally {
        dispatch({ type: 'SET_LOADING', payload: false })
      }
    }
    init()
  }, [dispatch])

  return (
    <div className="flex h-screen w-screen bg-gray-950 overflow-hidden">
      <Sidebar />
      <main className="flex-1 relative">
        <MapView />
        <RightPanel />
      </main>
    </div>
  )
}
