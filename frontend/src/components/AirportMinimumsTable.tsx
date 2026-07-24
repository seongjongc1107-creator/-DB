import { useState, useMemo } from 'react'
import { X, Search, SlidersHorizontal, Settings2, ChevronDown, ChevronUp } from 'lucide-react'
import { useApp } from '../AppContext'
import { getThresholds, DEFAULT_THRESHOLDS } from '../lib/weatherClassify'
import type { WeatherThresholds } from '../types'

const COL_LABELS = ['시정 주의', '시정 심각', '운고 주의', '운고 심각', '돌풍 주의', '돌풍 심각']
const COL_UNITS  = ['m', 'm', 'ft', 'ft', 'kt', 'kt']

function thresholdCells(t: WeatherThresholds) {
  return [
    t.vis_caution_m,
    t.vis_severe_m,
    t.ceiling_caution_ft,
    t.ceiling_severe_ft,
    t.gust_caution_kt,
    t.gust_severe_kt,
  ]
}

type SortKey = 'icao' | 'status'

export default function AirportMinimumsTable({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useApp()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'configured' | 'default'>('all')
  const [sortKey, setSortKey] = useState<SortKey>('icao')
  const [sortAsc, setSortAsc] = useState(true)
  const [defaultsOpen, setDefaultsOpen] = useState(false)

  const allIcaos: string[] = useMemo(() => {
    if (!state.airportsGeoJSON) return []
    return state.airportsGeoJSON.features
      .map(f => f.properties?.id as string)
      .filter(Boolean)
      .sort()
  }, [state.airportsGeoJSON])

  const rows = useMemo(() => {
    let list = allIcaos.map(icao => ({
      icao,
      configured: Boolean(state.weatherConfig.airports[icao]),
      thresholds: getThresholds(state.weatherConfig, icao),
    }))

    if (query) {
      const q = query.toUpperCase()
      list = list.filter(r => r.icao.includes(q))
    }
    if (filter === 'configured') list = list.filter(r => r.configured)
    if (filter === 'default')    list = list.filter(r => !r.configured)

    list.sort((a, b) => {
      let cmp = 0
      if (sortKey === 'icao')   cmp = a.icao.localeCompare(b.icao)
      if (sortKey === 'status') cmp = Number(b.configured) - Number(a.configured)
      return sortAsc ? cmp : -cmp
    })

    return list
  }, [allIcaos, query, filter, sortKey, sortAsc, state.weatherConfig])

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortAsc(v => !v)
    else { setSortKey(key); setSortAsc(true) }
  }

  const configuredCount = allIcaos.filter(i => state.weatherConfig.airports[i]).length

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 backdrop-blur-sm pt-10 pb-10 overflow-y-auto">
      <div className="w-full max-w-5xl mx-4 bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="flex items-start gap-3 px-6 py-4 border-b border-gray-800 shrink-0">
          <div className="flex-1">
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <SlidersHorizontal size={15} className="text-amber-400" />
              공항 기상 최저치 관리
            </h2>
            <p className="text-xs text-gray-500 mt-1">
              공항마다 기상 최저치(DH/MDA, RVR 등)가 다릅니다. 각 공항의 실제 운항 최저치에 맞게 개별 설정하세요.
            </p>
            <div className="flex items-center gap-2 mt-2 text-xs">
              <span className="text-gray-400">전체 {allIcaos.length}개</span>
              <span className="text-gray-600">·</span>
              <span className="text-blue-400 font-semibold">개별 설정 {configuredCount}개</span>
              <span className="text-gray-600">·</span>
              <span className="text-gray-500">미설정 {allIcaos.length - configuredCount}개</span>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-600 hover:text-gray-300 transition-colors mt-0.5">
            <X size={17} />
          </button>
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-3 px-6 py-3 border-b border-gray-800 shrink-0">
          <div className="relative flex-1 max-w-64">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-600" />
            <input
              type="text"
              placeholder="ICAO 검색..."
              value={query}
              onChange={e => setQuery(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-8 pr-3 py-1.5 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-600"
            />
          </div>
          <div className="flex gap-1">
            {(['all', 'configured', 'default'] as const).map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  filter === f
                    ? 'bg-gray-700 text-white'
                    : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                {f === 'all' ? '전체' : f === 'configured' ? '개별설정' : '미설정'}
              </button>
            ))}
          </div>
        </div>

        {/* Table */}
        <div className="flex-1 overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-gray-900/95 backdrop-blur z-10">
              <tr className="border-b border-gray-800">
                <th
                  className="text-left px-4 py-2.5 text-gray-400 font-semibold cursor-pointer hover:text-white select-none w-24"
                  onClick={() => toggleSort('icao')}
                >
                  <span className="flex items-center gap-1">
                    공항
                    {sortKey === 'icao' ? (sortAsc ? <ChevronUp size={10} /> : <ChevronDown size={10} />) : null}
                  </span>
                </th>
                {COL_LABELS.map((label, i) => (
                  <th key={label} className="text-right px-3 py-2.5 font-semibold whitespace-nowrap">
                    <span className={i < 2 ? 'text-amber-500' : i < 4 ? 'text-sky-500' : 'text-purple-400'}>
                      {label}
                    </span>
                    <span className="text-gray-600 ml-1">{COL_UNITS[i]}</span>
                  </th>
                ))}
                <th
                  className="text-center px-3 py-2.5 text-gray-400 font-semibold cursor-pointer hover:text-white select-none"
                  onClick={() => toggleSort('status')}
                >
                  <span className="flex items-center justify-center gap-1">
                    상태
                    {sortKey === 'status' ? (sortAsc ? <ChevronUp size={10} /> : <ChevronDown size={10} />) : null}
                  </span>
                </th>
                <th className="px-3 py-2.5 w-12" />
              </tr>
            </thead>
            <tbody>
              {rows.map(row => {
                const cells = thresholdCells(row.thresholds)
                const def = thresholdCells(DEFAULT_THRESHOLDS)
                return (
                  <tr
                    key={row.icao}
                    className="border-b border-gray-800/50 hover:bg-gray-800/40 transition-colors"
                  >
                    <td className="px-4 py-2.5 font-mono font-bold text-white">{row.icao}</td>
                    {cells.map((v, i) => {
                      const isChanged = row.configured && v !== def[i]
                      return (
                        <td key={i} className="px-3 py-2.5 text-right">
                          <span className={`font-mono ${isChanged ? 'text-blue-300 font-semibold' : 'text-gray-400'}`}>
                            {v.toLocaleString()}
                          </span>
                        </td>
                      )
                    })}
                    <td className="px-3 py-2.5 text-center">
                      {row.configured ? (
                        <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-blue-900/60 border border-blue-700 text-blue-300">
                          개별설정
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-gray-800 border border-gray-700 text-gray-500">
                          미설정
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <button
                        onClick={() => dispatch({ type: 'OPEN_THRESHOLD_MODAL', payload: row.icao })}
                        className="p-1.5 rounded-lg text-gray-600 hover:text-blue-400 hover:bg-gray-800 transition-colors"
                        title={`${row.icao} 최저치 설정`}
                      >
                        <Settings2 size={13} />
                      </button>
                    </td>
                  </tr>
                )
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-4 py-8 text-center text-gray-600">
                    검색 결과 없음
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Default values section */}
        <div className="border-t border-gray-800 shrink-0">
          <button
            onClick={() => setDefaultsOpen(v => !v)}
            className="w-full flex items-center gap-2 px-6 py-3 text-xs text-gray-600 hover:text-gray-400 transition-colors"
          >
            {defaultsOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            <span>미설정 공항에 적용되는 임시 기본값</span>
            <span className="ml-auto text-gray-700 text-[10px]">
              개별 최저치가 없는 공항에만 적용됩니다 — 실제 운항 최저치와 다를 수 있습니다
            </span>
          </button>
          {defaultsOpen && (
            <div className="px-6 pb-4 flex items-center gap-4">
              <div className="flex gap-6 text-xs text-gray-400">
                <span>시정 주의 <span className="text-amber-400 font-mono">{state.weatherConfig.defaults.vis_caution_m}m</span></span>
                <span>시정 심각 <span className="text-red-400 font-mono">{state.weatherConfig.defaults.vis_severe_m}m</span></span>
                <span>운고 주의 <span className="text-amber-400 font-mono">{state.weatherConfig.defaults.ceiling_caution_ft}ft</span></span>
                <span>운고 심각 <span className="text-red-400 font-mono">{state.weatherConfig.defaults.ceiling_severe_ft}ft</span></span>
                <span>돌풍 주의 <span className="text-amber-400 font-mono">{state.weatherConfig.defaults.gust_caution_kt}kt</span></span>
                <span>돌풍 심각 <span className="text-red-400 font-mono">{state.weatherConfig.defaults.gust_severe_kt}kt</span></span>
              </div>
              <button
                onClick={() => dispatch({ type: 'OPEN_THRESHOLD_MODAL', payload: 'defaults' })}
                className="ml-auto flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-500 hover:text-gray-300 border border-gray-700 rounded-lg transition-colors"
              >
                <Settings2 size={11} />
                임시 기본값 수정
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
