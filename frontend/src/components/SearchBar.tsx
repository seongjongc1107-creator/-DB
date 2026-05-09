import { useState, useEffect, useRef, useCallback } from 'react'
import { Search, X, Route, Building2, MapPin } from 'lucide-react'
import { api } from '../api/client'
import { useApp } from '../AppContext'
import type { SearchResult } from '../types'

const TYPE_META: Record<string, { label: string; icon: React.ReactNode; color: string; textColor: string }> = {
  airway:  { label: 'AWY', icon: <Route size={10} />,     color: 'bg-orange-900/60',  textColor: 'text-orange-300' },
  airport: { label: 'APT', icon: <Building2 size={10} />, color: 'bg-red-900/60',     textColor: 'text-red-300'    },
  waypoint:{ label: 'WPT', icon: <MapPin size={10} />,    color: 'bg-gray-700/80',    textColor: 'text-gray-300'   },
}

export default function SearchBar() {
  const { dispatch } = useApp()
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

  async function onSelect(result: SearchResult) {
    setOpen(false)
    setQuery(result.name)

    if (result.type === 'airway') {
      dispatch({ type: 'SET_LOADING', payload: true })
      try {
        const [airwayGeoJSON, routeData, matchedGeoJSON] = await Promise.all([
          api.navdata.airway(result.id),
          api.navdata.airwayRoutes(result.id),
          api.routes.geometry({ fix: result.id }),
        ])
        dispatch({ type: 'SET_ACTIVE_AIRWAY', payload: result.id })
        dispatch({ type: 'SET_AIRWAY_GEOJSON', payload: airwayGeoJSON })
        dispatch({ type: 'SET_MATCHED_ROUTES_GEOJSON', payload: matchedGeoJSON })
        dispatch({ type: 'SET_ALL_ROUTES', payload: routeData.routes })
        dispatch({ type: 'SET_SELECTED_ROUTES', payload: routeData.routes.map(r => r.id) })
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
        dispatch({ type: 'SET_MATCHED_ROUTES_GEOJSON', payload: matchedGeoJSON })
        dispatch({ type: 'SET_ALL_ROUTES', payload: routeData.routes })
        dispatch({ type: 'SET_SELECTED_ROUTES', payload: routeData.routes.map(r => r.id) })
      } finally {
        dispatch({ type: 'SET_LOADING', payload: false })
      }
    }

    if (result.type === 'airport') {
      dispatch({ type: 'SET_ORIGIN', payload: result.id })
    }
  }

  function clear() {
    setQuery('')
    setResults([])
    dispatch({ type: 'SET_ACTIVE_AIRWAY', payload: null })
    dispatch({ type: 'SET_ACTIVE_WAYPOINT', payload: null })
    dispatch({ type: 'SET_AIRWAY_GEOJSON', payload: null })
    dispatch({ type: 'SET_MATCHED_ROUTES_GEOJSON', payload: null })
  }

  return (
    <div ref={containerRef} className="relative">
      {/* Label */}
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
        {query && (
          <button onClick={clear} className="text-gray-600 hover:text-gray-300 transition-colors shrink-0">
            <X size={13} />
          </button>
        )}
      </div>

      {/* Dropdown */}
      {open && results.length > 0 && (
        <div className="absolute top-full mt-1 left-0 right-0 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl z-50 overflow-hidden max-h-64 overflow-y-auto">
          {results.map(r => {
            const meta = TYPE_META[r.type]
            return (
              <button
                key={`${r.type}-${r.id}`}
                className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-gray-800 text-left transition-colors border-b border-gray-800 last:border-0"
                onClick={() => onSelect(r)}
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
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
