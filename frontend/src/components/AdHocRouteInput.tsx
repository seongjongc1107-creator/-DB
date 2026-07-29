import { useState } from 'react'
import { Route, X, Play } from 'lucide-react'
import * as turf from '@turf/turf'
import { api } from '../api/client'
import { useApp } from '../AppContext'
import type { GeoJSONFeatureCollection } from '../types'

export default function AdHocRouteInput() {
  const { dispatch } = useApp()
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function submit() {
    const lines = value.split('\n').map(l => l.trim()).filter(Boolean)
    if (lines.length === 0) return
    setLoading(true)
    setError(null)
    try {
      const results = await Promise.all(
        lines.map(line => api.routes.parse(line).catch(() => null)),
      )

      const features: GeoJSONFeatureCollection['features'] = []
      const warnings: string[] = []
      lines.forEach((line, i) => {
        const data = results[i]
        if (!data || data.features.length === 0) {
          warnings.push(`해석 실패: "${line}"`)
          return
        }
        features.push(...data.features)
        if (data.airway_gaps.length > 0) {
          warnings.push(`항로 연결 안 됨(직선으로 대체): ${data.airway_gaps.join(', ')}`)
        }
        if (data.unresolved.length > 0) {
          warnings.push(`못 찾은 토큰: ${data.unresolved.join(', ')}`)
        }
      })

      if (features.length === 0) {
        setError(warnings.join(' / ') || '경로를 해석하지 못했습니다')
        dispatch({ type: 'SET_ADHOC_ROUTE_GEOJSON', payload: null })
        return
      }
      const combined: GeoJSONFeatureCollection = { type: 'FeatureCollection', features }
      dispatch({ type: 'SET_ADHOC_ROUTE_GEOJSON', payload: combined })
      if (warnings.length > 0) setError(warnings.join(' / '))
      const [minLon, minLat, maxLon, maxLat] = turf.bbox(combined as any)
      dispatch({ type: 'SET_FIT_BOUNDS', payload: [[minLon, minLat], [maxLon, maxLat]] })
    } catch {
      setError('조회 중 오류가 발생했습니다')
    } finally {
      setLoading(false)
    }
  }

  function close() {
    setOpen(false)
    setValue('')
    setError(null)
    dispatch({ type: 'SET_ADHOC_ROUTE_GEOJSON', payload: null })
  }

  // 입력창에서 waypoint/공항 이름을 더블클릭하면 그 지점으로 이동
  async function handleDoubleClick(e: React.MouseEvent<HTMLTextAreaElement>) {
    const input = e.currentTarget
    const { selectionStart: start, selectionEnd: end } = input
    if (start === null || end === null || start === end) return
    const word = input.value.slice(start, end).trim()
    if (!word || word === 'DCT') return
    try {
      const results = await api.search(word)
      const match =
        results.find(r => r.id.toUpperCase() === word.toUpperCase() && r.lat !== null && r.lon !== null) ??
        results.find(r => r.lat !== null && r.lon !== null)
      if (match && match.lat !== null && match.lon !== null) {
        dispatch({ type: 'SET_FLY_TO', payload: { lon: match.lon, lat: match.lat, zoom: 9 } })
      }
    } catch {}
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        title="항로 직접 입력"
        className="shrink-0 flex items-center gap-1.5 bg-gray-900/90 hover:bg-gray-800 border border-gray-700 hover:border-purple-600 text-gray-400 hover:text-purple-400 text-xs font-semibold px-3 py-2 rounded-lg transition-all shadow-lg backdrop-blur"
      >
        <Route size={12} />
        항로 입력
      </button>
    )
  }

  return (
    <div className="shrink-0 w-80 bg-gray-900/95 border border-gray-700 rounded-lg shadow-2xl backdrop-blur px-3 py-2.5">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Route size={12} className="text-purple-400 shrink-0" />
        <span className="text-[10px] text-gray-500">Shift+Enter 줄바꿈(항로 추가) · Enter 오버레이</span>
        <button onClick={close} className="text-gray-500 hover:text-gray-200 shrink-0 ml-auto">
          <X size={14} />
        </button>
      </div>
      <div className="flex items-start gap-2">
        <textarea
          autoFocus
          rows={1}
          value={value}
          onChange={e => {
            setValue(e.target.value)
            const el = e.target
            el.style.height = 'auto'
            el.style.height = `${Math.min(el.scrollHeight, 200)}px`
          }}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }}
          onDoubleClick={handleDoubleClick}
          placeholder={'RKSI Y711 GTC DCT RKSS\nRKSS A582 OSKOR DCT RCTP'}
          className="flex-1 resize-none overflow-y-auto bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white placeholder-gray-600 font-mono leading-relaxed focus:outline-none focus:border-purple-600"
        />
        <button
          onClick={submit}
          disabled={loading}
          title="적용 (Enter)"
          className="shrink-0 flex items-center justify-center w-7 h-7 bg-purple-700 hover:bg-purple-600 disabled:opacity-50 text-white rounded transition-colors"
        >
          <Play size={12} />
        </button>
      </div>
      {loading && <div className="text-[10px] text-gray-500 mt-1.5">조회 중…</div>}
      {error && <div className="text-[10px] text-amber-400 mt-1.5">{error}</div>}
    </div>
  )
}
