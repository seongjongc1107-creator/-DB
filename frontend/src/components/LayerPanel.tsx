import { Layers, Moon, PlaneTakeoff } from 'lucide-react'
import { useApp } from '../AppContext'
import type { LayerState } from '../types'

const LAYER_CONFIG: { key: keyof LayerState; label: string; color: string }[] = [
  { key: 'routes',        label: 'Navblue 항로',    color: 'bg-blue-500' },
  { key: 'airports',      label: '공항 (Airports)', color: 'bg-red-500' },
  { key: 'waypoints',     label: 'Waypoints',       color: 'bg-gray-500' },
  { key: 'activeAirway',  label: 'Airway 경로',     color: 'bg-yellow-400' },
  { key: 'matchedRoutes', label: '검색 결과 항로',  color: 'bg-emerald-500' },
  { key: 'typhoon',       label: '태풍 구역',       color: 'bg-orange-500' },
  { key: 'fir',           label: 'FIR 경계',        color: 'bg-slate-400' },
]

export default function LayerPanel() {
  const { state, dispatch } = useApp()
  const curfewCount = Object.keys(state.curfews).length

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

        {/* Traffic row */}
        <div className="flex items-center gap-3 pt-1 border-t border-gray-800">
          <div
            className={`relative w-8 h-4 rounded-full transition-colors cursor-pointer ${
              state.layers.traffic ? 'bg-blue-600' : 'bg-gray-600'
            }`}
            onClick={() => dispatch({ type: 'TOGGLE_LAYER', payload: 'traffic' })}
          >
            <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform ${
              state.layers.traffic ? 'translate-x-4' : 'translate-x-0.5'
            }`} />
          </div>
          <div className="flex items-center gap-2 flex-1">
            <PlaneTakeoff size={11} className="text-orange-400 shrink-0" />
            <span className="text-xs text-gray-300">실시간 Traffic</span>
            {state.layers.traffic && (
              <span className="ml-auto flex items-center gap-1">
                {state.trafficLoading && (
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                )}
                {state.trafficData.length > 0 && (
                  <span className="text-[10px] text-gray-500">
                    {state.trafficData.length}대
                    {state.trafficData.filter(a => a.is_jja).length > 0 && (
                      <span className="text-orange-400 ml-1">
                        JJA {state.trafficData.filter(a => a.is_jja).length}
                      </span>
                    )}
                  </span>
                )}
              </span>
            )}
          </div>
        </div>

        {/* Curfew row */}
        <div className="flex items-center gap-3 pt-1 border-t border-gray-800">
          <div
            className={`relative w-8 h-4 rounded-full transition-colors cursor-pointer ${
              state.layers.curfew ? 'bg-blue-600' : 'bg-gray-600'
            }`}
            onClick={() => dispatch({ type: 'TOGGLE_LAYER', payload: 'curfew' })}
          >
            <div
              className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform ${
                state.layers.curfew ? 'translate-x-4' : 'translate-x-0.5'
              }`}
            />
          </div>
          <button
            onClick={() => dispatch({ type: 'TOGGLE_CURFEW_PANEL' })}
            className="flex items-center gap-2 group flex-1"
          >
            <div className="w-2.5 h-2.5 rounded-full shrink-0 ring-2 ring-red-500 bg-transparent" />
            <span className="text-xs text-gray-300 group-hover:text-white transition-colors">
              커퓨 공항
            </span>
            {curfewCount > 0 && (
              <span className="ml-auto text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-red-900/60 border border-red-700 text-red-400">
                {curfewCount}
              </span>
            )}
            <Moon size={11} className="text-gray-600 group-hover:text-red-400 transition-colors" />
          </button>
        </div>
      </div>
    </div>
  )
}
