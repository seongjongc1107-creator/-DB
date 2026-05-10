import { useState, useEffect, useRef, useCallback } from 'react'
import { Search, X, Route, Building2, MapPin } from 'lucide-react'
import * as turf from '@turf/turf'
import { api } from '../api/client'
import { useApp } from '../AppContext'
import type { SearchResult } from '../types'

const TYPE_META: Record<string, { label: string; icon: React.ReactNode; color: string; textColor: string; chipColor: string }> = {
  airway:  { label: 'AWY', icon: <Route size={10} />,     color: 'bg-orange-900/60',  textColor: 'text-orange-300', chipColor: 'bg-orange-900/40 border-orange-700 text-orange-300' },
  airport: { label: 'APT', icon: <Building2 size={10} />, color: 'bg-red-900/60',     textColor: 'text-red-300',    chipColor: 'bg-red-900/40 border-red-700 text-red-300'    },
  waypoint:{ label: 'WPT', icon: <MapPin size={10} />,    color: 'bg-gray-700/80',    textColor: 'text-gray-300',   chipColor: 'bg-cyan-900/40 border-cyan-700 text-cyan-300'   },
}

export default function SearchBar() {
  const { state, dispatch } = useApp()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [open, setOpen] = useState(false)
  const [focused, setFocused] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const runSearch = useCallback(async (q: string) => {
    if (q.trim().length < 1) { setResults([]); return }
    try {
      const data = await api.search(q)
      setResults(data)
      setOpen(true)
    } catch {
      setResults([])
    }
  }, [])

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => runSearch(query), 250)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [query, runSearch])

  useEffect(() => {
    function handle(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
        setFocused(false)
      }
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [])

  // 첫 번째 선택이면 그대로, 이미 선택 항목이 있으면 교집합만 남김
  function applyRoutes(
    newRoutes: import('../types').RouteMeta[],
    newGeoJSON: import('../types').GeoJSONFeatureCollection,
  ) {
    const isFirst = state.highlightPoints.length === 0

    if (isFirst) {
      dispatch({ type: 'SET_ALL_ROUTES', payload: newRoutes })
      dispatch({ type: 'SET_MATCHED_ROUTES_GEOJSON', payload: newGeoJSON })
    } else {
      const newIds = new Set(newRoutes.map(r => r.id))
      const intersected = state.allRoutes.filter(r => newIds.has(r.id))
      const intersectedIds = new Set(intersected.map(r => r.id))
      const filteredGeo = {
        type: 'FeatureCollection' as const,
        features: (state.matchedRoutesGeoJSON?.features ?? []).filter(
          f => intersectedIds.has(f.properties?.id as number),
        ),
      }
      dispatch({ type: 'SET_ALL_ROUTES', payload: intersected })
      dispatch({ type: 'SET_MATCHED_ROUTES_GEOJSON', payload: filteredGeo })
    }
  }

  async function onSelect(result: SearchResult) {
    setOpen(false)
    setQuery('')

    dispatch({ type: 'ADD_HIGHLIGHT', payload: result })

    if (result.type === 'airway') {
      dispatch({ type: 'SET_LOADING', payload: true })
      try {
        const [airwayGeoJSON, routeData, matchedGeoJSON] = await Promise.all([
          api.navdata.airway(result.id),
          api.navdata.airwayRoutes(result.id),
          api.routes.geometry({ fix: result.id }),
        ])
        dispatch({ type: 'SET_ACTIVE_AIRWAY', payload: result.id })
        dispatch({ type: 'MERGE_AIRWAY_GEOJSON', payload: airwayGeoJSON })
        applyRoutes(routeData.routes, matchedGeoJSON)

        try {
          const [minLon, minLat, maxLon, maxLat] = turf.bbox(airwayGeoJSON as any)
          dispatch({ type: 'SET_FIT_BOUNDS', payload: [[minLon, minLat], [maxLon, maxLat]] })

          // 항공로 끝점 마커용 좌표 추출
          const endpoints: Array<{ id: string; lon: number; lat: number }> = []
          for (const f of airwayGeoJSON.features) {
            const coords = f.geometry.coordinates as number[][]
            if (coords.length >= 1) {
              const first = coords[0]
              const last = coords[coords.length - 1]
              endpoints.push({ id: `${result.id}-start`, lon: first[0], lat: first[1] })
              if (coords.length > 1) {
                endpoints.push({ id: `${result.id}-end`, lon: last[0], lat: last[1] })
              }
            }
          }
          dispatch({ type: 'ADD_AIRWAY_ENDPOINTS', payload: endpoints })
        } catch {}
      } finally {
        dispatch({ type: 'SET_LOADING', payload: false })
      }
    }

    if (result.type === 'waypoint') {
      dispatch({ type: 'SET_LOADING', payload: true })
      try {
        const [routeData, matchedGeoJSON] = await Promise.all([
          api.routes.list({ fix: result.id }),
          api.routes.geometry({ fix: result.id }),
        ])
        dispatch({ type: 'SET_ACTIVE_WAYPOINT', payload: result.id })
        applyRoutes(routeData.routes, matchedGeoJSON)

        if (result.lat !== null && result.lon !== null) {
          dispatch({ type: 'SET_FLY_TO', payload: { lon: result.lon, lat: result.lat, zoom: 9 } })
        }
      } finally {
        dispatch({ type: 'SET_LOADING', payload: false })
      }
    }

    if (result.type === 'airport') {
      dispatch({ type: 'SET_ORIGIN', payload: result.id })
      if (result.lat !== null && result.lon !== null) {
        dispatch({ type: 'SET_FLY_TO', payload: { lon: result.lon, lat: result.lat, zoom: 8 } })
      }
    }
  }

  function removeHighlight(id: string) {
    dispatch({ type: 'REMOVE_HIGHLIGHT', payload: id })
  }

  function clear() {
    setQuery('')
    setResults([])
    dispatch({ type: 'CLEAR_HIGHLIGHTS' })
    dispatch({ type: 'CLEAR_AIRWAY_ENDPOINTS' })
    dispatch({ type: 'SET_ACTIVE_AIRWAY', payload: null })
    dispatch({ type: 'SET_ACTIVE_WAYPOINT', payload: null })
    dispatch({ type: 'SET_AIRWAY_GEOJSON', payload: null })
    dispatch({ type: 'SET_MATCHED_ROUTES_GEOJSON', payload: null })
  }

  const highlights = state.highlightPoints

  return (
    <div ref={containerRef} className="relative">
      <p className="text-[10px] text-gray-500 uppercase tracking-widest font-semibold mb-1.5">
        Airway · Airport · Waypoint
      </p>

      {/* Input */}
      <div className={`flex items-center gap-2 bg-gray-800 border rounded-lg px-3 py-2 transition-colors ${
        focused ? 'border-blue-500' : 'border-gray-700'
      }`}>
        <Search size={13} className={`shrink-0 transition-colors ${focused ? 'text-blue-400' : 'text-gray-500'}`} />
        <input
          className="flex-1 bg-transparent text-sm text-white placeholder-gray-600 outline-none min-w-0"
          placeholder="A582, RKSI, MINTO…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onFocus={() => { setFocused(true); results.length > 0 && setOpen(true) }}
          onBlur={() => setFocused(false)}
        />
        {(query || highlights.length > 0) && (
          <button onClick={clear} className="text-gray-600 hover:text-gray-300 transition-colors shrink-0">
            <X size={13} />
          </button>
        )}
      </div>

      {/* Selected chips */}
      {highlights.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {highlights.map(h => {
            const meta = TYPE_META[h.type]
            return (
              <span
                key={`${h.type}-${h.id}`}
                className={`flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded border ${meta.chipColor}`}
              >
                {meta.icon}
                {h.name}
                <button
                  onClick={() => removeHighlight(h.id)}
                  className="ml-0.5 opacity-60 hover:opacity-100 transition-opacity"
                >
                  <X size={9} />
                </button>
              </span>
            )
          })}
        </div>
      )}

      {/* Dropdown */}
      {open && results.length > 0 && (
        <div className="absolute top-full mt-1 left-0 right-0 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl z-50 overflow-hidden max-h-64 overflow-y-auto">
          {results.map(r => {
            const meta = TYPE_META[r.type]
            const alreadySelected = highlights.some(h => h.id === r.id)
            return (
              <button
                key={`${r.type}-${r.id}`}
                className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors border-b border-gray-800 last:border-0 ${
                  alreadySelected ? 'bg-gray-800/60 opacity-60' : 'hover:bg-gray-800'
                }`}
                onClick={() => !alreadySelected && onSelect(r)}
              >
                <span className={`flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0 ${meta.color} ${meta.textColor}`}>
                  {meta.icon}{meta.label}
                </span>
                <div className="flex-1 min-w-0">
                  <div className={`text-sm font-semibold ${meta.textColor}`}>{r.name}</div>
                  {r.description && (
                    <div className="text-xs text-gray-500 truncate mt-0.5">{r.description}</div>
                  )}
                </div>
                {alreadySelected && <span className="text-[10px] text-gray-600 shrink-0">선택됨</span>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
