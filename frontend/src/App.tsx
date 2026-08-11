import { useEffect, useMemo, useState } from 'react'
import { FileText, SlidersHorizontal, BarChart3 } from 'lucide-react'
import { api } from './api/client'
import { useApp } from './AppContext'
import { useWeatherMonitor } from './hooks/useWeatherMonitor'
import Sidebar from './components/Sidebar'
import MapView from './components/MapView'
import RightPanel from './components/RightPanel'
import RouteComparePanel from './components/RouteComparePanel'
import FoisRouteComparePanel from './components/FoisRouteComparePanel'
import WeatherAlertToast from './components/WeatherAlertToast'
import AirportPanel from './components/AirportPanel'
import CurfewPanel from './components/CurfewPanel'
import WeatherThresholdModal from './components/WeatherThresholdModal'
import AirportMinimumsTable from './components/AirportMinimumsTable'
import AdHocRouteInput from './components/AdHocRouteInput'
import FlightFilingStatsPage from './components/FlightFilingStatsPage'
import PermitApp from './permits/PermitApp'

export default function App() {
  const { state, dispatch } = useApp()
  const [permitMode, setPermitMode] = useState(false)
  const [filingStatsMode, setFilingStatsMode] = useState(false)
  const [minimumsOpen, setMinimumsOpen] = useState(false)

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
        // Load persisted curfew data
        api.curfew.list().then(res => {
          if (res.curfews.length > 0) dispatch({ type: 'SET_CURFEWS', payload: res.curfews })
        }).catch(() => {})
      } catch (e) {
        console.error('Failed to load initial data', e)
      } finally {
        dispatch({ type: 'SET_LOADING', payload: false })
      }
    }
    init()
  }, [dispatch])

  // Extract ICAO list from loaded airports for weather monitoring
  const airportIcaos = useMemo(() => {
    if (!state.airportsGeoJSON) return []
    return state.airportsGeoJSON.features
      .map(f => f.properties?.id as string)
      .filter(Boolean)
  }, [state.airportsGeoJSON])

  useWeatherMonitor(airportIcaos)

  // Count configured airports for button badge
  const configuredCount = Object.keys(state.weatherConfig.airports).length

  if (permitMode) {
    return <PermitApp onExit={() => setPermitMode(false)} />
  }

  return (
    <div className="flex h-screen w-screen bg-gray-950 overflow-hidden">
      <Sidebar />
      <main className="flex-1 relative">
        <MapView />
        <RightPanel />
        <RouteComparePanel />
        <FoisRouteComparePanel />
        <AirportPanel />
        <CurfewPanel />
        <WeatherThresholdModal />
        {minimumsOpen && <AirportMinimumsTable onClose={() => setMinimumsOpen(false)} />}

        {/* Top-right stack: 항로 입력 위, 날씨 알림 아래 — 같은 자리 겹침 방지 */}
        <div className="absolute top-4 right-4 z-40 flex flex-col items-end gap-2">
          <AdHocRouteInput />
          <WeatherAlertToast />
        </div>

        {/* Top-left action buttons */}
        <div className="absolute top-4 left-4 z-20 flex items-center gap-2">
          <button
            onClick={() => setPermitMode(true)}
            className="flex items-center gap-1.5 bg-gray-900/90 hover:bg-gray-800 border border-gray-700 hover:border-blue-600 text-gray-400 hover:text-blue-400 text-xs font-semibold px-3 py-2 rounded-lg transition-all shadow-lg backdrop-blur"
          >
            <FileText size={12} />
            허가 관리
          </button>
          <button
            onClick={() => setFilingStatsMode(true)}
            className="flex items-center gap-1.5 bg-gray-900/90 hover:bg-gray-800 border border-gray-700 hover:border-cyan-600 text-gray-400 hover:text-cyan-400 text-xs font-semibold px-3 py-2 rounded-lg transition-all shadow-lg backdrop-blur"
          >
            <BarChart3 size={12} />
            항로 실적
          </button>
          <button
            onClick={() => setMinimumsOpen(true)}
            className="relative flex items-center gap-1.5 bg-gray-900/90 hover:bg-gray-800 border border-gray-700 hover:border-amber-600 text-gray-400 hover:text-amber-400 text-xs font-semibold px-3 py-2 rounded-lg transition-all shadow-lg backdrop-blur"
          >
            <SlidersHorizontal size={12} />
            공항 최저치
            {configuredCount > 0 && (
              <span className="ml-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-blue-700 text-white">
                {configuredCount}
              </span>
            )}
          </button>
        </div>
      </main>
      {filingStatsMode && <FlightFilingStatsPage onClose={() => setFilingStatsMode(false)} />}
    </div>
  )
}
