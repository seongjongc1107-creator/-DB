import { useEffect, useState } from 'react'
import { Wind, RefreshCw, MapPin, AlertTriangle, FlaskConical, Play, Pause, X, Route } from 'lucide-react'
import * as turf from '@turf/turf'
import { api } from '../api/client'
import { useApp } from '../AppContext'
import type { Typhoon, TyphoonTrackPoint } from '../types'

const ALERT_LABEL: Record<string, string> = {
  Green: '열대저압부',
  Orange: '태풍',
  Red: '강태풍',
}

const ALERT_CLASS: Record<string, string> = {
  Green: 'text-yellow-400 bg-yellow-400/10 border-yellow-600',
  Orange: 'text-orange-400 bg-orange-400/10 border-orange-600',
  Red: 'text-red-400 bg-red-400/10 border-red-600',
}

const SLIDER_TRACK_COLOR: Record<string, string> = {
  Green: '#FCD34D',
  Orange: '#F97316',
  Red: '#EF4444',
}

function makeFilter(t: Typhoon) {
  const center: [number, number] = [t.lon, t.lat]
  const circle = turf.circle(center, t.radius_nm, { steps: 64, units: 'nauticalmiles' })
  const ring = circle.geometry.coordinates[0] as number[][]
  return { type: 'circle' as const, ring, center, radiusNm: t.radius_nm }
}

