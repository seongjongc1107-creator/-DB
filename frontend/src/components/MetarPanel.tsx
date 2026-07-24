import { useState } from 'react'
import { X, RefreshCw, SlidersHorizontal, TrendingUp } from 'lucide-react'
import WeatherTrendModal from './WeatherTrendModal'
import { useApp } from '../AppContext'
import type { MetarData, WeatherLevel, WeatherThresholds } from '../types'
import { api } from '../api/client'
import { classifyLevel, getThresholds, highlightSegments, type TextSegment } from '../lib/weatherClassify'

const LEVEL_CONFIG: Record<WeatherLevel, { label: string; color: string; bg: string; dot: string }> = {
  1: { label: '양호',  color: 'text-green-400', bg: 'bg-green-900/40 border-green-700', dot: 'bg-green-400' },
  2: { label: '주의',  color: 'text-amber-400', bg: 'bg-amber-900/40 border-amber-600', dot: 'bg-amber-400' },
  3: { label: '심각',  color: 'text-red-400',   bg: 'bg-red-900/40 border-red-600',     dot: 'bg-red-400'   },
}

function formatTaf(raw: string): string {
  return raw.replace(/\s+(TEMPO|BECMG|FM\d{6}|PROB\d{2})\b/g, '\n     $1').trim()
}

function HighlightedRaw({
  text,
  thresholds,
  className,
}: {
  text: string
  thresholds: WeatherThresholds
  className?: string
}) {
  const segs: TextSegment[] = highlightSegments(text, thresholds)
  return (
    <p className={className}>
      {segs.map((s, i) =>
        s.level === 3 ? (
          <span key={i} className="bg-red-500/25 text-red-300">{s.text}</span>
        ) : s.level === 2 ? (
          <span key={i} className="bg-amber-500/25 text-amber-300">{s.text}</span>
        ) : (
          <span key={i}>{s.text}</span>
        )
      )}
    </p>
  )
}

export default function MetarPanel() {
  const { state, dispatch } = useApp()
  const icao = state.selectedAirportIcao
  if (!icao) return null
  const icaoStr: string = icao

  const data: MetarData | undefined = state.weatherData[icaoStr]
  const [trendOpen, setTrendOpen] = useState(false)

  function close() {
    dispatch({ type: 'SET_SELECTED_AIRPORT', payload: null })
  }

  async function refresh() {
    dispatch({ type: 'SET_WEATHER_LOADING', payload: true })
    try {
      const res = await api.weather.bulk([icaoStr])
      if (res.data) dispatch({ type: 'SET_WEATHER_DATA', payload: res.data })
    } finally {
      dispatch({ type: 'SET_WEATHER_LOADING', payload: false })
    }
  }

  // Re-classify using user thresholds (may differ from backend's level)
  const thresholds = getThresholds(state.weatherConfig, icaoStr)
  const hasAirportOverride = Boolean(state.weatherConfig.airports[icaoStr])
  const levelFromData: WeatherLevel = data ? classifyLevel(data, thresholds) : 1
  // Take max of parsed-data level and raw-token level so CB clouds etc. are reflected
  const maxTokenLevel = data
    ? highlightSegments(data.raw || '', thresholds).reduce((m, s) => Math.max(m, s.level), 0)
    : 0
  const level: WeatherLevel = Math.max(levelFromData, maxTokenLevel) as WeatherLevel
  const cfg = data ? LEVEL_CONFIG[level] : null

  return (
    <>
    <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-30 w-max min-w-80 max-w-[90vw] bg-gray-900/95 backdrop-blur border border-gray-700 rounded-2xl shadow-2xl">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-800">
        <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${cfg?.dot ?? 'bg-gray-600'} ${level === 3 ? 'animate-pulse' : ''}`} />
        <div className="flex-1 min-w-0">
          <span className="text-sm font-bold text-white">{icaoStr}</span>
          {cfg && (
            <span className={`ml-2 text-xs font-semibold px-1.5 py-0.5 rounded border ${cfg.bg} ${cfg.color}`}>
              {cfg.label}
            </span>
          )}
          {data && (
            <span className="ml-2 text-xs text-gray-500 font-mono">{data.flight_category}</span>
          )}
          {hasAirportOverride && (
            <span className="ml-1.5 text-[9px] font-semibold px-1 py-0.5 rounded bg-blue-900/60 border border-blue-700 text-blue-400">
              개별기준
            </span>
          )}
        </div>
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
        <button onClick={refresh} className="text-gray-600 hover:text-gray-300 transition-colors">
          <RefreshCw size={13} className={state.weatherLoading ? 'animate-spin' : ''} />
        </button>
        <button onClick={close} className="text-gray-600 hover:text-gray-300 transition-colors">
          <X size={15} />
        </button>
      </div>

      <div className="px-4 py-3 space-y-3">
        {!data ? (
          <div className="text-xs text-gray-500 text-center py-4">
            {state.weatherLoading ? '불러오는 중...' : 'METAR 데이터 없음'}
          </div>
        ) : (
          <>
            {/* Raw METAR */}
            <div className="bg-gray-950 rounded-lg px-3 py-2">
              <HighlightedRaw
                text={data.raw || '—'}
                thresholds={thresholds}
                className="text-[11px] font-mono text-gray-300 leading-relaxed whitespace-nowrap"
              />
            </div>

            {/* Raw TAF */}
            {data.taf_raw && (
              <details className="group">
                <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-300 select-none">
                  TAF 보기
                </summary>
                <div className="mt-2 bg-gray-950 rounded-lg px-3 py-2">
                  <HighlightedRaw
                    text={formatTaf(data.taf_raw)}
                    thresholds={thresholds}
                    className="text-[10px] font-mono text-gray-400 leading-relaxed whitespace-pre-wrap"
                  />
                </div>
              </details>
            )}

            <p className="text-[10px] text-gray-600 text-right">{data.obs_time ? `관측: ${data.obs_time}` : ''}</p>
          </>
        )}
      </div>
    </div>

    {trendOpen && <WeatherTrendModal icao={icaoStr} onClose={() => setTrendOpen(false)} />}
    </>
  )
}
