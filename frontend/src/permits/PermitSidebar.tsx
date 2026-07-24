import { useState } from 'react'
import { Search, ArrowLeft, Plane, AlertTriangle, CheckCircle2, Clock, FileText, ChevronRight } from 'lucide-react'
import type { DummyFlight, RouteOption, CountryPermit, PermitApplication } from './types'
import { DUMMY_FLIGHTS, SEASONS } from './dummyData'

interface Props {
  flightInput: string
  setFlightInput: (v: string) => void
  season: string
  setSeason: (v: string) => void
  onSearch: () => void
  flight: DummyFlight | null
  notFoundError: boolean
  selectedRouteIdx: number
  onSelectRoute: (idx: number) => void
  highlightedCountry: string | null
  onHighlightCountry: (code: string | null) => void
  onOpenApp: (country: CountryPermit) => void
  savedApps: PermitApplication[]
  onExit: () => void
}

const STATUS_COLORS = {
  valid:    '#10B981',
  expiring: '#F59E0B',
  not_held: '#EF4444',
} as const

const STATUS_STYLES = {
  valid:    { text: 'text-emerald-400', bg: 'bg-emerald-900/40', border: 'border-emerald-800', label: '유효',     icon: CheckCircle2 },
  expiring: { text: 'text-amber-400',   bg: 'bg-amber-900/40',   border: 'border-amber-800',   label: '만료임박', icon: AlertTriangle },
  not_held: { text: 'text-red-400',     bg: 'bg-red-900/40',     border: 'border-red-800',     label: '미보유',   icon: AlertTriangle },
}

function getRouteHealth(route: RouteOption): 'clear' | 'warning' | 'blocked' {
  if (route.permits.some(p => p.status === 'not_held')) return 'blocked'
  if (route.permits.some(p => p.status === 'expiring')) return 'warning'
  return 'clear'
}

const HEALTH_STYLES = {
  clear:   { label: '운항가능', text: 'text-emerald-400', bg: 'bg-emerald-900/40 border-emerald-800' },
  warning: { label: '주의',     text: 'text-amber-400',   bg: 'bg-amber-900/40 border-amber-800' },
  blocked: { label: '차단',     text: 'text-red-400',     bg: 'bg-red-900/40 border-red-800' },
}