export default function TyphoonPanel() {
  const { state, dispatch } = useApp()
  const [error, setError] = useState<string | null>(null)
  const [fetched, setFetched] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [trackLoading, setTrackLoading] = useState<string | null>(null)

  // Auto-apply spatial filter whenever track step changes
  useEffect(() => {
    if (!state.typhoonTrack) return
    const pt = state.typhoonTrack[state.typhoonTrackStep]
    dispatch({ type: 'SET_TYPHOONS', payload: [pt] })
    dispatch({ type: 'SET_SPATIAL_FILTER', payload: makeFilter(pt) })
  }, [state.typhoonTrack, state.typhoonTrackStep]) // eslint-disable-line react-hooks/exhaustive-deps

  // Play: bump step every 800ms
  useEffect(() => {
    if (!playing || !state.typhoonTrack) return
    const id = setInterval(() => {
      const max = state.typhoonTrack!.length - 1
      const next = state.typhoonTrackStep < max ? state.typhoonTrackStep + 1 : 0
      dispatch({ type: 'SET_TYPHOON_TRACK_STEP', payload: next })
    }, 800)
    return () => clearInterval(id)
  }, [playing, state.typhoonTrackStep, state.typhoonTrack]) // eslint-disable-line react-hooks/exhaustive-deps

  async function fetchLive() {
    setFetched(true)
    dispatch({ type: 'SET_TYPHOON_LOADING', payload: true })
    setError(null)
    try {
      const data = await api.typhoon.active()
      if (data.error) setError(`GDACS 오류: ${data.error}`)
      dispatch({ type: 'SET_TYPHOONS', payload: data.typhoons })
      dispatch({ type: 'SET_TYPHOON_TRACK', payload: null })
    } catch {
      setError('데이터를 가져오지 못했습니다.')
    } finally {
      dispatch({ type: 'SET_TYPHOON_LOADING', payload: false })
    }
  }

  async function loadMock() {
    setError(null)
    setPlaying(false)
    try {
      const data = await api.typhoon.mock()
      dispatch({ type: 'SET_TYPHOON_TRACK', payload: data.track })
    } catch {
      setError('Mock 데이터 로드 실패')
    }
  }

  async function loadTrack(eventId: string) {
    setError(null)
    setPlaying(false)
    setTrackLoading(eventId)
    try {
      const data = await api.typhoon.track(eventId)
      if (data.error) { setError(`트랙 오류: ${data.error}`); return }
      if (!data.track || data.track.length === 0) { setError('트랙 데이터 없음'); return }
      dispatch({ type: 'SET_TYPHOON_TRACK', payload: data.track })
    } catch {
      setError('트랙 데이터를 가져오지 못했습니다.')
    } finally {
      setTrackLoading(null)
    }
  }

  function clearAll() {
    setPlaying(false)
    dispatch({ type: 'SET_TYPHOON_TRACK', payload: null })
    dispatch({ type: 'SET_TYPHOONS', payload: [] })
    dispatch({ type: 'CLEAR_SPATIAL' })
  }

  const track = state.typhoonTrack
  const step = state.typhoonTrackStep
  const currentPt = track ? track[step] : null

  return (
    <div className="space-y-3">
      {/* Action buttons */}
      <div className="flex gap-2">
        <button
          onClick={fetchLive}
          disabled={state.typhoonLoading}
          className="flex-1 flex items-center justify-center gap-1.5 px-2 py-2 bg-orange-700 hover:bg-orange-600 disabled:opacity-50 text-white rounded text-xs font-semibold transition-colors"
        >
          <RefreshCw size={11} className={state.typhoonLoading ? 'animate-spin' : ''} />
          실시간 조회
        </button>
        <button
          onClick={loadMock}
          className="flex-1 flex items-center justify-center gap-1.5 px-2 py-2 bg-purple-700 hover:bg-purple-600 text-white rounded text-xs font-semibold transition-colors"
        >
          <FlaskConical size={11} />
          모의 태풍
        </button>
        {(track || state.typhoons.length > 0) && (
          <button onClick={clearAll} className="text-gray-500 hover:text-red-400 transition-colors px-1">
            <X size={14} />
          </button>
        )}
      </div>

      {error && (
        <div className="flex items-start gap-2 text-xs text-red-400 bg-red-400/10 border border-red-800 rounded p-2">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          {error}
        </div>
      )}

      {/* Mock track player */}
      {track && currentPt && (
        <TrackPlayer
          track={track}
          step={step}
          playing={playing}
          onStepChange={s => dispatch({ type: 'SET_TYPHOON_TRACK_STEP', payload: s })}
          onTogglePlay={() => setPlaying(p => !p)}
        />
      )}

      {/* Live typhoon list */}
      {!track && state.typhoons.length > 0 && (
        <div className="space-y-2">
          {state.typhoons.map(t => (
            <TyphoonCard
              key={t.id}
              typhoon={t}
              trackLoading={trackLoading === t.id}
              onApply={() => dispatch({ type: 'SET_SPATIAL_FILTER', payload: makeFilter(t) })}
              onTrack={() => loadTrack(t.id)}
            />
          ))}
          <p className="text-[11px] text-gray-600 text-center">출처: GDACS (JTWC 포함)</p>
        </div>
      )}

      {/* Empty states */}
      {!track && fetched && !state.typhoonLoading && !error && state.typhoons.length === 0 && (
        <div className="text-xs text-gray-500 text-center py-3 space-y-1">
          <div className="text-lg">🌤</div>
          <div>현재 활성 태풍 없음</div>
          <div className="text-gray-600 text-[11px]">모의 태풍으로 기능을 테스트하세요</div>
        </div>
      )}

      {!track && !fetched && state.typhoons.length === 0 && (
        <p className="text-xs text-gray-600 text-center py-2">
          실시간 조회 또는 모의 태풍을 선택하세요
        </p>
      )}
    </div>
  )
}

// ── Track player ──────────────────────────────────────────────────────────────

