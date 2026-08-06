import { useEffect, useState } from 'react'
import { X, RefreshCw, SlidersHorizontal, Moon, TrendingUp, Route, Loader2 } from 'lucide-react'
import { useApp } from '../AppContext'
import type { AirportTab, ApproachProc, CurfewInfo, FoisFlight, RunwayInfo, WeatherLevel, WeatherThresholds } from '../types'
import { api } from '../api/client'
import { classifyLevel, getThresholds, highlightSegments, type TextSegment } from '../lib/weatherClassify'
import { airlineColor } from '../lib/airlineColors'
import WeatherTrendModal from './WeatherTrendModal'

// ── shared helpers ──────────────────────────────────────────────────────────

const LEVEL_CONFIG: Record<WeatherLevel, { label: string; color: string; bg: string; dot: string }> = {
  1: { label: '양호',  color: 'text-green-400', bg: 'bg-green-900/40 border-green-700', dot: 'bg-green-400' },
  2: { label: '주의',  color: 'text-amber-400', bg: 'bg-amber-900/40 border-amber-600', dot: 'bg-amber-400' },
  3: { label: '심각',  color: 'text-red-400',   bg: 'bg-red-900/40 border-red-600',     dot: 'bg-red-400'   },
}

const TABS: { id: AirportTab; label: string }[] = [
  { id: 'weather',  label: '기상' },
  { id: 'runway',   label: '활주로' },
  { id: 'approach', label: '접근절차' },
  { id: 'schedule', label: '스케줄' },
]

function formatTaf(raw: string): string {
  return raw.replace(/\s+(TEMPO|BECMG|FM\d{6}|PROB\d{2})\b/g, '\n     $1').trim()
}

// ── Curfew banner ────────────────────────────────────────────────────────────

const TZ_SHORT: Record<string, string> = {
  'Asia/Seoul': 'KST', 'Asia/Tokyo': 'JST', 'Asia/Shanghai': 'CST',
  'Asia/Hong_Kong': 'HKT', 'Asia/Singapore': 'SGT', 'UTC': 'UTC',
}

function CurfewBanner({ curfew }: { curfew: CurfewInfo | null }) {
  if (!curfew) return null
  const tz = TZ_SHORT[curfew.timezone] ?? curfew.timezone
  return (
    <div className="mx-4 mb-0 mt-2 flex items-center gap-2 px-3 py-2 rounded-lg bg-red-950/60 border border-red-800/70">
      <Moon size={12} className="text-red-400 shrink-0" />
      <div className="flex-1 min-w-0">
        <span className="text-[11px] font-semibold text-red-300">커퓨 </span>
        <span className="text-[11px] font-mono text-red-200">
          {curfew.start} – {curfew.end}
        </span>
        <span className="text-[10px] text-red-400 ml-1">({tz})</span>
        {curfew.note && (
          <span className="text-[10px] text-red-500 ml-2 truncate">{curfew.note}</span>
        )}
      </div>
    </div>
  )
}

// ── Weather tab ─────────────────────────────────────────────────────────────

function HighlightedRaw({ text, thresholds, className }: {
  text: string; thresholds: WeatherThresholds; className?: string
}) {
  const segs: TextSegment[] = highlightSegments(text, thresholds)
  return (
    <p className={className}>
      {segs.map((s, i) =>
        s.level === 3 ? <span key={i} className="bg-red-500/25 text-red-300">{s.text}</span>
        : s.level === 2 ? <span key={i} className="bg-amber-500/25 text-amber-300">{s.text}</span>
        : <span key={i}>{s.text}</span>
      )}
    </p>
  )
}

// ── Runway tab ───────────────────────────────────────────────────────────────

const TYPE_COLOR: Record<string, string> = {
  ILS:    'bg-blue-900/50 text-blue-300 border-blue-700',
  LPV:    'bg-purple-900/50 text-purple-300 border-purple-700',
  RNP:    'bg-cyan-900/50 text-cyan-300 border-cyan-700',
  VOR:    'bg-green-900/50 text-green-300 border-green-700',
  NDB:    'bg-yellow-900/50 text-yellow-300 border-yellow-700',
  GLS:    'bg-teal-900/50 text-teal-300 border-teal-700',
  'LOC BC': 'bg-orange-900/50 text-orange-300 border-orange-700',
}

