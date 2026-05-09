import { Layers } from 'lucide-react'
import { useApp } from '../AppContext'
import type { LayerState } from '../types'

const LAYER_CONFIG: { key: keyof LayerState; label: string; color: string }[] = [
  { key: 'routes', label: 'Navblue 항로', color: 'bg-blue-500' },
  { key: 'airports', label: '공항 (Airports)', color: 'bg-red-500' },
  { key: 'waypoints', label: 'Waypoints', color: 'bg-gray-400' },
  { key: 'activeAirway', label: 'Airway 경로', color: 'bg-yellow-400' },
  { key: 'matchedRoutes', label: '검색 결과 항로', color: 'bg-green-500' },
  { key: 'typhoon', label: '태풍 구역', color: 'bg-orange-500' },
  { key: 'fir', label: 'FIR 경계', color: 'bg-cyan-400' },
]

export default function LayerPanel() {
  const { state, dispatch } = useApp()

  return (
    <div className="bg-gray-900 border border-gray-700 rounded-lg p-3">
      <div className="flex items-center gap-2 mb-3">
        <Layers size={14} className="text-gray-400" />
        <span className="text-xs font-semibold text-gray-300 uppercase tracking-wider">Layers</span>
      </div>
      <div className="space-y-2">
        {LAYER_CONFIG.map(({ key, label, color }) => (
          <label key={key} className="flex items-center gap-3 cursor-pointer group">
            <div
              className={`relative w-8 h-4 rounded-full transition-colors ${
                state.layers[key] ? 'bg-blue-600' : 'bg-gray-600'
              }`}
              onClick={() => dispatch({ type: 'TOGGLE_LAYER', payload: key })}
            >
              <div
                className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform ${
                  state.layers[key] ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </div>
            <div className="flex items-center gap-2">
              <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${color}`} />
              <span className="text-xs text-gray-300 group-hover:text-white transition-colors">
                {label}
              </span>
            </div>
          </label>
        ))}
      </div>
    </div>
  )
}
