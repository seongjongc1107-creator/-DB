import { useEffect, useRef, useState, useMemo } from 'react'
import { X, GitCompare, MapPinned, Wind, GripHorizontal, ChevronUp, ChevronDown, Plane, Clock } from 'lucide-react'
import * as turf from '@turf/turf'
import { useApp } from '../AppContext'
import type { FoisOverlayRoute } from '../types'

// FPL 신고 EET("HHMM")를 분 단위로 — 자정 넘김 걱정 없는 순수 소요시간이라
// AirportPanel의 kstToUtc 같은 day-rollover 처리가 필요 없음
function eetToMin(eet: string | null): number | null {
  if (!eet || eet.length !== 4) return null
  const h = parseInt(eet.slice(0, 2), 10)
  const m = parseInt(eet.slice(2), 10)
  if (Number.isNaN(h) || Number.isNaN(m)) return null
  return h * 60 + m
}

function formatEet(eet: string | null): string {
  const min = eetToMin(eet)
  if (min == null) return '—'
  const h = Math.floor(min / 60), m = min % 60
  return h > 0 ? `${h}시간 ${m}분` : `${m}분`
}

export default function FoisRouteComparePanel() {
  const { state, dispatch } = useApp()
  const routes = useMemo(
    () => Object.values(state.foisOverlayRoutes),
    [state.foisOverlayRoutes],
  )
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    setExpanded(false)
  }, [routes.map(r => r.ams_rec_pk).join(',')]) // eslint-disable-line react-hooks/exhaustive-deps

  const [drag, setDrag] = useState({ x: 0, y: 0 })
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null)

  useEffect(() => {
    function handleMove(e: MouseEvent) {
      if (!dragRef.current) return
      const { startX, startY, baseX, baseY } = dragRef.current
      setDrag({ x: baseX + (e.clientX - startX), y: baseY + (e.clientY - startY) })
    }
    function handleUp() {
      dragRef.current = null
    }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
  }, [])

  function startDrag(e: React.MouseEvent) {
    e.preventDefault()
    dragRef.current = { startX: e.clientX, startY: e.clientY, baseX: drag.x, baseY: drag.y }
  }

  const firByRoute = useMemo(() => {
    if (!state.firGeoJSON || routes.length === 0) return [] as string[][]
    return routes.map(r => {
      const hits: string[] = []
      if (r.coordinates.length < 2) return hits
      const line = turf.lineString(r.coordinates)
      for (const fir of state.firGeoJSON!.features) {
        try {
          if (turf.booleanIntersects(line, fir as any)) {
            hits.push((fir.properties?.icao as string) ?? (fir.properties?.name as string))
          }
        } catch {
          // 지오메트리가 비정상인 경우 건너뜀
        }
      }
      return hits
    })
  }, [routes, state.firGeoJSON])

  const typhoonHitByRoute = useMemo(() => {
    if (routes.length === 0 || state.typhoons.length === 0) return [] as string[][]
    return routes.map(r => {
      const hits: string[] = []
      if (r.coordinates.length < 2) return hits
      const line = turf.lineString(r.coordinates)
      for (const t of state.typhoons) {
        try {
          const circle = turf.circle([t.lon, t.lat], t.radius_nm, { steps: 64, units: 'nauticalmiles' })
          if (turf.booleanIntersects(line, circle as any)) hits.push(t.name)
        } catch {
          // 지오메트리가 비정상인 경우 건너뜀
        }
      }
      return hits
    })
  }, [routes, state.typhoons])

  if (routes.length === 0) return null

  const isComparing = routes.length === 2
  const eetDelta = isComparing ? (eetToMin(routes[1].eet) ?? 0) - (eetToMin(routes[0].eet) ?? 0) : 0
  const bothHaveEet = isComparing && eetToMin(routes[0].eet) != null && eetToMin(routes[1].eet) != null

  return (
    <div
      className="absolute top-24 right-[28rem] z-30 w-[360px] max-h-[calc(100vh-7rem)] flex flex-col bg-gray-950/95 backdrop-blur border border-gray-700 rounded-xl shadow-2xl overflow-hidden"
      style={{ transform: `translate(${drag.x}px, ${drag.y}px)` }}
    >
      <div
        onMouseDown={startDrag}
        onClick={() => setExpanded(v => !v)}
        className="flex items-center justify-between gap-2 px-3 py-2.5 border-b border-gray-700 bg-gray-900/80 shrink-0 cursor-grab active:cursor-grabbing select-none"
      >
        <div className="flex items-center gap-1.5 text-xs font-semibold text-white min-w-0">
          <GripHorizontal size={13} className="text-gray-600 shrink-0" />
          <GitCompare size={13} className="shrink-0" />
          <span className="shrink-0">{isComparing ? '실제 항로 비교' : routes.length === 1 ? '실제 항로 정보' : `실제 항로 ${routes.length}개`}</span>
          {!expanded && (
            <span className="text-gray-500 font-normal ml-1 truncate">
              {isComparing
                ? `${formatEet(routes[0].eet)} vs ${formatEet(routes[1].eet)}`
                : routes.length === 1
                  ? `${routes[0].callsign} · ${routes[0].dep} → ${routes[0].arr} · ${formatEet(routes[0].eet)}`
                  : routes.map(r => r.callsign).join(', ')}
              {' — 펼쳐보기'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {expanded ? <ChevronUp size={14} className="text-gray-500" /> : <ChevronDown size={14} className="text-gray-500" />}
          <button
            onMouseDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); dispatch({ type: 'CLEAR_FOIS_OVERLAY_ROUTES' }) }}
            className="text-gray-500 hover:text-gray-300 transition-colors"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {expanded && (
      <div className="overflow-y-auto p-3 space-y-3">
        {/* 신고 비행시간(EET) 비교 — 정확히 2개 오버레이했을 때만 */}
        {isComparing && bothHaveEet && (
          <div className="bg-gray-900/60 border border-gray-700 rounded-lg p-2.5">
            <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-1.5">신고 비행시간 (EET)</div>
            <div className="flex items-center justify-between text-xs">
              <span style={{ color: routes[0].color }} className="font-bold">{formatEet(routes[0].eet)}</span>
              <span className="text-gray-600">vs</span>
              <span style={{ color: routes[1].color }} className="font-bold">{formatEet(routes[1].eet)}</span>
            </div>
            {eetDelta !== 0 && (
              <div className="text-center text-[11px] text-gray-400 mt-1">
                차이 {Math.abs(eetDelta)}분
                {' '}({eetDelta > 0
                  ? <span style={{ color: routes[0].color }}>{routes[0].callsign}이(가) 더 빠름</span>
                  : <span style={{ color: routes[1].color }}>{routes[1].callsign}이(가) 더 빠름</span>})
              </div>
            )}
          </div>
        )}

        {/* 편별 상세 */}
        {routes.map((r: FoisOverlayRoute, i) => {
          const c = r.color
          return (
            <div
              key={r.ams_rec_pk}
              className="rounded-lg border p-2.5"
              style={{ borderColor: c + '80', backgroundColor: c + '0f' }}
            >
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-bold" style={{ color: c }}>
                  {r.callsign} · {r.dep} → {r.arr}
                </span>
                <span className="text-[10px] text-gray-500 flex items-center gap-1">
                  <Clock size={10} /> {formatEet(r.eet)}
                </span>
              </div>

              {r.ac_type && (
                <div className="flex items-center gap-1.5 mb-1.5">
                  <Plane size={11} className="text-gray-500 shrink-0" />
                  <span className="text-[10px] text-gray-400">{r.ac_type}</span>
                </div>
              )}

              {r.route && (
                <div className="text-[11px] text-gray-300 leading-relaxed break-all font-mono mb-2">
                  {r.route}
                </div>
              )}

              <div className="flex items-start gap-1.5 mb-1.5">
                <MapPinned size={11} className="text-gray-500 mt-0.5 shrink-0" />
                <div className="flex flex-wrap gap-1">
                  {(firByRoute[i] ?? []).length === 0 ? (
                    <span className="text-[10px] text-gray-600">통과 FIR 없음</span>
                  ) : firByRoute[i].map(name => (
                    <span
                      key={name}
                      className="text-[10px] px-1.5 py-0.5 rounded bg-gray-800 text-gray-300 border border-gray-700"
                    >
                      {name}
                    </span>
                  ))}
                </div>
              </div>

              <div className="flex items-start gap-1.5">
                <Wind size={11} className="text-gray-500 mt-0.5 shrink-0" />
                {state.typhoons.length === 0 ? (
                  <span className="text-[10px] text-gray-600">활성 태풍 없음</span>
                ) : (typhoonHitByRoute[i] ?? []).length === 0 ? (
                  <span className="text-[10px] text-gray-600">태풍 영향권 밖</span>
                ) : (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-900/40 text-red-300 border border-red-700 font-semibold">
                    ⚠ {typhoonHitByRoute[i].join(', ')} 반경 통과
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>
      )}
    </div>
  )
}
