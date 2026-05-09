import { useState } from 'react'
import { Layers, Hexagon, ChevronDown, ChevronUp } from 'lucide-react'
import LayerPanel from './LayerPanel'
import SpatialSearchPanel from './SpatialSearchPanel'

type Tab = 'layers' | 'spatial'

export default function RightPanel() {
  const [tab, setTab] = useState<Tab>('layers')
  const [collapsed, setCollapsed] = useState(false)

  return (
    <div className="absolute bottom-6 right-4 z-20 w-64 select-none">
      {/* Tab bar / header */}
      <div className="flex items-center bg-gray-900/95 backdrop-blur border border-gray-700 rounded-t-xl overflow-hidden">
        <button
          onClick={() => { setTab('layers'); setCollapsed(false) }}
          className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-semibold transition-colors ${
            tab === 'layers' && !collapsed
              ? 'bg-gray-800 text-white'
              : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          <Layers size={13} /> 레이어
        </button>
        <button
          onClick={() => { setTab('spatial'); setCollapsed(false) }}
          className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-semibold transition-colors border-l border-gray-700 ${
            tab === 'spatial' && !collapsed
              ? 'bg-gray-800 text-white'
              : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          <Hexagon size={13} /> 영역 검색
        </button>
        <button
          onClick={() => setCollapsed(v => !v)}
          className="px-2.5 py-2 text-gray-600 hover:text-gray-300 transition-colors border-l border-gray-700"
        >
          {collapsed ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
      </div>

      {/* Content */}
      {!collapsed && (
        <div className="bg-gray-950/95 backdrop-blur border border-t-0 border-gray-700 rounded-b-xl p-3 shadow-2xl">
          {tab === 'layers' && <LayerPanel />}
          {tab === 'spatial' && <SpatialSearchPanel />}
        </div>
      )}
    </div>
  )
}
