import { useState } from 'react'
import { X, RefreshCw, SlidersHorizontal, Moon, TrendingUp } from 'lucide-react'
import { useApp } from '../AppContext'
import type { AirportTab, ApproachProc, CurfewInfo, RunwayInfo, WeatherLevel, WeatherThresholds } from '../types'
import { api } from '../api/client'
import { classifyLevel, getThresholds, highlightSegments, type TextSegment } from '../lib/weatherClassify'
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

      </div>
    </div>
    {trendOpen && <WeatherTrendModal icao={icaoStr} onClose={() => setTrendOpen(false)} />}
    </>
  )
}
