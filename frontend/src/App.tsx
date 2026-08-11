import { useEffect, useMemo, useState } from 'react'
import { BarChart3, Settings } from 'lucide-react'
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
import AdminPage from './components/AdminPage'
import PermitApp from './permits/PermitApp'
import { setAirportMinimaSeed } from './lib/airportMinimaSeed'

export default function App() {
  const { state, dispatch } = useApp()
  const [permitMode, setPermitMode] = useState(false)
  const [filingStatsMode, setFilingStatsMode] = useState(false)
  const [minimumsOpen, setMinimumsOpen] = useState(false)
  const [adminOpen, setAdminOpen] = useState(false)

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
        // 공항별 기상 임계값 기본값 — 관리자가 WX_Minima.csv를 새로 올려도
        // 재빌드 없이 반영되도록 런타임에 받아옴
        api.weather.minimaSeed().then(setAirportMinimaSeed).catch(() => {})
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
        {adminOpen && <AdminPage onClose={() => setAdminOpen(false)} />}

        {/* Top-right stack: 항로 입력+관리자 톱니바퀴 한 줄(톱니바퀴 맨 오른쪽), 그 아래 날씨 알림 */}
        <div className="absolute top-4 right-4 z-40 flex flex-col items-end gap-2">
          <div className="flex items-center gap-2">
            <AdHocRouteInput />
            <button
              onClick={() => setAdminOpen(true)}
              title="관리자"
              className="flex items-center justify-center w-8 h-8 bg-gray-900/90 hover:bg-gray-800 border border-gray-700 hover:border-emerald-600 text-gray-400 hover:text-emerald-400 rounded-lg transition-all shadow-lg backdrop-blur shrink-0"
            >
              <Settings size={14} />
            </button>
          </div>
          <WeatherAlertToast />
        </div>

        {/* Top-left action buttons */}
        <div className="absolute top-4 left-4 z-20 flex items-center gap-2">
          <button
            onClick={() => setFilingStatsMode(true)}
            className="flex items-center gap-1.5 bg-gray-900/90 hover:bg-gray-800 border border-gray-700 hover:border-cyan-600 text-gray-400 hover:text-cyan-400 text-xs font-semibold px-3 py-2 rounded-lg transition-all shadow-lg backdrop-blur"
          >
            <BarChart3 size={12} />
            항로 실적
          </button>
        </div>
      </main>
      {filingStatsMode && <FlightFilingStatsPage onClose={() => setFilingStatsMode(false)} />}
    </div>
  )
}