export default function PermitSidebar({
  flightInput, setFlightInput, season, setSeason,
  onSearch, flight, notFoundError,
  selectedRouteIdx, onSelectRoute,
  highlightedCountry, onHighlightCountry, onOpenApp,
  savedApps, onExit,
}: Props) {
  const [showSavedPreview, setShowSavedPreview] = useState(false)
  const seasonInfo = SEASONS[season]

  const selectedRoute = flight?.routes[selectedRouteIdx] ?? null

  const summary = selectedRoute ? {
    total: selectedRoute.permits.length,
    valid: selectedRoute.permits.filter(p => p.status === 'valid').length,
    expiring: selectedRoute.permits.filter(p => p.status === 'expiring').length,
    not_held: selectedRoute.permits.filter(p => p.status === 'not_held').length,
  } : null

  function getSavedApp(countryCode: string) {
    if (!flight || !selectedRoute) return undefined
    return savedApps
      .filter(a =>
        a.flightNumber === flight.info.flightNumber &&
        a.routeNumber === selectedRoute.routeNumber &&
        a.countryCode === countryCode,
      )
      .slice(-1)[0]
  }

  return (
    <aside className="w-80 shrink-0 bg-gray-950 border-r border-gray-800 flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-4 pt-4 pb-3 border-b border-gray-800 shrink-0">
        <button
          onClick={onExit}
          className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-white transition-colors mb-3"
        >
          <ArrowLeft size={12} /> 항로 조회로 돌아가기
        </button>
        <div className="flex items-center gap-2">
          <FileText size={15} className="text-blue-400" />
          <span className="text-white font-bold text-sm">영공통과 허가 관리</span>
        </div>
        <p className="text-gray-600 text-xs mt-0.5">편명 기반 허가 현황 조회 및 신청</p>
      </div>

      {/* Search form */}
      <div className="px-4 py-3 border-b border-gray-800 shrink-0 space-y-2">
        <div className="flex gap-2">
          <input
            className="flex-1 bg-gray-800 border border-gray-700 text-white text-xs rounded px-3 py-2 outline-none focus:border-blue-500 uppercase placeholder:normal-case placeholder:text-gray-600"
            placeholder="편명 입력 (예: KE901)"
            value={flightInput}
            onChange={e => setFlightInput(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === 'Enter' && onSearch()}
          />
          <button
            onClick={onSearch}
            className="bg-blue-600 hover:bg-blue-500 text-white px-3 rounded text-xs font-semibold transition-colors flex items-center gap-1"
          >
            <Search size={12} /> 조회
          </button>
        </div>
        <select
          className="w-full bg-gray-800 border border-gray-700 text-gray-300 text-xs rounded px-2.5 py-2 outline-none"
          value={season}
          onChange={e => setSeason(e.target.value)}
        >
          {Object.entries(SEASONS).map(([key, s]) => (
            <option key={key} value={key}>{key} — {s.label} ({s.from}~{s.to})</option>
          ))}
        </select>
        <div className="flex flex-wrap gap-1">
          {Object.keys(DUMMY_FLIGHTS).map(fn => (
            <button
              key={fn}
              onClick={() => setFlightInput(fn)}
              className="text-[10px] px-2 py-0.5 rounded bg-gray-800 text-gray-500 hover:text-blue-400 hover:bg-gray-700 transition-colors border border-gray-700"
            >
              {fn}
            </button>
          ))}
        </div>
        {notFoundError && (
          <div className="text-xs text-red-400 bg-red-900/20 border border-red-800/50 rounded px-2.5 py-1.5">
            편명을 찾을 수 없습니다.
          </div>
        )}
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {!flight ? (
          <div className="text-xs text-gray-600 text-center py-8">
            편명을 조회하면<br />항로별 허가 현황이 표시됩니다
          </div>
        ) : (
          <>
            {/* Flight info card */}
            <div className="px-4 pt-3 pb-2">
              <div className="bg-gray-900 rounded-lg px-3 py-2.5 border border-gray-800">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Plane size={13} className="text-sky-400" />
                    <span className="text-white font-bold text-sm">{flight.info.flightNumber}</span>
                    <span className="text-gray-500 text-xs">{seasonInfo.label}</span>
                  </div>
                  <span className="text-gray-500 text-xs">{flight.info.aircraftType}</span>
                </div>
                <div className="mt-1.5 text-xs text-gray-300">
                  {flight.info.origin} → {flight.info.destination}
                </div>
                <div className="text-[11px] text-gray-500 mt-0.5">
                  {flight.info.airline} · 출발 {flight.info.depTimeUtc} UTC
                </div>
              </div>
            </div>

            {/* Route comparison cards */}
            <div className="px-4 pb-2">
              <div className="text-[10px] text-gray-500 uppercase tracking-widest font-semibold mb-2">
                대체항로 비교 ({flight.routes.length}개)
              </div>
              <div className="space-y-1.5">
                {flight.routes.map((route, idx) => {
                  const health = getRouteHealth(route)
                  const hs = HEALTH_STYLES[health]
                  const isSelected = idx === selectedRouteIdx
                  return (
                    <button
                      key={route.routeNumber}
                      onClick={() => onSelectRoute(idx)}
                      className={`w-full text-left rounded-lg border p-2.5 transition-all ${
                        isSelected
                          ? 'border-sky-500 bg-sky-950/50 shadow-[0_0_0_1px_rgba(56,189,248,0.2)]'
                          : 'border-gray-700 bg-gray-900 hover:border-gray-600 hover:bg-gray-800/60'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={`text-[10px] font-bold shrink-0 ${isSelected ? 'text-sky-400' : 'text-gray-500'}`}>
                            Route {route.routeNumber}
                          </span>
                          <span className={`text-xs font-medium truncate ${isSelected ? 'text-white' : 'text-gray-300'}`}>
                            {route.routeName}
                          </span>
                          <span className="text-[10px] text-gray-600 shrink-0">
                            {route.distance.toLocaleString()} NM
                          </span>
                        </div>
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border shrink-0 ml-1 ${hs.text} ${hs.bg}`}>
                          {hs.label}
                        </span>
                      </div>
                      {/* Country status dots */}
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {route.permits.map(p => (
                          <div key={p.countryCode} className="flex items-center gap-0.5" title={`${p.countryName}: ${STATUS_STYLES[p.status].label}`}>
                            <span
                              className="w-2 h-2 rounded-full shrink-0"
                              style={{ backgroundColor: STATUS_COLORS[p.status] }}
                            />
                            <span className={`text-[9px] font-mono ${isSelected ? 'text-gray-400' : 'text-gray-600'}`}>
                              {p.countryCode}
                            </span>
                          </div>
                        ))}
                        {isSelected && (
                          <ChevronRight size={10} className="text-sky-500 ml-auto" />
                        )}
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Divider: selected route detail */}
            {selectedRoute && (
              <div className="px-4 pb-1">
                <div className="flex items-center gap-2 py-2 border-t border-gray-800 mt-1">
                  <span className="text-[10px] text-gray-500 uppercase tracking-widest font-semibold">
                    Route {selectedRoute.routeNumber} 허가 현황
                  </span>
                  {summary && (
                    <div className="flex items-center gap-1.5 ml-auto">
                      {summary.valid > 0 && <span className="text-[10px] text-emerald-500">✓{summary.valid}</span>}
                      {summary.expiring > 0 && <span className="text-[10px] text-amber-500">⚠{summary.expiring}</span>}
                      {summary.not_held > 0 && <span className="text-[10px] text-red-500">✕{summary.not_held}</span>}
                    </div>
                  )}
                </div>

                {/* Permit list */}
                <div className="space-y-2">
                  {selectedRoute.permits.map(permit => {
                    const style = STATUS_STYLES[permit.status]
                    const Icon = style.icon
                    const isHighlighted = highlightedCountry === permit.countryCode
                    const savedApp = getSavedApp(permit.countryCode)

                    return (
                      <div
                        key={permit.countryCode}
                        className={`rounded-lg border transition-all ${style.bg} ${style.border} ${
                          isHighlighted ? 'ring-1 ring-white/20 scale-[1.01]' : ''
                        }`}
                        onMouseEnter={() => onHighlightCountry(permit.countryCode)}
                        onMouseLeave={() => onHighlightCountry(null)}
                      >
                        <div className="px-3 py-2.5">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <span className="text-base leading-none">{permit.flag}</span>
                              <span className="text-white text-xs font-semibold">{permit.countryName}</span>
                              <span className="text-gray-600 text-[10px]">{permit.countryCode}</span>
                            </div>
                            <div className={`flex items-center gap-1 text-[11px] font-semibold ${style.text}`}>
                              <Icon size={10} />
                              {style.label}
                            </div>
                          </div>

                          {(permit.status === 'valid' || permit.status === 'expiring') && (
                            <div className="mt-1.5 text-[11px] text-gray-500 space-y-0.5">
                              <div className="flex items-center gap-1">
                                <Clock size={9} />
                                {permit.permitType} · ~{permit.validTo}
                                {permit.status === 'expiring' && (
                                  <span className="text-amber-500 font-semibold ml-1">⚠ 갱신 필요</span>
                                )}
                              </div>
                              {permit.entryFix && (
                                <div className="text-gray-600">
                                  {permit.entryFix} → {permit.exitFix} · {permit.cruiseLevel}
                                </div>
                              )}
                            </div>
                          )}

                          {permit.status === 'not_held' && (
                            <div className="mt-2">
                              {savedApp ? (
                                <div className={`flex items-center justify-between text-[11px] px-2 py-1 rounded ${
                                  savedApp.status === 'submitted'
                                    ? 'bg-blue-900/40 text-blue-400 border border-blue-800'
                                    : 'bg-gray-800 text-gray-400 border border-gray-700'
                                }`}>
                                  <span>{savedApp.status === 'submitted' ? '✓ 신청 완료' : '📝 임시저장'}</span>
                                  <button onClick={() => onOpenApp(permit)} className="text-gray-500 hover:text-white">수정</button>
                                </div>
                              ) : (
                                <button
                                  onClick={() => onOpenApp(permit)}
                                  className="w-full text-xs py-1.5 rounded bg-red-900/50 hover:bg-red-900/80 text-red-300 border border-red-800 transition-colors font-medium"
                                >
                                  + 신청서 작성
                                </button>
                              )}
                            </div>
                          )}

                          {permit.status === 'expiring' && (
                            <div className="mt-2">
                              <button
                                onClick={() => onOpenApp(permit)}
                                className="w-full text-xs py-1.5 rounded bg-amber-900/40 hover:bg-amber-900/60 text-amber-300 border border-amber-800 transition-colors font-medium"
                              >
                                갱신 신청서 작성
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Saved apps footer */}
      {savedApps.length > 0 && (
        <div className="px-4 py-2 border-t border-gray-800 shrink-0">
          <button
            onClick={() => setShowSavedPreview(v => !v)}
            className="w-full flex items-center justify-between text-xs text-gray-500 hover:text-gray-300 transition-colors"
          >
            <span>저장된 신청서 {savedApps.length}건</span>
            <span>{showSavedPreview ? '▲' : '▼'}</span>
          </button>
          {showSavedPreview && (
            <div className="mt-2 space-y-1">
              {savedApps.map(app => (
                <div key={app.id} className="flex items-center justify-between text-[11px] px-2 py-1 bg-gray-900 rounded border border-gray-800">
                  <span className="text-gray-400">{app.flightNumber} R{app.routeNumber} · {app.countryName}</span>
                  <span className={app.status === 'submitted' ? 'text-blue-400' : 'text-gray-600'}>
                    {app.status === 'submitted' ? '제출됨' : '초안'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </aside>
  )
}
