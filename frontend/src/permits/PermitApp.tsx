import { useState } from 'react'
import type { CountryPermit, DummyFlight, PermitApplication } from './types'
import { DUMMY_FLIGHTS } from './dummyData'
import PermitSidebar from './PermitSidebar'
import PermitMap from './PermitMap'
import ApplicationPanel from './ApplicationPanel'

interface Props {
  onExit: () => void
}

export default function PermitApp({ onExit }: Props) {
  const [flightInput, setFlightInput] = useState('')
  const [season, setSeason] = useState('S26')
  const [activeFlight, setActiveFlight] = useState<DummyFlight | null>(null)
  const [notFoundError, setNotFoundError] = useState(false)
  const [selectedRouteIdx, setSelectedRouteIdx] = useState(0)
  const [appPanelCountry, setAppPanelCountry] = useState<CountryPermit | null>(null)
  const [savedApps, setSavedApps] = useState<PermitApplication[]>([])
  const [highlightedCountry, setHighlightedCountry] = useState<string | null>(null)
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'info' } | null>(null)

  function handleSearch() {
    const key = flightInput.trim().toUpperCase()
    const data = DUMMY_FLIGHTS[key]
    if (data) {
      setActiveFlight(data)
      setSelectedRouteIdx(0)
      setNotFoundError(false)
      setAppPanelCountry(null)
      setHighlightedCountry(null)
    } else {
      setNotFoundError(true)
      setActiveFlight(null)
    }
  }

  function handleSelectRoute(idx: number) {
    setSelectedRouteIdx(idx)
    setHighlightedCountry(null)
    setAppPanelCountry(null)
  }

  function handleSaveApp(app: PermitApplication) {
    setSavedApps(prev => {
      const idx = prev.findIndex(a =>
        a.flightNumber === app.flightNumber &&
        a.routeNumber === app.routeNumber &&
        a.countryCode === app.countryCode,
      )
      if (idx >= 0) {
        const next = [...prev]
        next[idx] = app
        return next
      }
      return [...prev, app]
    })
    setAppPanelCountry(null)
    showToast(
      app.status === 'submitted' ? '신청서가 제출되었습니다' : '임시저장되었습니다',
      app.status === 'submitted' ? 'success' : 'info',
    )
  }

  function showToast(msg: string, type: 'success' | 'info' = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  const selectedRoute = activeFlight?.routes[selectedRouteIdx] ?? null

  return (
    <div className="flex h-screen w-screen bg-gray-950 overflow-hidden">
      <PermitSidebar
        flightInput={flightInput}
        setFlightInput={setFlightInput}
        season={season}
        setSeason={setSeason}
        onSearch={handleSearch}
        flight={activeFlight}
        notFoundError={notFoundError}
        selectedRouteIdx={selectedRouteIdx}
        onSelectRoute={handleSelectRoute}
        highlightedCountry={highlightedCountry}
        onHighlightCountry={setHighlightedCountry}
        onOpenApp={setAppPanelCountry}
        savedApps={savedApps}
        onExit={onExit}
      />

      <main className="flex-1 relative overflow-hidden">
        <PermitMap
          flight={activeFlight}
          selectedRouteIdx={selectedRouteIdx}
          highlightedCountry={highlightedCountry}
          onHighlightCountry={setHighlightedCountry}
          onOpenApp={setAppPanelCountry}
        />

        {appPanelCountry && activeFlight && selectedRoute && (
          <ApplicationPanel
            country={appPanelCountry}
            flight={activeFlight}
            routeNumber={selectedRoute.routeNumber}
            season={season}
            onClose={() => setAppPanelCountry(null)}
            onSave={handleSaveApp}
          />
        )}
      </main>

      {toast && (
        <div className={`fixed top-5 right-5 z-50 flex items-center gap-2 px-4 py-2.5 rounded-lg shadow-xl text-sm font-medium border transition-all ${
          toast.type === 'success'
            ? 'bg-emerald-900 border-emerald-700 text-emerald-200'
            : 'bg-gray-800 border-gray-700 text-gray-300'
        }`}>
          {toast.type === 'success' ? '✓' : 'ℹ'} {toast.msg}
        </div>
      )}
    </div>
  )
}