function RunwayTab({ runways }: { runways: RunwayInfo[] }) {
  if (runways.length === 0) return (
    <p className="text-xs text-gray-500 text-center py-6">활주로 정보 없음</p>
  )
  return (
    <div className="space-y-1">
      <div className="grid grid-cols-[3rem_3.5rem_5rem_4rem_4rem] gap-x-3 px-1 pb-1 text-[10px] font-semibold text-gray-500 uppercase tracking-wide">
        <span>RWY</span><span>방위(M)</span><span>길이(ft)</span><span>폭(ft)</span><span>표고(ft)</span>
      </div>
      {runways.map(r => (
        <div key={r.id} className="grid grid-cols-[3rem_3.5rem_5rem_4rem_4rem] gap-x-3 px-1 py-1.5 rounded-lg hover:bg-gray-800/40 items-center">
          <span className="text-xs font-mono font-bold text-white">{r.id.replace('RW', '')}</span>
          <span className="text-xs font-mono text-gray-300">{r.bearing_m.toFixed(0)}°</span>
          <span className="text-xs font-mono text-gray-300">{r.length_ft.toLocaleString()}</span>
          <span className="text-xs font-mono text-gray-300">{r.width_ft}</span>
          <span className="text-xs font-mono text-gray-300">{r.elevation_ft}</span>
        </div>
      ))}
    </div>
  )
}

// ── Approach tab ─────────────────────────────────────────────────────────────

function fullProcName(p: ApproachProc): string {
  const suffix = p.procedure.slice(1 + p.runway.length)
  const parts = [p.type, 'RWY', p.runway]
  if (suffix) parts.push(`(${suffix})`)
  if (p.rnp_ar) parts.push('AR')
  return parts.join(' ')
}