function TrackPlayer({
  track, step, playing, onStepChange, onTogglePlay,
}: {
  track: TyphoonTrackPoint[]
  step: number
  playing: boolean
  onStepChange: (s: number) => void
  onTogglePlay: () => void
}) {
  const pt = track[step]
  const alertCls = ALERT_CLASS[pt.alert] ?? ALERT_CLASS.Orange
  const sliderColor = SLIDER_TRACK_COLOR[pt.alert] ?? '#F97316'
  const pct = (step / (track.length - 1)) * 100

  return (
    <div className={`rounded-lg border p-3 space-y-3 ${alertCls}`}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 font-bold text-xs">
          <Wind size={13} />
          {pt.name}
        </div>
        <span className="text-[10px] opacity-75">{ALERT_LABEL[pt.alert]}</span>
      </div>

      {/* Current step info */}
      <div className="text-[11px] opacity-80 space-y-0.5 font-mono">
        <div className="font-semibold text-xs not-italic">{pt.time}</div>
        <div className="flex items-center gap-1">
          <MapPin size={10} />
          {pt.lat.toFixed(1)}°N {pt.lon.toFixed(1)}°E
        </div>
        <div className="flex gap-3">
          <span>풍속 {pt.wind_kt} kt</span>
          <span>반경 {pt.radius_nm} NM</span>
        </div>
      </div>

      {/* Slider */}
      <div className="space-y-1.5">
        <input
          type="range"
          min={0}
          max={track.length - 1}
          value={step}
          onChange={e => onStepChange(Number(e.target.value))}
          className="w-full h-1.5 rounded-full appearance-none cursor-pointer"
          style={{
            background: `linear-gradient(to right, ${sliderColor} ${pct}%, #374151 ${pct}%)`,
          }}
        />
        <div className="flex justify-between text-[10px] opacity-50">
          <span>{track[0].time}</span>
          <span>{track[track.length - 1].time}</span>
        </div>
      </div>

      {/* Track timeline dots */}
      <div className="flex gap-1 justify-between">
        {track.map((p, i) => (
          <button
            key={i}
            onClick={() => onStepChange(i)}
            title={p.time}
            className={`w-2 h-2 rounded-full transition-all ${
              i === step
                ? 'scale-150 bg-white'
                : i < step
                  ? 'opacity-60'
                  : 'opacity-30'
            }`}
            style={{ backgroundColor: i === step ? '#fff' : SLIDER_TRACK_COLOR[p.alert] }}
          />
        ))}
      </div>

      {/* Play button */}
      <button
        onClick={onTogglePlay}
        className="w-full flex items-center justify-center gap-2 py-1.5 rounded bg-white/15 hover:bg-white/25 text-xs font-semibold transition-colors"
      >
        {playing ? <Pause size={12} /> : <Play size={12} />}
        {playing ? '일시정지' : '자동 재생'}
      </button>
    </div>
  )
}

// ── Live typhoon card ─────────────────────────────────────────────────────────

function TyphoonCard({ typhoon: t, trackLoading, onApply, onTrack }: {
  typhoon: Typhoon
  trackLoading: boolean
  onApply: () => void
  onTrack: () => void
}) {
  const alertCls = ALERT_CLASS[t.alert] ?? ALERT_CLASS.Orange
  return (
    <div className={`rounded-lg border p-2.5 space-y-2 ${alertCls}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 font-bold text-xs">
          <Wind size={13} />
          {t.name}
        </div>
        <span className="text-[10px] opacity-80">{ALERT_LABEL[t.alert] ?? t.alert}</span>
      </div>
      <div className="text-[11px] opacity-70 font-mono space-y-0.5">
        <div className="flex items-center gap-1">
          <MapPin size={10} />
          {t.lat.toFixed(2)}°N {t.lon.toFixed(2)}°E
        </div>
        <div className="flex gap-3">
          {t.wind_kt !== null && <span>최대풍속 {t.wind_kt} kt</span>}
          <span>경보반경 {t.radius_nm} NM</span>
        </div>
      </div>
      <div className="flex gap-1.5">
        <button
          onClick={onApply}
          className="flex-1 text-[11px] font-semibold py-1 rounded bg-white/10 hover:bg-white/20 transition-colors"
        >
          영역 필터 적용
        </button>
        <button
          onClick={onTrack}
          disabled={trackLoading}
          className="flex-1 flex items-center justify-center gap-1 text-[11px] font-semibold py-1 rounded bg-white/10 hover:bg-white/20 disabled:opacity-50 transition-colors"
        >
          <Route size={10} className={trackLoading ? 'animate-spin' : ''} />
          {trackLoading ? '로딩 중…' : '예보 트랙'}
        </button>
      </div>
    </div>
  )
}
