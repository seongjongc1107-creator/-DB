import { useEffect, useMemo, useState } from 'react'
import { PlaneTakeoff, PlaneLanding, RotateCcw, Download, Shuffle, CheckCircle2, AlertTriangle } from 'lucide-react'
import * as turf from '@turf/turf'
import { api } from '../api/client'
import { useApp } from '../AppContext'
import { SELECT_COLORS } from '../lib/selectionColors'
import type { GeoJSONFeature, RouteMeta } from '../types'

// ── Types ────────────────────────────────────────────────────────────────────

interface AltRoute {
  id: number
  origin: string
  destination: string
  number: number
  route: string
  distance: number
  baseDistance: number  // min distance among blocked routes for same OD
  safe: boolean         // doesn't intersect hazard
  feature: GeoJSONFeature
}

// ── Main component ────────────────────────────────────────────────────────────

export default function RoutePanel() {
  const { state, dispatch } = useApp()
  const [origins, setOrigins] = useState<string[]>([])
  const [destinations, setDestinations] = useState<string[]>([])
  const [altMode, setAltMode] = useState(false)
  const [altRoutes, setAltRoutes] = useState<AltRoute[]>([])
  const [affectedByOD, setAffectedByOD] = useState<Record<string, RouteMeta[]>>({})
  const [altLoading, setAltLoading] = useState(false)
  const [selectedAltId, setSelectedAltId] = useState<number | null>(null)

  useEffect(() => {
    api.routes.origins().then(setOrigins).catch(() => {})
    api.routes.destinations().then(setDestinations).catch(() => {})
  }, [])

  // 검색창에서 고른 airway/waypoint 전부(하나만이 아니라) — 콤마로 이어서 보내면
  // 백엔드가 전부 지나는 항로만 AND로 교집합해줌. 예전엔 activeAirway/activeWaypoint가
  // 각각 최신 1개만 저장돼서, 두 번째 airway를 고르면 첫 번째 조건이 조용히 사라졌음
  const activeFixKey = state.highlightPoints
    .filter(h => h.type === 'airway' || h.type === 'waypoint')
    .map(h => h.id)
    .join(',')

  useEffect(() => {
    if (!state.origin && !state.destination) return
    // 이미 airway/waypoint를 검색해서 활성화해둔 상태라면(예: N892 검색 후) 출발지·
    // 도착지까지 같이 골랐을 때 "그 항공로를 지나는 RKSI→VVPQ 항로"처럼 세 조건을
    // 한 번에 교집합으로 좁혀줌 — 백엔드가 origin/destination/fix를 동시에 지원함
    const fix = activeFixKey || undefined
    dispatch({ type: 'SET_LOADING', payload: true })
    Promise.all([
      api.routes.list({ origin: state.origin || undefined, destination: state.destination || undefined, fix }),
      api.routes.geometry({ origin: state.origin || undefined, destination: state.destination || undefined, fix }),
    ]).then(([listData, geoData]) => {
      dispatch({ type: 'SET_ALL_ROUTES', payload: listData.routes })
      dispatch({ type: 'SET_ROUTE_GEOJSON', payload: geoData })
      dispatch({ type: 'SET_SELECTED_ROUTES', payload: [] })
    }).catch(() => {}).finally(() => dispatch({ type: 'SET_LOADING', payload: false }))
  }, [state.origin, state.destination, activeFixKey, dispatch])

  // 공간 필터 해제 시 대체 항로 모드도 해제
  useEffect(() => {
    if (!state.spatialFilter) {
      exitAltMode()
    }
  }, [state.spatialFilter]) // eslint-disable-line react-hooks/exhaustive-deps

  function reset() {
    exitAltMode()
    dispatch({ type: 'SET_ORIGIN', payload: '' })
    dispatch({ type: 'SET_DESTINATION', payload: '' })
    dispatch({ type: 'SET_SELECTED_ROUTES', payload: [] })
    dispatch({ type: 'SET_ACTIVE_AIRWAY', payload: null })
    dispatch({ type: 'SET_ACTIVE_WAYPOINT', payload: null })
    dispatch({ type: 'SET_AIRWAY_GEOJSON', payload: null })
    dispatch({ type: 'SET_MATCHED_ROUTES_GEOJSON', payload: null })
    dispatch({ type: 'CLEAR_HIGHLIGHTS' })
    dispatch({ type: 'CLEAR_AIRWAY_ENDPOINTS' })
    // 영역(폴리곤/반경) 검색 조건도 같이 초기화
    dispatch({ type: 'CLEAR_SPATIAL' })
    dispatch({ type: 'SET_SELECTED_AIRPORT', payload: null })
    setNumberFilter('')
    // 지도도 초기 화면(첫 로드 시 보이던 시점/줌)으로 복귀
    dispatch({ type: 'SET_FLY_TO', payload: { lon: 127, lat: 35, zoom: 4 } })
  }

  function exitAltMode() {
    setAltMode(false)
    setAltRoutes([])
    setAffectedByOD({})
    setSelectedAltId(null)
    dispatch({ type: 'SET_ALT_ROUTE_MODE', payload: false })
    dispatch({ type: 'SET_MATCHED_ROUTES_GEOJSON', payload: null })
  }

  async function toggleAltMode() {
    if (altMode) {
      exitAltMode()
      return
    }

    const affectedIdSet = new Set(state.affectedRouteIds)
    const affected = state.allRoutes.filter(r => affectedIdSet.has(r.id))
    if (!state.spatialFilter || affected.length === 0) return

    setAltMode(true)
    setAltLoading(true)
    setSelectedAltId(null)
    dispatch({ type: 'SET_ALT_ROUTE_MODE', payload: false })

    try {
      const excludeIds = affected.map(r => r.id).join(',')

      // OD별 영향 항로 그룹핑 (패널에 표시용)
      const affByOD: Record<string, RouteMeta[]> = {}
      for (const r of affected) {
        const key = `${r.origin}-${r.destination}`
        if (!affByOD[key]) affByOD[key] = []
        affByOD[key].push(r)
      }
      setAffectedByOD(affByOD)

      // OD 쌍 추출 (중복 제거)
      const odPairs = Object.keys(affByOD).join(',')

      // OD별 최소 거리 (기준 거리 비교용)
      const baseDistMap: Record<string, number> = {}
      for (const r of affected) {
        const key = `${r.origin}-${r.destination}`
        if (!(key in baseDistMap) || r.distance < baseDistMap[key]) {
          baseDistMap[key] = r.distance
        }
      }

      const geoData = await api.routes.alternatives(odPairs, excludeIds)
      const filterPoly = turf.polygon([state.spatialFilter.ring])

      const results: AltRoute[] = geoData.features
        .map(f => {
          const p = f.properties as Record<string, unknown>
          let safe = true
          try { safe = !turf.booleanIntersects(f as any, filterPoly) }
          catch { safe = true }

          const odKey = `${p.origin}-${p.destination}`
          return {
            id: p.id as number,
            origin: p.origin as string,
            destination: p.destination as string,
            number: p.number as number,
            route: p.route as string,
            distance: p.distance as number,
            baseDistance: baseDistMap[odKey] ?? (p.distance as number),
            safe,
            feature: f,
          }
        })
        // 안전 항로 먼저, 같은 OD 내에서는 거리 짧은 순
        .sort((a, b) => {
          if (a.safe !== b.safe) return a.safe ? -1 : 1
          const odCmp = `${a.origin}-${a.destination}`.localeCompare(`${b.origin}-${b.destination}`)
          if (odCmp !== 0) return odCmp
          return a.distance - b.distance
        })

      setAltRoutes(results)
    } catch {
      setAltMode(false)
    } finally {
      setAltLoading(false)
    }
  }

  async function selectAltRoute(alt: AltRoute) {
    setSelectedAltId(alt.id)
    const fc = { type: 'FeatureCollection' as const, features: [alt.feature] }
    dispatch({ type: 'SET_MATCHED_ROUTES_GEOJSON', payload: fc })
    dispatch({ type: 'SET_ALT_ROUTE_MODE', payload: true })
  }

  // OD별 그룹핑
  const altByOD = useMemo(() => {
    const groups: Record<string, AltRoute[]> = {}
    for (const r of altRoutes) {
      const key = `${r.origin}-${r.destination}`
      if (!groups[key]) groups[key] = []
      groups[key].push(r)
    }
    return groups
  }, [altRoutes])

  const [routeTooltip, setRouteTooltip] = useState<{ x: number; y: number; text: string } | null>(null)
  const affectedIdSet = useMemo(() => new Set(state.affectedRouteIds), [state.affectedRouteIds])
  // 공간 필터(태풍 등)에 걸리는 항로를 최상단으로 — 목록 자체는 그대로 유지해서
  // 영향 없는 항로도 선택해서 실제로 안전한지 지도에서 확인할 수 있게 함
  const sortedRoutes = useMemo(() => {
    if (affectedIdSet.size === 0) return state.allRoutes
    return [...state.allRoutes].sort((a, b) => {
      const aAff = affectedIdSet.has(a.id) ? 0 : 1
      const bAff = affectedIdSet.has(b.id) ? 0 : 1
      return aAff - bAff
    })
  }, [state.allRoutes, affectedIdSet])

  // 항로 번호 추가 필터 — 지금 보이는 목록(영향 항로 정렬 포함) 안에서만 더 좁힘.
  // 공백으로 구분해서 여러 번호를 한 번에 입력하면 OR로 매칭 (예: "27 96 11").
  const [numberFilter, setNumberFilter] = useState('')
  const routes = useMemo(() => {
    const numbers = numberFilter.trim().split(/\s+/).filter(Boolean).map(Number).filter(n => !isNaN(n))
    if (numbers.length === 0) return sortedRoutes
    const numberSet = new Set(numbers)
    return sortedRoutes.filter(r => numberSet.has(r.number))
  }, [sortedRoutes, numberFilter])

  const hasSpatialFilter = !!state.spatialFilter

  // 최대 10개까지 선택 가능(지도에서 동시에 보기용). 기본은 단일 선택(클릭 시
  // 교체) — Ctrl/Cmd를 누른 채 클릭해야 복수 선택으로 추가/제거됨.
  function selectRoute(id: number, multi: boolean) {
    if (multi) dispatch({ type: 'TOGGLE_SELECTED_ROUTE', payload: id })
    else dispatch({ type: 'SET_SELECTED_ROUTES', payload: [id] })
  }

  function exportCsv() {
    const header = ['Origin', 'Destination', 'Number', 'Affected', 'Route', 'Distance (NM)', 'Aircraft']
    const rows = routes.map(r => [
      r.origin, r.destination, r.number,
      affectedIdSet.has(r.id) ? 'Y' : 'N',
      `"${r.route.replace(/"/g, '""')}"`,
      r.distance, r.aircraft ?? '',
    ])
    const csv = [header, ...rows].map(row => row.join(',')).join('\n')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `routes_${state.origin || 'all'}-${state.destination || 'all'}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="flex flex-col gap-3 min-h-0">
      {/* OD Selectors */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <PlaneTakeoff size={13} className="text-blue-400 shrink-0" />
          <select
            className="flex-1 bg-gray-800 border border-gray-600 text-white text-xs rounded px-2 py-1.5 outline-none"
            value={state.origin}
            onChange={e => dispatch({ type: 'SET_ORIGIN', payload: e.target.value })}
          >
            <option value="">출발지 선택</option>
            {origins.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <PlaneLanding size={13} className="text-red-400 shrink-0" />
          <select
            className="flex-1 bg-gray-800 border border-gray-600 text-white text-xs rounded px-2 py-1.5 outline-none"
            value={state.destination}
            onChange={e => dispatch({ type: 'SET_DESTINATION', payload: e.target.value })}
          >
            <option value="">도착지 선택</option>
            {destinations.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
        {(state.origin || state.destination || state.activeAirway || state.activeWaypoint) && (
          <button onClick={reset} className="flex items-center gap-1 text-xs text-gray-400 hover:text-white transition-colors self-end">
            <RotateCcw size={11} /> 초기화
          </button>
        )}
      </div>

      {state.highlightPoints.filter(h => h.type === 'airway').map(h => (
        <div key={`awy-${h.id}`} className="bg-yellow-900/30 border border-yellow-700/50 rounded px-2 py-1.5 text-xs text-yellow-300">
          항공로 <strong>{h.name}</strong> — {routes.length}개 항로 매칭
        </div>
      ))}
      {state.highlightPoints.filter(h => h.type === 'waypoint').map(h => (
        <div key={`wpt-${h.id}`} className="bg-blue-900/30 border border-blue-700/50 rounded px-2 py-1.5 text-xs text-blue-300">
          Waypoint <strong>{h.name}</strong> — {routes.length}개 항로 매칭
        </div>
      ))}

      {/* Route list / Alt route list */}
      <div className="flex-1 overflow-y-auto space-y-1 pr-0.5">
        {state.isLoading ? (
          <div className="text-xs text-gray-500 text-center py-4">로딩 중…</div>
        ) : routes.length === 0 ? (
          <div className="text-xs text-gray-600 text-center py-6">
            출발지/도착지를 선택하거나<br />항로명을 검색하세요
          </div>
        ) : altMode ? (
          // ── 대체 항로 목록 ──────────────────────────────────────
          <AltRouteList
            byOD={altByOD}
            affectedByOD={affectedByOD}
            loading={altLoading}
            selectedId={selectedAltId}
            onSelect={selectAltRoute}
            onClose={exitAltMode}
          />
        ) : (
          // ── 일반 항로 목록 ──────────────────────────────────────
          <>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-gray-500">{routes.length}개 항로</span>
              <div className="flex items-center gap-2">
                {hasSpatialFilter && (
                  <button
                    onClick={toggleAltMode}
                    className="flex items-center gap-1 text-xs text-purple-400 hover:text-purple-300 transition-colors font-medium"
                    title="대체 항로 추천"
                  >
                    <Shuffle size={11} />
                    대체 항로
                  </button>
                )}
                <button onClick={exportCsv} className="flex items-center gap-1 text-xs text-gray-400 hover:text-green-400 transition-colors" title="CSV로 내보내기">
                  <Download size={11} /> CSV
                </button>
              </div>
            </div>
            {/* 지금 보이는 목록 안에서 항로 번호로 추가 필터 */}
            <div className="flex items-center gap-1.5 mb-1.5">
              <span className="text-gray-600 text-xs shrink-0">#</span>
              <input
                type="text"
                inputMode="numeric"
                placeholder="항로 번호로 필터 (예: 27 96 11)"
                value={numberFilter}
                onChange={e => setNumberFilter(e.target.value)}
                className="flex-1 bg-gray-800 border border-gray-700 text-white text-xs rounded px-2 py-1 outline-none focus:border-blue-500 placeholder-gray-600"
              />
              {numberFilter && (
                <button
                  onClick={() => setNumberFilter('')}
                  className="text-gray-500 hover:text-gray-300 text-xs shrink-0"
                >
                  지우기
                </button>
              )}
            </div>
            {affectedIdSet.size > 0 && (
              <div className="text-[10px] text-orange-400 mb-1">
                영향 항로 {affectedIdSet.size}개 — 위로 정렬했어요. 나머지도 선택해서 실제로 안전한지 확인할 수 있어요
              </div>
            )}
            {state.selectedRouteIds.length > 0 && (
              <div className="text-[10px] text-gray-500 mb-1">
                {state.selectedRouteIds.length === 1
                  ? 'Ctrl+클릭으로 항로를 더 추가할 수 있어요 (최대 10개)'
                  : state.selectedRouteIds.length === 2
                    ? '2개 선택됨 — 상세 비교 패널을 펼쳐볼 수 있어요'
                    : `${state.selectedRouteIds.length}개 선택됨 — Ctrl+클릭으로 추가/제거`}
              </div>
            )}
            {routes.map(r => {
              const selIdx = state.selectedRouteIds.indexOf(r.id)
              const isSelected = selIdx !== -1
              const isAffected = affectedIdSet.has(r.id)
              const color = selIdx !== -1 ? SELECT_COLORS[selIdx % SELECT_COLORS.length] : undefined
              return (
                <button
                  key={r.id}
                  className={`w-full text-left px-2.5 py-2 rounded-md text-xs transition-colors border ${
                    isSelected
                      ? 'text-white'
                      : isAffected
                        ? 'bg-orange-950/30 hover:bg-orange-950/50 border-orange-800/60 text-gray-300 hover:text-white'
                        : 'bg-gray-800 hover:bg-gray-750 border-transparent text-gray-300 hover:text-white'
                  }`}
                  style={isSelected ? { backgroundColor: color + '26', borderColor: color } : undefined}
                  onClick={e => selectRoute(r.id, e.ctrlKey || e.metaKey)}
                  onMouseEnter={e => {
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                    setRouteTooltip({ x: rect.right + 8, y: rect.top, text: r.route })
                    dispatch({ type: 'SET_HOVERED_ROUTE', payload: r.id })
                  }}
                  onMouseLeave={() => {
                    setRouteTooltip(null)
                    dispatch({ type: 'SET_HOVERED_ROUTE', payload: null })
                  }}
                >
                  <div className="flex items-center gap-1.5">
                    {isSelected && (
                      <span
                        className="flex items-center justify-center w-4 h-4 rounded-full text-[9px] font-bold text-gray-950 shrink-0"
                        style={{ backgroundColor: color }}
                      >
                        {selIdx + 1}
                      </span>
                    )}
                    <div className="font-semibold text-white">
                      {r.origin} → {r.destination}
                      <span className="ml-1 text-gray-500 font-normal">#{r.number}</span>
                    </div>
                    {isAffected && (
                      <span className="flex items-center gap-0.5 text-[9px] font-semibold text-orange-400 shrink-0">
                        <AlertTriangle size={9} /> 영향
                      </span>
                    )}
                  </div>
                  <div className="text-gray-400 truncate mt-0.5">{r.route}</div>
                  <div className="text-gray-500 mt-0.5">{r.distance} NM</div>
                </button>
              )
            })}
          </>
        )}
      </div>

      {routeTooltip && (
        <div
          className="fixed z-50 bg-gray-900 border border-gray-600 text-gray-200 text-xs rounded-lg shadow-2xl p-3 pointer-events-none"
          style={{ left: routeTooltip.x, top: routeTooltip.y, maxWidth: 320 }}
        >
          <div className="font-semibold text-green-400 mb-1">전체 항로</div>
          <div className="leading-relaxed break-all">{routeTooltip.text}</div>
        </div>
      )}
    </div>
  )
}

// ── Alt route list ────────────────────────────────────────────────────────────

function AltRouteList({
  byOD, affectedByOD, loading, selectedId, onSelect, onClose,
}: {
  byOD: Record<string, AltRoute[]>
  affectedByOD: Record<string, RouteMeta[]>
  loading: boolean
  selectedId: number | null
  onSelect: (r: AltRoute) => void
  onClose: () => void
}) {
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null)
  const odKeys = Object.keys(affectedByOD)

  return (
    <div className="space-y-3">
      {/* 헤더 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs text-purple-300 font-semibold">
          <Shuffle size={12} />
          대체 항로 추천
        </div>
        <button onClick={onClose} className="text-xs text-gray-500 hover:text-gray-300 transition-colors">
          ✕ 닫기
        </button>
      </div>

      {loading ? (
        <div className="text-xs text-gray-500 text-center py-4">분석 중…</div>
      ) : odKeys.length === 0 ? (
        <div className="text-xs text-gray-600 text-center py-4">대체 항로 없음</div>
      ) : (
        odKeys.map(odKey => {
          const blocked = affectedByOD[odKey] ?? []
          const alts = byOD[odKey] ?? []
          const safeAlts = alts.filter(a => a.safe)
          return (
            <div key={odKey} className="rounded-lg border border-gray-700 overflow-hidden">
              {/* OD 헤더 */}
              <div className="bg-gray-800 px-2.5 py-1.5 flex items-center justify-between">
                <span className="text-xs font-bold text-white">
                  {odKey.replace('-', ' → ')}
                </span>
                <span className="text-[10px] text-gray-500">
                  우회 가능 {safeAlts.length}개
                </span>
              </div>

              {/* 영향(차단) 항로 */}
              <div className="px-2.5 pt-2 pb-1 space-y-1">
                <div className="text-[10px] text-orange-400 font-semibold uppercase tracking-wider mb-1">
                  영향 항로
                </div>
                {blocked.map(r => (
                  <div key={r.id} className="flex items-center justify-between text-[11px] px-1 py-0.5 rounded bg-orange-900/20">
                    <span className="text-orange-300 font-medium">
                      <AlertTriangle size={9} className="inline mr-1 mb-0.5" />
                      #{r.number}
                    </span>
                    <span className="text-gray-500 truncate max-w-[130px] mx-2">{r.route}</span>
                    <span className="text-gray-500 shrink-0">{r.distance} NM</span>
                  </div>
                ))}
              </div>

              {/* 구분선 */}
              <div className="mx-2.5 border-t border-gray-700 my-1" />

              {/* 대체 항로 목록 */}
              <div className="px-2.5 pb-2 space-y-1">
                <div className="text-[10px] text-green-400 font-semibold uppercase tracking-wider mb-1">
                  대체 항로
                </div>
                {alts.length === 0 ? (
                  <div className="text-[11px] text-gray-600 py-1 text-center">없음</div>
                ) : alts.map(alt => {
                  const delta = alt.distance - alt.baseDistance
                  const isSelected = alt.id === selectedId
                  return (
                    <button
                      key={alt.id}
                      disabled={!alt.safe}
                      onClick={() => alt.safe && onSelect(alt)}
                      onMouseEnter={e => {
                        if (!alt.safe) return
                        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                        setTooltip({ x: rect.right + 8, y: rect.top, text: alt.route })
                      }}
                      onMouseLeave={() => setTooltip(null)}
                      className={`w-full text-left px-2 py-1.5 rounded text-xs transition-colors border ${
                        isSelected
                          ? 'bg-green-900/50 border-green-600'
                          : alt.safe
                            ? 'bg-gray-800/60 hover:bg-gray-700 border-transparent cursor-pointer'
                            : 'bg-transparent border-transparent opacity-40 cursor-default'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                          {alt.safe
                            ? <CheckCircle2 size={10} className="text-green-400 shrink-0" />
                            : <AlertTriangle size={10} className="text-gray-500 shrink-0" />
                          }
                          <span className={alt.safe ? 'text-white font-medium' : 'text-gray-500'}>
                            #{alt.number}
                          </span>
                        </div>
                        <span className={`text-[11px] ${delta > 0 ? 'text-gray-400' : 'text-green-400'}`}>
                          {alt.distance} NM&nbsp;
                          <span className="text-[10px]">({delta >= 0 ? '+' : ''}{delta})</span>
                        </span>
                      </div>
                      <div className={`truncate text-[11px] mt-0.5 ${alt.safe ? 'text-gray-400' : 'text-gray-600'}`}>
                        {alt.route}
                      </div>
                      {!alt.safe && (
                        <div className="text-[10px] text-orange-600 mt-0.5">영향권 통과</div>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })
      )}

      {tooltip && (
        <div
          className="fixed z-50 bg-gray-900 border border-gray-600 text-gray-200 text-xs rounded-lg shadow-2xl p-3 pointer-events-none"
          style={{ left: tooltip.x, top: tooltip.y, maxWidth: 320 }}
        >
          <div className="font-semibold text-green-400 mb-1">전체 항로</div>
          <div className="leading-relaxed break-all">{tooltip.text}</div>
        </div>
      )}
    </div>
  )
}
