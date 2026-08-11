import { useMemo, useState } from 'react'
import { X, Search, RefreshCw, Plane, Route, Clock, MapPin } from 'lucide-react'
import { api } from '../api/client'
import { useApp } from '../AppContext'
import { SELECT_COLORS } from '../lib/selectionColors'
import { airlineColor } from '../lib/airlineColors'
import type { FplAirlineCount, FplCollectStatus, FplOdStats, FplRouteStat } from '../types'

interface Props {
  onClose: () => void
}

function formatMin(min: number | null): string {
  if (min == null) return '—'
  const h = Math.floor(min / 60), m = min % 60
  return h > 0 ? `${h}시간 ${m}분` : `${m}분`
}

function CollectBar({ status }: { status: FplCollectStatus | null }) {
  if (!status) return null
  const pct = status.total_days > 0 ? Math.round(status.processed_days / status.total_days * 100) : 0
  const isDone = status.status === 'done'
  return (
    <div className="text-[11px] space-y-1.5 bg-gray-900/60 border border-gray-700 rounded-lg p-3">
      <div className="flex items-center gap-2 text-gray-400">
        {!isDone && <RefreshCw size={12} className="animate-spin text-blue-400" />}
        {isDone ? (
          <span className="text-green-400">
            수집 완료 — {status.collected.toLocaleString()}편 신규 저장
            {status.skipped > 0 && ` (이미 수집된 ${status.skipped}편 건너뜀)`}
            {status.failed > 0 && ` · 실패 ${status.failed}편`}
          </span>
        ) : status.status === 'error' ? (
          <span className="text-red-400">오류: {status.error}</span>
        ) : (
          <span>
            {status.processed_days}/{status.total_days}일 처리 중… (편 {status.collected + status.skipped}/{status.total_flights || '?'})
          </span>
        )}
      </div>
      {!isDone && status.total_days > 0 && (
        <div className="h-1 bg-gray-800 rounded-full overflow-hidden">
          <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  )
}

function RouteOverlayButton({ g, r, colorIdx }: { g: FplOdStats; r: FplRouteStat; colorIdx: number }) {
  const { state, dispatch } = useApp()
  const [loading, setLoading] = useState(false)
  const id = r.route
  const active = !!state.filedRouteOverlays[id]

  async function toggle() {
    if (active) {
      dispatch({ type: 'REMOVE_FILED_ROUTE_OVERLAY', payload: id })
      return
    }
    setLoading(true)
    try {
      const data = await api.routes.parse(r.route)
      const feature = data.features[0]
      if (!feature || feature.geometry.type !== 'LineString') return
      dispatch({
        type: 'ADD_FILED_ROUTE_OVERLAY',
        payload: {
          id, dep: g.dep, arr: g.arr, route: r.route, count: r.count,
          coordinates: feature.geometry.coordinates as [number, number][],
          legs: (feature.properties?.legs as { airway: string; coords: [number, number][] }[]) ?? [],
          waypoints: (feature.properties?.waypoints as { id: string; lon: number; lat: number }[]) ?? [],
          color: SELECT_COLORS[colorIdx % SELECT_COLORS.length],
        },
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <button
      onClick={toggle}
      disabled={loading}
      title={active ? '지도 오버레이 해제' : '지도에 표시'}
      className={`shrink-0 p-1 rounded transition-colors ${active ? 'text-cyan-400 hover:text-cyan-300' : 'text-gray-600 hover:text-gray-300'}`}
    >
      {loading ? <RefreshCw size={11} className="animate-spin" /> : <MapPin size={11} />}
    </button>
  )
}

function OdCard({ g }: { g: FplOdStats }) {
  const [showAllRoutes, setShowAllRoutes] = useState(false)
  const [sortBy, setSortBy] = useState<'freq' | 'distance'>('freq')

  const sortedRoutes = useMemo(() => {
    if (sortBy === 'freq') return g.routes // 백엔드가 이미 빈도 내림차순으로 줌
    // 거리순(짧은 것부터) — 단축항로 후보를 찾을 때는 이 순서가 유용함.
    // 거리 계산에 실패한 항로(null)는 판단 불가라 맨 뒤로 밀어냄
    return [...g.routes].sort((a, b) => {
      if (a.distance_nm == null) return 1
      if (b.distance_nm == null) return -1
      return a.distance_nm - b.distance_nm
    })
  }, [g.routes, sortBy])

  const routes = showAllRoutes ? sortedRoutes : sortedRoutes.slice(0, 5)
  return (
    <div className="bg-gray-900/60 border border-gray-700 rounded-lg p-3 space-y-2.5">
      <div className="flex items-center justify-between">
        <span className="text-sm font-bold text-white">{g.dep} → {g.arr}</span>
        <span className="text-[11px] text-gray-500">{g.count.toLocaleString()}편</span>
      </div>

      <div className="flex items-center gap-1.5 text-[11px] text-gray-400">
        <Clock size={12} className="text-gray-500 shrink-0" />
        <span>평균 <b className="text-gray-200">{formatMin(g.eet_avg_min)}</b></span>
        <span className="text-gray-600 text-[10px]">(최소 {formatMin(g.eet_min_min)} · 최대 {formatMin(g.eet_max_min)})</span>
      </div>

      <div>
        <div className="flex items-center gap-1.5 text-[10px] text-gray-500 uppercase tracking-wide mb-1.5">
          <Plane size={11} /> 기종별 분포 · 평균 비행시간
        </div>
        <div className="flex flex-wrap gap-1.5">
          {g.aircraft.map(a => (
            <span key={a.ac_type} className="text-[10px] px-1.5 py-0.5 rounded bg-gray-800 text-gray-300 border border-gray-700">
              {a.ac_type} <span className="text-gray-500">{Math.round(a.pct * 100)}%</span>
              <span className="text-gray-600"> · {formatMin(a.eet_avg_min)}</span>
            </span>
          ))}
        </div>
      </div>

      <div>
        <div className="flex items-center gap-1.5 text-[10px] text-gray-500 uppercase tracking-wide mb-1.5">
          <Route size={11} /> 제출 항로
          <div className="ml-auto flex items-center gap-0.5 normal-case tracking-normal">
            <button
              onClick={() => setSortBy('freq')}
              className={`px-1.5 py-0.5 rounded ${sortBy === 'freq' ? 'bg-cyan-900/60 text-cyan-300' : 'text-gray-600 hover:text-gray-400'}`}
            >
              빈도순
            </button>
            <button
              onClick={() => setSortBy('distance')}
              className={`px-1.5 py-0.5 rounded ${sortBy === 'distance' ? 'bg-cyan-900/60 text-cyan-300' : 'text-gray-600 hover:text-gray-400'}`}
            >
              거리순
            </button>
          </div>
        </div>
        <div className="space-y-2">
          {routes.map((r, i) => (
            <div key={r.route}>
              <div className="flex items-center gap-1.5 text-[11px]">
                <span className="text-gray-500 w-8 shrink-0">{Math.round(r.pct * 100)}%</span>
                <div className="flex-1 h-1 bg-gray-800 rounded-full overflow-hidden min-w-[24px]">
                  <div className="h-full bg-cyan-600 rounded-full" style={{ width: `${r.pct * 100}%` }} />
                </div>
                <span className="text-gray-500 shrink-0">{r.count}건</span>
                <span className="text-amber-400/90 shrink-0">
                  {r.distance_nm != null ? `${r.distance_nm.toLocaleString()}NM` : '—'}
                </span>
                <RouteOverlayButton g={g} r={r} colorIdx={i} />
              </div>
              <div className="text-[10px] text-gray-400 font-mono break-all mt-0.5">{r.route}</div>
              <div className="flex flex-wrap gap-1 mt-1">
                {r.aircraft.map(a => (
                  <span key={a.ac_type} className="text-[9px] px-1 py-0.5 rounded bg-gray-800/80 text-gray-400 border border-gray-700/80">
                    {a.ac_type} {a.count}건 · {formatMin(a.eet_avg_min)}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
        {g.routes.length > 5 && (
          <button
            onClick={() => setShowAllRoutes(v => !v)}
            className="text-[10px] text-cyan-400 hover:text-cyan-300 mt-1.5"
          >
            {showAllRoutes ? '접기' : `${g.routes.length - 5}개 더 보기`}
          </button>
        )}
      </div>
    </div>
  )
}

export default function FlightFilingStatsPage({ onClose }: Props) {
  const { state, dispatch } = useApp()
  const overlayCount = Object.keys(state.filedRouteOverlays).length
  const today = new Date().toISOString().slice(0, 10)
  const monthAgo = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)

  const [dep, setDep] = useState('RKSI')
  const [arr, setArr] = useState('')
  const [airline, setAirline] = useState('')
  const [start, setStart] = useState(monthAgo)
  const [end, setEnd] = useState(today)

  const [collectStatus, setCollectStatus] = useState<FplCollectStatus | null>(null)
  const [groups, setGroups] = useState<FplOdStats[] | null>(null)
  const [airlines, setAirlines] = useState<FplAirlineCount[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // dep/arr/기간이 바뀌면 FOIS에서 새로 긁어와야 하지만, 항공사 필터만 바뀌는
  // 경우는 이미 로컬에 수집된 걸 다시 집계만 하면 되므로 재수집 없이 이걸로 처리
  async function queryOnly(depTrim: string, arrTrim: string, airlineTrim: string) {
    const stats = await api.fois.historyStats({ dep: depTrim, arr: arrTrim, airline: airlineTrim, start, end })
    if (stats.error) throw new Error(stats.error)
    setGroups(stats.groups)
    setAirlines(stats.airlines)
  }

  async function handleCollectAndQuery() {
    const depTrim = dep.trim().toUpperCase()
    const arrTrim = arr.trim().toUpperCase()
    if (!depTrim && !arrTrim) {
      setError('출발 또는 도착 공항 중 하나는 입력해야 합니다')
      return
    }
    setLoading(true); setError(null); setCollectStatus(null); setGroups(null)
    try {
      const res = await api.fois.historyCollect({ dep: depTrim, arr: arrTrim, start, end })
      if (res.error) throw new Error(res.error)
      const taskId = res.task_id
      await new Promise<void>((resolve, reject) => {
        const poll = setInterval(async () => {
          const s = await api.fois.historyStatus(taskId)
          setCollectStatus(s)
          if (s.status === 'done' || s.status === 'error' || s.status === 'cancelled') {
            clearInterval(poll)
            if (s.status === 'error') reject(new Error(s.error ?? '수집 실패'))
            else resolve()
          }
        }, 2000)
      })
      await queryOnly(depTrim, arrTrim, airline.trim().toUpperCase())
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setLoading(false)
    }
  }

  async function handleAirlineChange(code: string) {
    setAirline(code)
    if (!groups) return // 아직 한 번도 수집 안 했으면 필터만 바꿔도 할 게 없음
    setLoading(true); setError(null)
    try {
      await queryOnly(dep.trim().toUpperCase(), arr.trim().toUpperCase(), code)
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="w-[440px] shrink-0 h-full border-l border-gray-800 bg-gray-950 flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-gray-800 shrink-0">
        <h1 className="text-sm font-bold text-white">항로 제출 실적</h1>
        {overlayCount > 0 && (
          <>
            <span className="text-[10px] text-cyan-400 ml-1">지도에 {overlayCount}개 표시 중</span>
            <button
              onClick={() => dispatch({ type: 'CLEAR_FILED_ROUTE_OVERLAYS' })}
              className="text-[10px] text-gray-500 hover:text-gray-300 transition-colors"
            >
              지우기
            </button>
          </>
        )}
        <button onClick={onClose} className="ml-auto text-gray-500 hover:text-gray-200 transition-colors">
          <X size={16} />
        </button>
      </div>
      <div className="px-3 py-1.5 text-[10px] text-gray-600 border-b border-gray-800 shrink-0">
        FOIS 실제 제출 ATC 비행계획 기준 — 기간별 출/도착지별 항로·기종·비행시간 집계
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        <div className="flex items-end gap-2 flex-wrap bg-gray-900/60 border border-gray-700 rounded-lg p-2.5">
          <label className="text-[11px] text-gray-400">
            출발
            <input
              value={dep} onChange={e => setDep(e.target.value)}
              placeholder="RKSI"
              className="block mt-1 w-16 bg-gray-950 border border-gray-700 rounded px-1.5 py-1 text-xs text-white uppercase"
            />
          </label>
          <label className="text-[11px] text-gray-400">
            도착
            <input
              value={arr} onChange={e => setArr(e.target.value)}
              placeholder="전체"
              className="block mt-1 w-16 bg-gray-950 border border-gray-700 rounded px-1.5 py-1 text-xs text-white uppercase"
            />
          </label>
          <label className="text-[11px] text-gray-400">
            시작일
            <input
              type="date" value={start} onChange={e => setStart(e.target.value)}
              className="block mt-1 bg-gray-950 border border-gray-700 rounded px-1.5 py-1 text-[11px] text-white w-[118px]"
            />
          </label>
          <label className="text-[11px] text-gray-400">
            종료일
            <input
              type="date" value={end} onChange={e => setEnd(e.target.value)}
              className="block mt-1 bg-gray-950 border border-gray-700 rounded px-1.5 py-1 text-[11px] text-white w-[118px]"
            />
          </label>
          <button
            onClick={handleCollectAndQuery}
            disabled={loading}
            className="flex items-center gap-1.5 bg-blue-700 hover:bg-blue-600 disabled:opacity-50 text-white text-xs font-semibold px-2.5 py-1.5 rounded transition-colors"
          >
            {loading ? <RefreshCw size={12} className="animate-spin" /> : <Search size={12} />}
            수집 & 조회
          </button>

          {airlines.length > 0 && (
            <label className="text-[11px] text-gray-400 w-full">
              항공사
              <select
                value={airline}
                onChange={e => handleAirlineChange(e.target.value)}
                className="block mt-1 w-full bg-gray-950 border border-gray-700 rounded px-1.5 py-1 text-xs text-white"
              >
                <option value="">전체 ({airlines.reduce((s, a) => s + a.count, 0)}편)</option>
                {airlines.map(a => (
                  <option key={a.code} value={a.code} style={{ color: airlineColor(a.code) }}>
                    {a.code} ({a.count}편)
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        {error && <div className="text-xs text-red-400">{error}</div>}

        <CollectBar status={collectStatus} />

        {groups && groups.length === 0 && (
          <div className="text-xs text-gray-500 text-center py-8">해당 조건에 수집된 데이터가 없습니다</div>
        )}

        {groups && groups.length > 0 && (
          <div className="space-y-3">
            {groups.map(g => <OdCard key={`${g.dep}-${g.arr}`} g={g} />)}
          </div>
        )}
      </div>
    </div>
  )
}
