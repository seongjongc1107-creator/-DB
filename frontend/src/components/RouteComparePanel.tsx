import { useEffect, useMemo, useRef, useState } from 'react'
import { X, GitCompare, MapPinned, Wind, GripHorizontal, ChevronUp, ChevronDown, StickyNote } from 'lucide-react'
import * as turf from '@turf/turf'
import { useApp } from '../AppContext'
import { api } from '../api/client'
import { SELECT_COLORS } from '../lib/selectionColors'
import type { GeoJSONFeature, RouteMeta } from '../types'

// 선택 순서별 색 (사이드바/지도와 동일 팔레트 공유)
const colorAt = (i: number) => SELECT_COLORS[i % SELECT_COLORS.length]

export default function RouteComparePanel() {
  const { state, dispatch } = useApp()
  const ids = state.selectedRouteIds
  const [features, setFeatures] = useState<GeoJSONFeature[]>([])
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState(false)

  // 새로 2개가 선택될 때마다 접힌 상태로 시작 — 화면을 계속 잡아먹지 않게
  useEffect(() => {
    setExpanded(false)
  }, [ids.join(',')]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── 드래그로 패널 위치 옮기기 ──────────────────────────────────
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

  useEffect(() => {
    if (ids.length === 0) {
      setFeatures([])
      return
    }
    setLoading(true)
    api.routes.geometry({ ids: ids.join(',') })
      .then(fc => setFeatures(fc.features))
      .catch(() => setFeatures([]))
      .finally(() => setLoading(false))
    // ids 배열 참조가 매 렌더 바뀌므로 join 값으로 비교
  }, [ids.join(',')]) // eslint-disable-line react-hooks/exhaustive-deps

  // API 응답 순서와 무관하게 선택 순서(ids)에 맞춰 정렬
  const orderedFeatures = useMemo(() => {
    return ids
      .map(id => features.find(f => f.properties?.id === id))
      .filter((f): f is GeoJSONFeature => !!f)
  }, [ids, features])

  const firByRoute = useMemo(() => {
    if (!state.firGeoJSON || orderedFeatures.length === 0) return [] as string[][]
    return orderedFeatures.map(f => {
      const hits: string[] = []
      for (const fir of state.firGeoJSON!.features) {
        try {
          if (turf.booleanIntersects(f as any, fir as any)) {
            hits.push((fir.properties?.icao as string) ?? (fir.properties?.name as string))
          }
        } catch {
          // 지오메트리가 비정상인 경우 건너뜀
        }
      }
      return hits
    })
  }, [orderedFeatures, state.firGeoJSON])

  const typhoonHitByRoute = useMemo(() => {
    if (orderedFeatures.length === 0 || state.typhoons.length === 0) return [] as string[][]
    return orderedFeatures.map(f => {
      const hits: string[] = []
      for (const t of state.typhoons) {
        try {
          const circle = turf.circle([t.lon, t.lat], t.radius_nm, { steps: 64, units: 'nauticalmiles' })
          if (turf.booleanIntersects(f as any, circle as any)) hits.push(t.name)
        } catch {
          // 지오메트리가 비정상인 경우 건너뜀
        }
      }
      return hits
    })
  }, [orderedFeatures, state.typhoons])

  if (ids.length === 0) return null

  const metas: RouteMeta[] = ids
    .map(id => state.allRoutes.find(r => r.id === id))
    .filter((m): m is RouteMeta => m != null)
  if (metas.length === 0) return null

  const isComparing = metas.length === 2
  const distDelta = isComparing ? metas[1].distance - metas[0].distance : 0

  return (
    <div
      className="absolute top-4 right-[28rem] z-30 w-[360px] max-h-[calc(100vh-2rem)] flex flex-col bg-gray-950/95 backdrop-blur border border-gray-700 rounded-xl shadow-2xl overflow-hidden"
      style={{ transform: `translate(${drag.x}px, ${drag.y}px)` }}
    >
      <div
        onMouseDown={startDrag}
        onClick={() => setExpanded(v => !v)}
        className="flex items-center justify-between gap-2 px-3 py-2.5 border-b border-gray-700 bg-gray-900/80 shrink-0 cursor-grab active:cursor-grabbing select-none"
      >
        <div className="flex items-center gap-1.5 text-xs font-semibold text-white min-w-0">
          <GripHorizontal size={13} className="text-gray-600 shrink-0" />
          <GitCompare size={13} className="shrink-0" /> <span className="shrink-0">{isComparing ? '항로 비교' : metas.length === 1 ? '항로 정보' : `항로 ${metas.length}개`}</span>
          {!expanded && (
            <span className="text-gray-500 font-normal ml-1 truncate">
              {isComparing
                ? `${metas[0].distance} vs ${metas[1].distance} NM`
                : metas.length === 1
                  ? `${metas[0].origin} → ${metas[0].destination} #${metas[0].number} · ${metas[0].distance} NM`
                  : `${metas.map(m => m.distance).join(', ')} NM`}
              {' — 펼쳐보기'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {expanded ? <ChevronUp size={14} className="text-gray-500" /> : <ChevronDown size={14} className="text-gray-500" />}
          <button
            onMouseDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); dispatch({ type: 'SET_SELECTED_ROUTES', payload: [] }) }}
            className="text-gray-500 hover:text-gray-300 transition-colors"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {expanded && (
      <div className="overflow-y-auto p-3 space-y-3">
        {loading ? (
          <div className="text-xs text-gray-500 text-center py-6">불러오는 중…</div>
        ) : (
          <>
            {/* 거리 비교 — 정확히 2개 선택했을 때만 */}
            {isComparing && (
              <div className="bg-gray-900/60 border border-gray-700 rounded-lg p-2.5">
                <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-1.5">거리</div>
                <div className="flex items-center justify-between text-xs">
                  <span style={{ color: colorAt(0) }} className="font-bold">{metas[0].distance} NM</span>
                  <span className="text-gray-600">vs</span>
                  <span style={{ color: colorAt(1) }} className="font-bold">{metas[1].distance} NM</span>
                </div>
                {distDelta !== 0 && (
                  <div className="text-center text-[11px] text-gray-400 mt-1">
                    차이 {Math.abs(distDelta)} NM
                    {' '}({distDelta > 0
                      ? <span style={{ color: colorAt(0) }}>#{metas[0].number}이(가) 더 짧음</span>
                      : <span style={{ color: colorAt(1) }}>#{metas[1].number}이(가) 더 짧음</span>})
                  </div>
                )}
              </div>
            )}

            {/* 항로별 상세 */}
            {metas.map((r, i) => {
              const c = colorAt(i)
              const geometryReady = orderedFeatures.length === metas.length
              return (
              <div
                key={r.id}
                className="rounded-lg border p-2.5"
                style={{ borderColor: c + '80', backgroundColor: c + '0f' }}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-bold" style={{ color: c }}>
                    {r.origin} → {r.destination} #{r.number}
                  </span>
                  <span className="text-[10px] text-gray-500">{r.distance} NM</span>
                </div>

                <div className="text-[11px] text-gray-300 leading-relaxed break-all font-mono mb-2">
                  {r.route}
                </div>

                {r.comments && (
                  <div className="flex items-start gap-1.5 mb-1.5">
                    <StickyNote size={11} className="text-gray-500 mt-0.5 shrink-0" />
                    <div className="text-[10px] text-gray-400 leading-relaxed whitespace-pre-wrap break-words">
                      {r.comments}
                    </div>
                  </div>
                )}

                <div className="flex items-start gap-1.5 mb-1.5">
                  <MapPinned size={11} className="text-gray-500 mt-0.5 shrink-0" />
                  <div className="flex flex-wrap gap-1">
                    {!geometryReady ? (
                      <span className="text-[10px] text-gray-600">—</span>
                    ) : (firByRoute[i] ?? []).length === 0 ? (
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
                  {!geometryReady ? (
                    <span className="text-[10px] text-gray-600">—</span>
                  ) : state.typhoons.length === 0 ? (
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
          </>
        )}
      </div>
      )}
    </div>
  )
}
