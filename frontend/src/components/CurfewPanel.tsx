import { X, Trash2, Moon } from 'lucide-react'
import { useApp } from '../AppContext'
import { api } from '../api/client'

const TZ_SHORT: Record<string, string> = {
  'Asia/Seoul': 'KST',
  'Asia/Tokyo': 'JST',
  'Asia/Shanghai': 'CST',
  'Asia/Hong_Kong': 'HKT',
  'Asia/Singapore': 'SGT',
  'Asia/Bangkok': 'ICT',
  'Asia/Taipei': 'CST',
  'UTC': 'UTC',
}

function tzLabel(tz: string) {
  return TZ_SHORT[tz] ?? tz
}

export default function CurfewPanel() {
  const { state, dispatch } = useApp()

  if (!state.curfewPanelOpen) return null

  const curfews = Object.values(state.curfews).sort((a, b) => a.icao.localeCompare(b.icao))

  async function handleClear() {
    if (!confirm('커퓨 데이터를 모두 삭제할까요?')) return
    await api.curfew.clear()
    dispatch({ type: 'SET_CURFEWS', payload: [] })
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-[480px] max-h-[80vh] flex flex-col bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl">

        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-800 shrink-0">
          <Moon size={15} className="text-red-400" />
          <div className="flex-1">
            <p className="text-sm font-bold text-white">커퓨 공항 관리</p>
            <p className="text-[11px] text-gray-500 mt-0.5">
              업로드는 우측 상단 톱니바퀴 → 관리자 페이지에서 진행합니다
            </p>
          </div>
          <button onClick={() => dispatch({ type: 'TOGGLE_CURFEW_PANEL' })}
            className="text-gray-600 hover:text-gray-300 transition-colors">
            <X size={16} />
          </button>
        </div>

        {curfews.length > 0 && (
          <div className="px-5 py-3 border-b border-gray-800 shrink-0 flex items-center">
            <button onClick={handleClear}
              className="ml-auto flex items-center gap-1 text-[11px] text-gray-600 hover:text-red-400 transition-colors">
              <Trash2 size={11} /> 전체 삭제
            </button>
          </div>
        )}

        {/* List */}
        <div className="flex-1 overflow-y-auto px-5 py-3">
          {curfews.length === 0 ? (
            <div className="text-center py-10 text-gray-500">
              <Moon size={24} className="mx-auto mb-2 opacity-30" />
              <p className="text-xs">등록된 커퓨 공항이 없습니다</p>
              <p className="text-[11px] mt-1 text-gray-600">CSV/Excel 파일을 업로드하세요</p>
            </div>
          ) : (
            <div className="space-y-1">
              <div className="grid grid-cols-[3rem_5rem_5rem_5rem_1fr] gap-x-3 px-2 pb-2 text-[10px] font-semibold text-gray-500 uppercase tracking-wide">
                <span>ICAO</span><span>시작</span><span>종료</span><span>시간대</span><span>비고</span>
              </div>
              {curfews.map(c => (
                <div key={c.icao}
                  className="grid grid-cols-[3rem_5rem_5rem_5rem_1fr] gap-x-3 px-2 py-2 rounded-lg hover:bg-gray-800/50 items-center">
                  <span className="text-xs font-mono font-bold text-white">{c.icao}</span>
                  <span className="text-xs font-mono text-red-300">{c.start}</span>
                  <span className="text-xs font-mono text-orange-300">{c.end}</span>
                  <span className="text-[10px] text-gray-400">{tzLabel(c.timezone)}</span>
                  <span className="text-[10px] text-gray-500 truncate">{c.note}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-gray-800 shrink-0">
          <p className="text-[10px] text-gray-600">
            총 <span className="text-white font-semibold">{curfews.length}</span>개 공항 · 지도에서 빨간 링으로 표시됩니다
          </p>
        </div>
      </div>
    </div>
  )
}
