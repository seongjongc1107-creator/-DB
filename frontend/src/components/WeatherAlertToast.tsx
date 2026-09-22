import { useMemo } from 'react'
import * as turf from '@turf/turf'
import { X, AlertTriangle, AlertOctagon } from 'lucide-react'
import { useApp } from '../AppContext'
import type { WeatherLevel } from '../types'

const LEVEL_STYLE: Record<WeatherLevel, { border: string; bg: string; icon: string; label: string }> = {
  1: { border: 'border-green-500',  bg: 'bg-green-950/90',  icon: 'text-green-400',  label: '양호'   },
  2: { border: 'border-amber-400',  bg: 'bg-amber-950/90',  icon: 'text-amber-400',  label: '주의I'  },
  3: { border: 'border-orange-500', bg: 'bg-orange-950/90', icon: 'text-orange-400', label: '주의II' },
  4: { border: 'border-red-500',    bg: 'bg-red-950/90',    icon: 'text-red-400',    label: '경고'   },
}

export default function WeatherAlertToast() {
  const { state, dispatch } = useApp()
  const typhoonOnly = state.weatherAlertTyphoonOnly

  // 공항 ICAO → 좌표 (태풍 반경 교차 판정용)
  const airportCoord = useMemo(() => {
    const m = new Map<string, [number, number]>()
    for (const f of state.airportsGeoJSON?.features ?? []) {
      const icao = f.properties?.id as string | undefined
      const coords = f.geometry?.coordinates as [number, number] | undefined
      if (icao && coords) m.set(icao, coords)
    }
    return m
  }, [state.airportsGeoJSON])

  const typhoonCircles = useMemo(() => {
    return state.typhoons.map(t => turf.circle([t.lon, t.lat], t.radius_nm, { steps: 64, units: 'nauticalmiles' }))
  }, [state.typhoons])

  const inTyphoonZone = useMemo(() => {
    const set = new Set<string>()
    if (typhoonCircles.length === 0) return set
    for (const [icao, coord] of airportCoord) {
      const pt = turf.point(coord)
      if (typhoonCircles.some(c => turf.booleanPointInPolygon(pt, c))) set.add(icao)
    }
    return set
  }, [airportCoord, typhoonCircles])

  const activeAirportSet = useMemo(() => new Set(state.activeFoisAirports), [state.activeFoisAirports])

  const alerts = useMemo(() => {
    const base = typhoonOnly
      ? state.weatherAlerts.filter(a => inTyphoonZone.has(a.icao))
      : state.weatherAlerts
    // 최근 30일 FOIS 제출 이력에 실제 등장한(=지금 우리가 실제로 쓰는) 공항의
    // 알림을 위로 — 모니터링 대상 자체를 좁히는 게 아니라 정렬/강조만 바꿈
    // (신규 취항 공항도 여기 없다고 알림이 빠지는 게 아니라 그냥 강조만 덜 될 뿐).
    // .sort는 안정 정렬(stable)이라 각 그룹 내부의 기존 순서(최신순)는 유지됨.
    return [...base].sort((a, b) => {
      const aActive = activeAirportSet.has(a.icao) ? 0 : 1
      const bActive = activeAirportSet.has(b.icao) ? 0 : 1
      return aActive - bActive
    })
  }, [state.weatherAlerts, typhoonOnly, inTyphoonZone, activeAirportSet])

  function dismiss(id: string) {
    dispatch({ type: 'DISMISS_WEATHER_ALERT', payload: id })
  }

  function dismissAll() {
    alerts.forEach(a => dispatch({ type: 'DISMISS_WEATHER_ALERT', payload: a.id }))
  }

  function toggleTyphoonOnly() {
    dispatch({ type: 'SET_WEATHER_ALERT_TYPHOON_ONLY', payload: !typhoonOnly })
  }

  if (!state.layers.weatherAlerts) return null
  if (alerts.length === 0 && !typhoonOnly) return null

  return (
    <div className="flex flex-col w-80 pointer-events-none min-h-0" style={{ maxHeight: 'calc(100vh - 6rem)' }}>
      {/* 헤더 */}
      <div className="pointer-events-auto flex items-center justify-between px-1 pb-1 shrink-0 gap-2">
        <span className="text-[10px] text-gray-500 shrink-0">{alerts.length}개 알림</span>
        <button
          onClick={toggleTyphoonOnly}
          title="태풍 반경과 겹치는 공항의 알림만 표출"
          className="flex items-center gap-1.5 text-[10px] shrink-0"
        >
          <span className={typhoonOnly ? 'text-amber-400' : 'text-gray-500'}>태풍 구역만</span>
          <div className={`w-6 h-3.5 rounded-full transition-colors relative ${typhoonOnly ? 'bg-amber-600' : 'bg-gray-700'}`}>
            <div className={`absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white transition-transform ${typhoonOnly ? 'translate-x-3' : 'translate-x-0.5'}`} />
          </div>
        </button>
        {alerts.length > 1 && (
          <button
            onClick={dismissAll}
            className="text-[10px] text-gray-500 hover:text-gray-300 underline ml-auto shrink-0"
          >
            모두 닫기
          </button>
        )}
      </div>
      {/* 스크롤 영역 */}
      <div className="pointer-events-auto overflow-y-auto flex flex-col gap-2 pr-1" style={{ scrollbarWidth: 'thin' }}>
        {alerts.map(alert => {
          const s = LEVEL_STYLE[alert.level]
          const Icon = alert.level === 4 ? AlertOctagon : AlertTriangle
          const isActive = activeAirportSet.has(alert.icao)
          return (
            <div
              key={alert.id}
              className={`flex items-start gap-3 rounded-xl border ${s.border} ${s.bg} px-3.5 py-3 shadow-2xl backdrop-blur animate-in slide-in-from-right-4 duration-300 shrink-0 ${isActive ? 'ring-1 ring-sky-400/70' : ''}`}
            >
              <Icon size={16} className={`${s.icon} mt-0.5 shrink-0`} />
              <div className="flex-1 min-w-0">
                <div className={`text-xs font-bold ${s.icon} flex items-center gap-1.5`}>
                  <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-bold border ${s.border} ${s.icon}`}>
                    {s.label}
                  </span>
                  {isActive && (
                    <span
                      className="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold border border-sky-400 text-sky-300"
                      title="최근 30일 FOIS 제출 이력에 실제 등장한 공항"
                    >
                      실사용
                    </span>
                  )}
                  <span className="text-gray-400 font-normal">{alert.time}</span>
                </div>
                <p className="text-xs text-gray-200 mt-1 leading-snug break-all">{alert.message}</p>
              </div>
              <button
                onClick={() => dismiss(alert.id)}
                className="text-gray-600 hover:text-gray-300 shrink-0 mt-0.5"
              >
                <X size={13} />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