function ApproachTab({ approaches }: { approaches: ApproachProc[] }) {
  if (approaches.length === 0) return (
    <p className="text-xs text-gray-500 text-center py-6">접근절차 정보 없음</p>
  )

  // Group by runway
  const grouped = new Map<string, ApproachProc[]>()
  for (const ap of approaches) {
    const key = ap.runway
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key)!.push(ap)
  }
  const sorted = [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))

  return (
    <div className="space-y-3">
      {sorted.map(([runway, procs]) => {
        const ils = procs.find(p => p.ils)?.ils
        return (
          <div key={runway}>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[11px] font-bold text-white font-mono">RWY {runway}</span>
              {ils && (
                <span className="text-[10px] font-mono text-blue-300">
                  ILS {ils.frequency} MHz{ils.category ? ` · CAT ${ils.category}` : ''}
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5 pl-1">
              {procs.map(p => {
                const typeColor = TYPE_COLOR[p.type] ?? 'bg-gray-800 text-gray-300 border-gray-600'
                return (
                  <span
                    key={p.procedure}
                    title={fullProcName(p)}
                    className={`text-[10px] font-mono px-2 py-0.5 rounded border ${typeColor} flex items-center gap-1 cursor-default`}
                  >
                    {p.procedure}
                    {p.rnp_ar && <span className="text-[8px] font-semibold opacity-70">AR</span>}
                  </span>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── 스케줄 탭 — FOIS(국토부) 실제 제출 ATC 비행계획 기준, 이 공항을 출발/도착하는
// 오늘의 전 항공사 스케줄. 저장된 Navblue 항로 DB와 무관하게 실제 신청분 그대로.
// 행 끝의 버튼으로 그 편의 실제 항로를 지도에 오버레이(다시 누르면 해제) ──────────

type FoisSection = { loading: boolean; flights: FoisFlight[]; error?: string }

// FOIS 시각은 KST("HHMM")로 옴 — 항공 운항 관행대로 UTC(Zulu)로 바꿔서 표시.
// FOIS는 조회 날짜를 "출발일" 기준으로 편을 골라오므로, 도착시각(eta/sta)이
// 출발시각(priorKst)보다 시계상 이르면 자정을 넘겨 "다음날" 도착한 것 — 이 경우
// 그냥 오늘 그 시각으로 오해하면 실제보다 하루 이른 UTC로 잘못 표시됨(반대로도
// 마찬가지). priorKst를 주면 그 기준으로 다음날 여부를 판단해서 정확히 환산.
function kstToUtc(t: string | null, priorKst?: string | null): string {
  if (!t || t.length !== 4) return '—'
  const h = parseInt(t.slice(0, 2), 10)
  const m = parseInt(t.slice(2), 10)
  let dayOffset = 0
  if (priorKst && priorKst.length === 4) {
    const priorH = parseInt(priorKst.slice(0, 2), 10)
    if (h < priorH) dayOffset = 1  // 기준 시각(출발)보다 이르면 자정을 넘긴 것
  }
  const totalMin = dayOffset * 1440 + h * 60 + m
  const utcMin = totalMin - 9 * 60
  const dayDelta = Math.floor(utcMin / 1440)
  const wrapped = utcMin - dayDelta * 1440
  const uh = Math.floor(wrapped / 60), um = wrapped % 60
  const tag = dayDelta < 0 ? ' (-1)' : dayDelta > 0 ? ' (+1)' : ''
  return `${String(uh).padStart(2, '0')}:${String(um).padStart(2, '0')}${tag}`
}

function ScheduleRows({
  flights, otherAirport, timeOf, refTimeOf, overlayIds, rowStatus, onToggleOverlay,
}: {
  flights: FoisFlight[]
  otherAirport: (f: FoisFlight) => string
  timeOf: (f: FoisFlight) => string | null
  refTimeOf?: (f: FoisFlight) => string | null
  overlayIds: Set<number>
  rowStatus: Record<number, 'loading' | 'error'>
  onToggleOverlay: (f: FoisFlight) => void
}) {
  if (flights.length === 0) {
    return <p className="text-[11px] text-gray-600 py-2">오늘 신청된 편 없음</p>
  }
  return (
    <div className="max-h-52 overflow-y-auto space-y-0.5 pr-1">
      {flights.map(f => {
        const pk = f.ams_rec_pk
        const status = pk != null ? rowStatus[pk] : undefined
        const overlaid = pk != null && overlayIds.has(pk)
        return (
          <div key={pk ?? f.callsign} className="flex items-center gap-2 text-[11px] py-0.5">
            <span className="font-mono text-gray-300 shrink-0 w-16 truncate">{f.callsign}</span>
            <span className="font-mono text-gray-500 shrink-0 w-10">{otherAirport(f)}</span>
            <span className="text-gray-500 shrink-0 whitespace-nowrap">
              {kstToUtc(timeOf(f), refTimeOf?.(f))} <span className="text-gray-700">UTC</span>
            </span>
            {f.dep_status === 'DLA' && (
              <span className="text-[9px] px-1 py-0.5 rounded bg-amber-900/40 text-amber-300 border border-amber-700 shrink-0">지연</span>
            )}
            <span className="flex-1" />
            <button
              onClick={() => onToggleOverlay(f)}
              disabled={pk == null || status === 'loading'}
              title={overlaid ? '오버레이 해제' : '지도에 항로 오버레이'}
              className={`shrink-0 p-1 rounded transition-colors ${
                overlaid ? 'text-cyan-400 hover:text-cyan-300'
                  : status === 'error' ? 'text-red-500 hover:text-red-400'
                  : 'text-gray-600 hover:text-gray-300'
              }`}
            >
              {status === 'loading' ? <Loader2 size={12} className="animate-spin" /> : <Route size={12} />}
            </button>
          </div>
        )
      })}
    </div>
  )
}

function ScheduleTab({ icao }: { icao: string }) {
  const { state, dispatch } = useApp()
  const [dep, setDep] = useState<FoisSection>({ loading: true, flights: [] })
  const [arr, setArr] = useState<FoisSection>({ loading: true, flights: [] })
  const [rowStatus, setRowStatus] = useState<Record<number, 'loading' | 'error'>>({})

  useEffect(() => {
    setDep({ loading: true, flights: [] })
    api.fois.schedule({ dep: icao })
      .then(res => setDep({ loading: false, flights: res.flights, error: res.error }))
      .catch(() => setDep({ loading: false, flights: [], error: '조회 실패' }))
    setArr({ loading: true, flights: [] })
    api.fois.schedule({ arr: icao })
      .then(res => setArr({ loading: false, flights: res.flights, error: res.error }))
      .catch(() => setArr({ loading: false, flights: [], error: '조회 실패' }))
  }, [icao])

  const overlayIds = new Set(Object.keys(state.foisOverlayRoutes).map(Number))

  async function toggleOverlay(f: FoisFlight) {
    if (f.ams_rec_pk == null) return
    const pk = f.ams_rec_pk
    if (overlayIds.has(pk)) {
      dispatch({ type: 'REMOVE_FOIS_OVERLAY_ROUTE', payload: pk })
      return
    }
    setRowStatus(s => ({ ...s, [pk]: 'loading' }))
    try {
      const res = await api.fois.route(pk)
      if (res.error || !res.coordinates) {
        setRowStatus(s => ({ ...s, [pk]: 'error' }))
        return
      }
      dispatch({
        type: 'ADD_FOIS_OVERLAY_ROUTE',
        payload: {
          ams_rec_pk: pk, callsign: f.callsign,
          dep: f.dep ?? res.dep ?? '', arr: f.arr ?? res.arr ?? '',
          coordinates: res.coordinates, legs: res.legs ?? [], waypoints: res.waypoints ?? [],
          color: airlineColor(f.callsign),
        },
      })
      setRowStatus(s => { const n = { ...s }; delete n[pk]; return n })
    } catch {
      setRowStatus(s => ({ ...s, [pk]: 'error' }))
    }
  }

  const overlayCount = Object.keys(state.foisOverlayRoutes).length

  return (
    <div className="space-y-3">
      <div>
        <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-1">
          출발편 {!dep.loading && `(${dep.flights.length})`}
        </div>
        {dep.loading ? (
          <p className="text-[11px] text-gray-600 py-2">불러오는 중…</p>
        ) : dep.error ? (
          <p className="text-[11px] text-red-400 py-2">조회 실패 ({dep.error})</p>
        ) : (
          <ScheduleRows
            flights={dep.flights} otherAirport={f => f.arr ?? '—'} timeOf={f => f.etd ?? f.sched_time}
            overlayIds={overlayIds} rowStatus={rowStatus} onToggleOverlay={toggleOverlay}
          />
        )}
      </div>

      <div>
        <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-1">
          도착편 {!arr.loading && `(${arr.flights.length})`}
        </div>
        {arr.loading ? (
          <p className="text-[11px] text-gray-600 py-2">불러오는 중…</p>
        ) : arr.error ? (
          <p className="text-[11px] text-red-400 py-2">조회 실패 ({arr.error})</p>
        ) : (
          <ScheduleRows
            flights={arr.flights} otherAirport={f => f.dep ?? '—'} timeOf={f => f.eta ?? f.sta}
            refTimeOf={f => f.etd ?? f.sched_time}
            overlayIds={overlayIds} rowStatus={rowStatus} onToggleOverlay={toggleOverlay}
          />
        )}
      </div>

      {overlayCount > 0 && (
        <button
          onClick={() => dispatch({ type: 'CLEAR_FOIS_OVERLAY_ROUTES' })}
          className="w-full text-[10px] text-cyan-400 hover:text-cyan-300 border border-cyan-800 rounded py-1.5 transition-colors"
        >
          지도 오버레이 모두 지우기 ({overlayCount})
        </button>
      )}

      <p className="text-[9px] text-gray-600">출처: FOIS(국토교통부) 실제 제출 ATC 비행계획</p>
    </div>
  )
}

// ── Main panel ───────────────────────────────────────────────────────────────

export default function AirportPanel() {
  const { state, dispatch } = useApp()
  const [trendOpen, setTrendOpen] = useState(false)

  const icao = state.selectedAirportIcao
  if (!icao) return null
  const icaoStr: string = icao

  const weatherData = state.weatherData[icaoStr]
  const detail = state.airportDetail[icaoStr]
  const tab = state.activeAirportTab

  const thresholds = getThresholds(state.weatherConfig, icaoStr)
  const hasAirportOverride = Boolean(state.weatherConfig.airports[icaoStr])

  const levelFromData: WeatherLevel = weatherData ? classifyLevel(weatherData, thresholds) : 1
  const maxTokenLevel = weatherData
    ? highlightSegments(weatherData.raw || '', thresholds).reduce((m, s) => Math.max(m, s.level), 0)
    : 0
  const level: WeatherLevel = Math.max(levelFromData, maxTokenLevel) as WeatherLevel
  const cfg = weatherData ? LEVEL_CONFIG[level] : null

  function close() { dispatch({ type: 'SET_SELECTED_AIRPORT', payload: null }) }

  async function refreshWeather() {
    dispatch({ type: 'SET_WEATHER_LOADING', payload: true })
    try {
      const res = await api.weather.bulk([icaoStr])
      if (res.data) dispatch({ type: 'SET_WEATHER_DATA', payload: res.data })
    } finally {
      dispatch({ type: 'SET_WEATHER_LOADING', payload: false })
    }
  }

  return (
    <>
    <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-30 w-max min-w-80 max-w-[90vw] bg-gray-900/95 backdrop-blur border border-gray-700 rounded-2xl shadow-2xl">

      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-800">
        <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${cfg?.dot ?? 'bg-gray-600'} ${level === 3 ? 'animate-pulse' : ''}`} />
        <div className="flex-1 min-w-0">
          <span className="text-sm font-bold text-white">{icaoStr}</span>
          {detail?.name && (
            <span className="ml-2 text-[10px] text-gray-500 truncate max-w-[12rem] inline-block align-middle">
              {detail.name}
            </span>
          )}
          {cfg && (
            <span className={`ml-2 text-xs font-semibold px-1.5 py-0.5 rounded border ${cfg.bg} ${cfg.color}`}>
              {cfg.label}
            </span>
          )}
          {weatherData && (
            <span className="ml-2 text-xs text-gray-500 font-mono">{weatherData.flight_category}</span>
          )}
          {hasAirportOverride && (
            <span className="ml-1.5 text-[9px] font-semibold px-1 py-0.5 rounded bg-blue-900/60 border border-blue-700 text-blue-400">
              개별기준
            </span>
          )}
          {detail?.elevation_ft !== undefined && (
            <span className="ml-2 text-[10px] text-gray-500 font-mono">{detail.elevation_ft}ft</span>
          )}
        </div>
        {tab === 'weather' && (
          <>
            <button
              onClick={() => setTrendOpen(true)}
              title="날씨 트렌드"
              className="text-gray-600 hover:text-blue-400 transition-colors"
            >
              <TrendingUp size={13} />
            </button>
            <button
              onClick={() => dispatch({ type: 'OPEN_THRESHOLD_MODAL', payload: icaoStr })}
              title="기준 설정"
              className="text-gray-600 hover:text-blue-400 transition-colors"
            >
              <SlidersHorizontal size={13} />
            </button>
          </>
        )}
        <button onClick={refreshWeather} className="text-gray-600 hover:text-gray-300 transition-colors">
          <RefreshCw size={13} className={state.weatherLoading ? 'animate-spin' : ''} />
        </button>
        <button onClick={close} className="text-gray-600 hover:text-gray-300 transition-colors">
          <X size={15} />
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-800">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => dispatch({ type: 'SET_AIRPORT_TAB', payload: t.id })}
            className={`flex-1 py-2 text-xs font-semibold transition-colors ${
              tab === t.id
                ? 'text-white border-b-2 border-blue-500 -mb-px'
                : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Curfew banner */}
      <CurfewBanner curfew={state.curfews[icaoStr] ?? null} />

      {/* Tab content */}
      <div className="px-4 py-3">

        {/* 기상 */}
        {tab === 'weather' && (
          <div className="space-y-3">
            {!weatherData ? (
              <p className="text-xs text-gray-500 text-center py-4">
                {state.weatherLoading ? '불러오는 중...' : 'METAR 데이터 없음'}
              </p>
            ) : (
              <>
                <div className="bg-gray-950 rounded-lg px-3 py-2">
                  <HighlightedRaw
                    text={weatherData.raw || '—'}
                    thresholds={thresholds}
                    className="text-[11px] font-mono text-gray-300 leading-relaxed whitespace-nowrap"
                  />
                </div>
                {weatherData.taf_raw && (
                  <details className="group">
                    <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-300 select-none">
                      TAF 보기
                    </summary>
                    <div className="mt-2 bg-gray-950 rounded-lg px-3 py-2">
                      <HighlightedRaw
                        text={formatTaf(weatherData.taf_raw)}
                        thresholds={thresholds}
                        className="text-[10px] font-mono text-gray-400 leading-relaxed whitespace-pre-wrap"
                      />
                    </div>
                  </details>
                )}
                <p className="text-[10px] text-gray-600 text-right">
                  {weatherData.obs_time ? `관측: ${weatherData.obs_time}` : ''}
                </p>
              </>
            )}
          </div>
        )}

        {/* 활주로 */}
        {tab === 'runway' && (
          state.airportDetailLoading && !detail ? (
            <p className="text-xs text-gray-500 text-center py-6">불러오는 중...</p>
          ) : (
            <RunwayTab runways={detail?.runways ?? []} />
          )
        )}

        {/* 접근절차 */}
        {tab === 'approach' && (
          state.airportDetailLoading && !detail ? (
            <p className="text-xs text-gray-500 text-center py-6">불러오는 중...</p>
          ) : (
            <ApproachTab approaches={detail?.approaches ?? []} />
          )
        )}

        {/* 스케줄 */}
        {tab === 'schedule' && <ScheduleTab icao={icaoStr} />}

      </div>
    </div>
    {trendOpen && <WeatherTrendModal icao={icaoStr} onClose={() => setTrendOpen(false)} />}
    </>
  )
}
