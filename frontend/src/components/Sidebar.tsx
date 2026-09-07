import { Plane, Wind, ChevronDown } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import SearchBar from './SearchBar'
import RoutePanel from './RoutePanel'
import TyphoonPanel from './TyphoonPanel'
import { useApp } from '../AppContext'

export default function Sidebar() {
  const { state } = useApp()
  const [typhoonOpen, setTyphoonOpen] = useState(false)
  const typhoonScrollRef = useRef<HTMLDivElement>(null)
  // 태풍이 많아서 목록이 잘릴 때 스크롤 가능함을 알려주는 힌트 —
  // 트랙패드에서는 스크롤바가 조작 중에만 잠깐 보이고 평소엔 숨어 있어서
  // "더 있는데 스크롤이 안 된다"고 오해하기 쉬움
  const [hasMoreBelow, setHasMoreBelow] = useState(false)

  useEffect(() => {
    const el = typhoonScrollRef.current
    if (!typhoonOpen || !el) { setHasMoreBelow(false); return }
    const check = () => setHasMoreBelow(el.scrollHeight - el.scrollTop - el.clientHeight > 4)
    check()
    el.addEventListener('scroll', check)
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => { el.removeEventListener('scroll', check); ro.disconnect() }
  }, [typhoonOpen, state.typhoons.length, state.typhoonTrack])

  return (
    <aside className="w-72 shrink-0 bg-gray-950 border-r border-gray-800 flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-4 pt-4 pb-3 border-b border-gray-800 shrink-0">
        <div className="flex items-center gap-2 mb-0.5">
          <Plane size={16} className="text-blue-400" />
          <span className="text-white font-bold text-sm tracking-wide">Flight Route DB</span>
        </div>
        <p className="text-gray-600 text-xs">
          {state.allRoutes.length > 0 ? `${state.allRoutes.length}개 항로` : '로딩 중…'}
        </p>
      </div>

      {/* Search (airway / airport / waypoint) */}
      <div className="px-4 py-3 border-b border-gray-800 shrink-0">
        <SearchBar />
      </div>

      {/* Typhoon section */}
      <div className="px-4 py-3 border-b border-gray-800 shrink-0">
        <button
          onClick={() => setTyphoonOpen(o => !o)}
          className="w-full flex items-center justify-between text-xs text-gray-400 hover:text-orange-400 transition-colors"
        >
          <div className="flex items-center gap-2">
            <Wind size={13} className={state.typhoons.length > 0 ? 'text-orange-400' : ''} />
            <span className="font-semibold uppercase tracking-wider">태풍 모니터</span>
            {state.typhoons.length > 0 && (
              <span className="bg-orange-600 text-white text-[10px] px-1.5 py-0.5 rounded-full font-bold">
                {state.typhoons.length}
              </span>
            )}
          </div>
          <span className="text-gray-600">{typhoonOpen ? '▲' : '▼'}</span>
        </button>
        {typhoonOpen && (
          <div className="relative mt-3">
            <div ref={typhoonScrollRef} className="max-h-80 overflow-y-auto">
              <TyphoonPanel />
            </div>
            {hasMoreBelow && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center pb-0.5 pt-4 bg-gradient-to-t from-gray-950 to-transparent">
                <ChevronDown size={12} className="text-gray-500 animate-bounce" />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Route panel (OD selectors + list) — scrollable */}
      <div className="flex-1 overflow-hidden px-4 py-3 flex flex-col min-h-0">
        <RoutePanel />
      </div>
    </aside>
  )
}
