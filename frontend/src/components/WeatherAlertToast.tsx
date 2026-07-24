import { X, AlertTriangle, AlertOctagon } from 'lucide-react'
import { useApp } from '../AppContext'
import type { WeatherLevel } from '../types'

const LEVEL_STYLE: Record<WeatherLevel, { border: string; bg: string; icon: string; label: string }> = {
  1: { border: 'border-green-500', bg: 'bg-green-950/90', icon: 'text-green-400', label: '양호' },
  2: { border: 'border-amber-400', bg: 'bg-amber-950/90', icon: 'text-amber-400', label: '주의' },
  3: { border: 'border-red-500',   bg: 'bg-red-950/90',   icon: 'text-red-400',   label: '심각' },
}

export default function WeatherAlertToast() {
  const { state, dispatch } = useApp()
  const alerts = state.weatherAlerts

  if (alerts.length === 0) return null

  function dismiss(id: string) {
    dispatch({ type: 'DISMISS_WEATHER_ALERT', payload: id })
  }

  function dismissAll() {
    alerts.forEach(a => dispatch({ type: 'DISMISS_WEATHER_ALERT', payload: a.id }))
  }

  return (
    <div className="absolute top-4 right-4 z-50 flex flex-col w-80 pointer-events-none" style={{ maxHeight: 'calc(100vh - 2rem)' }}>
      {/* 헤더 */}
      <div className="pointer-events-auto flex items-center justify-between px-1 pb-1 shrink-0">
        <span className="text-[10px] text-gray-500">{alerts.length}개 알림</span>
        {alerts.length > 1 && (
          <button
            onClick={dismissAll}
            className="text-[10px] text-gray-500 hover:text-gray-300 underline"
          >
            모두 닫기
          </button>
        )}
      </div>
      {/* 스크롤 영역 */}
      <div className="pointer-events-auto overflow-y-auto flex flex-col gap-2 pr-1" style={{ scrollbarWidth: 'thin' }}>
        {alerts.map(alert => {
          const s = LEVEL_STYLE[alert.level]
          const Icon = alert.level === 3 ? AlertOctagon : AlertTriangle
          return (
            <div
              key={alert.id}
              className={`flex items-start gap-3 rounded-xl border ${s.border} ${s.bg} px-3.5 py-3 shadow-2xl backdrop-blur animate-in slide-in-from-right-4 duration-300 shrink-0`}
            >
              <Icon size={16} className={`${s.icon} mt-0.5 shrink-0`} />
              <div className="flex-1 min-w-0">
                <div className={`text-xs font-bold ${s.icon} flex items-center gap-1.5`}>
                  <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-bold border ${s.border} ${s.icon}`}>
                    {s.label}
                  </span>
                  <span className="text-gray-400 font-normal">{alert.time}</span>
                </div>
                <p className="text-xs text-gray-200 mt-1 leading-snug break-all">{alert.message}</p>
              </div>
              <button
                onClick={() => dismiss(alert.id)}
                className="text-gray-600 hover:text-gray-300 shrink-0 mt-0.5"
              >
                <X size={13} />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
