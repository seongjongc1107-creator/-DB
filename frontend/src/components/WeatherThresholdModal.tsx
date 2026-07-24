import { useState, useEffect } from 'react'
import { X, RotateCcw, Save, MapPin } from 'lucide-react'
import { useApp } from '../AppContext'
import { DEFAULT_THRESHOLDS, getThresholds } from '../lib/weatherClassify'
import type { WeatherThresholds } from '../types'

const ROWS: Array<{
  icon: string
  label: string
  caution: { key: keyof WeatherThresholds; unit: string; step: number; min: number; max: number }
  severe:  { key: keyof WeatherThresholds; unit: string; step: number; min: number; max: number }
}> = [
  {
    icon: '👁',
    label: '시정',
    caution: { key: 'vis_caution_m', unit: 'm', step: 100, min: 100, max: 20000 },
    severe:  { key: 'vis_severe_m',  unit: 'm', step: 100, min: 100, max: 10000 },
  },
  {
    icon: '☁',
    label: '운고',
    caution: { key: 'ceiling_caution_ft', unit: 'ft', step: 100, min: 100, max: 10000 },
    severe:  { key: 'ceiling_severe_ft',  unit: 'ft', step: 100, min: 100, max: 5000  },
  },
  {
    icon: '💨',
    label: '돌풍',
    caution: { key: 'gust_caution_kt', unit: 'kt', step: 1, min: 5,  max: 100 },
    severe:  { key: 'gust_severe_kt',  unit: 'kt', step: 1, min: 10, max: 100 },
  },
]

export default function WeatherThresholdModal() {
  const { state, dispatch } = useApp()
  const target = state.thresholdModalTarget
  if (!target) return null

  const isDefault = target === 'defaults'
  const targetStr: string = target

  const currentThresholds = isDefault
    ? state.weatherConfig.defaults
    : getThresholds(state.weatherConfig, targetStr)
  const hasAirportOverride = !isDefault && Boolean(state.weatherConfig.airports[targetStr])

  const [values, setValues] = useState<WeatherThresholds>(currentThresholds)

  useEffect(() => {
    const t = isDefault
      ? state.weatherConfig.defaults
      : getThresholds(state.weatherConfig, targetStr)
    setValues(t)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target])

  function close() { dispatch({ type: 'CLOSE_THRESHOLD_MODAL' }) }

  function handleChange(key: keyof WeatherThresholds, raw: string) {
    const n = Number(raw)
    if (!isNaN(n)) setValues(prev => ({ ...prev, [key]: n }))
  }

  function save() {
    if (isDefault) {
      dispatch({ type: 'SET_DEFAULT_THRESHOLDS', payload: values })
    } else {
      // Always save as airport-specific — no global override from here
      dispatch({ type: 'SET_AIRPORT_THRESHOLDS', payload: { icao: targetStr, thresholds: values } })
    }
    close()
  }

  function reset() {
    if (isDefault) {
      setValues(DEFAULT_THRESHOLDS)
    } else {
      dispatch({ type: 'RESET_AIRPORT_THRESHOLDS', payload: targetStr })
      close()
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-[460px] bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl">

        {/* Header */}
        <div className="flex items-start gap-3 px-5 py-4 border-b border-gray-800">
          <div className="flex-1">
            {isDefault ? (
              <>
                <p className="text-sm font-bold text-white">임시 기본값 수정</p>
                <p className="text-xs text-gray-500 mt-0.5">
                  개별 최저치가 설정되지 않은 공항에만 적용됩니다.
                </p>
              </>
            ) : (
              <>
                <p className="text-sm font-bold text-white flex items-center gap-2">
                  <MapPin size={13} className="text-blue-400" />
                  {targetStr} 기상 최저치
                </p>
                <p className="text-xs text-gray-500 mt-0.5">
                  이 공항에만 적용되는 개별 기준입니다.
                </p>
              </>
            )}
          </div>
          {hasAirportOverride && (
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-blue-900/60 border border-blue-700 text-blue-300 shrink-0">
              개별설정 중
            </span>
          )}
          <button onClick={close} className="text-gray-600 hover:text-gray-300 transition-colors shrink-0">
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Threshold inputs */}
          <div className="space-y-1">
            <div className="grid grid-cols-[72px_1fr_1fr] gap-3 pb-1">
              <div />
              <div className="text-center text-[11px] font-semibold text-amber-400">주의 기준 이하 →</div>
              <div className="text-center text-[11px] font-semibold text-red-400">심각 기준 이하 →</div>
            </div>

            {ROWS.map(row => (
              <div key={row.label} className="grid grid-cols-[72px_1fr_1fr] gap-3 items-center py-2 border-b border-gray-800/60 last:border-0">
                <div className="flex items-center gap-1.5">
                  <span>{row.icon}</span>
                  <span className="text-xs text-gray-300 font-medium">{row.label}</span>
                </div>

                <div className="relative">
                  <input
                    type="number"
                    value={values[row.caution.key]}
                    min={row.caution.min}
                    max={row.caution.max}
                    step={row.caution.step}
                    onChange={e => handleChange(row.caution.key, e.target.value)}
                    className="w-full bg-gray-800 border border-amber-700/50 hover:border-amber-600 focus:border-amber-500 focus:outline-none rounded-lg px-3 py-1.5 text-sm font-mono text-amber-200 text-right pr-10 transition-colors"
                  />
                  <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-gray-500 pointer-events-none">
                    {row.caution.unit}
                  </span>
                </div>

                <div className="relative">
                  <input
                    type="number"
                    value={values[row.severe.key]}
                    min={row.severe.min}
                    max={row.severe.max}
                    step={row.severe.step}
                    onChange={e => handleChange(row.severe.key, e.target.value)}
                    className="w-full bg-gray-800 border border-red-700/50 hover:border-red-600 focus:border-red-500 focus:outline-none rounded-lg px-3 py-1.5 text-sm font-mono text-red-200 text-right pr-10 transition-colors"
                  />
                  <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-gray-500 pointer-events-none">
                    {row.severe.unit}
                  </span>
                </div>
              </div>
            ))}
          </div>

          <p className="text-[11px] text-gray-600 flex items-center gap-1.5">
            <span className="text-amber-500">⚡</span>
            뇌우(TS) 발생 시 기준값에 무관하게 항상
            <span className="text-red-400 font-semibold">심각</span>으로 분류됩니다.
          </p>
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 px-5 py-3 border-t border-gray-800">
          <button
            onClick={reset}
            className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-red-400 transition-colors"
          >
            <RotateCcw size={11} />
            {isDefault ? '시스템 기본값 복원' : '개별 설정 삭제'}
          </button>
          <div className="flex-1" />
          <button
            onClick={close}
            className="px-4 py-1.5 text-xs text-gray-400 hover:text-white border border-gray-700 rounded-lg transition-colors"
          >
            취소
          </button>
          <button
            onClick={save}
            className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
          >
            <Save size={12} />
            {isDefault ? '저장' : `${targetStr} 저장`}
          </button>
        </div>
      </div>
    </div>
  )
}
