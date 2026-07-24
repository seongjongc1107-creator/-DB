import { useState } from 'react'
import { X, FileText, Save, Copy, Check } from 'lucide-react'
import type { CountryPermit, DummyFlight, PermitApplication } from './types'
import { SEASONS } from './dummyData'

interface Props {
  country: CountryPermit
  flight: DummyFlight
  routeNumber: number
  season: string
  onClose: () => void
  onSave: (app: PermitApplication) => void
}

const STATUS_LABELS = { valid: '유효', expiring: '만료임박', not_held: '미보유' }
const FL_OPTIONS = ['FL300', 'FL310', 'FL320', 'FL330', 'FL340', 'FL350', 'FL360', 'FL370', 'FL380', 'FL390', 'FL400']

export default function ApplicationPanel({ country, flight, routeNumber, season, onClose, onSave }: Props) {
  const seasonInfo = SEASONS[season] ?? SEASONS.S26
  const { info } = flight

  const [entryFix, setEntryFix] = useState(country.entryFix ?? '')
  const [exitFix, setExitFix] = useState(country.exitFix ?? '')
  const [cruiseLevel, setCruiseLevel] = useState(country.cruiseLevel ?? 'FL350')
  const [transitWindow, setTransitWindow] = useState(country.transitWindow ?? '')
  const [frequency, setFrequency] = useState('매일 (Daily)')
  const [contactInfo, setContactInfo] = useState('ops@koreanair.com')
  const [notes, setNotes] = useState('')
  const [copied, setCopied] = useState(false)

  const previewText = `==========================================
영공통과 허가 신청서 (OVERFLIGHT PERMIT REQUEST)
==========================================
항공사 (Airline):    ${info.airline}
편명 (Flight No.):   ${info.flightNumber} (Route ${routeNumber})
구간 (Route):        ${info.origin} → ${info.destination}
항공기 (Aircraft):   ${info.aircraftType} / ${info.registration}
운항 기간 (Period):  ${seasonInfo.from} ~ ${seasonInfo.to} (${season})

대상 국가 (Country): ${country.countryName} (${country.countryCode})
허가 종류:           ${country.permitType}

진입 Fix (Entry):    ${entryFix || '(미입력)'}
진출 Fix (Exit):     ${exitFix || '(미입력)'}
순항 고도 (FL):      ${cruiseLevel}
통과 시간대 (UTC):   ${transitWindow || '(미입력)'}
운항 빈도:           ${frequency}

담당자 연락처:       ${contactInfo}
${notes ? `\n비고: ${notes}` : ''}
==========================================`

  function handleSave(status: 'draft' | 'submitted') {
    const app: PermitApplication = {
      id: `${info.flightNumber}-R${routeNumber}-${country.countryCode}-${Date.now()}`,
      flightNumber: info.flightNumber,
      routeNumber,
      season,
      countryCode: country.countryCode,
      countryName: country.countryName,
      airline: info.airline,
      origin: info.origin,
      destination: info.destination,
      aircraftType: info.aircraftType,
      registration: info.registration,
      periodFrom: seasonInfo.from,
      periodTo: seasonInfo.to,
      entryFix,
      exitFix,
      cruiseLevel,
      transitWindow,
      frequency,
      contactInfo,
      notes,
      status,
      createdAt: new Date().toISOString(),
    }
    onSave(app)
  }

  function copyToClipboard() {
    navigator.clipboard.writeText(previewText)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="absolute right-0 top-0 h-full w-[400px] bg-gray-950 border-l border-gray-700 flex flex-col shadow-2xl z-30 overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-800 flex items-start justify-between shrink-0">
        <div>
          <div className="flex items-center gap-2">
            <FileText size={15} className="text-blue-400" />
            <span className="text-white font-bold text-sm">영공통과 허가 신청서</span>
          </div>
          <div className="text-xs text-gray-400 mt-1">
            {country.flag} {country.countryName} · {info.flightNumber} · {season}
          </div>
        </div>
        <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors mt-0.5">
          <X size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Auto-filled section */}
        <div className="px-4 pt-4 pb-2">
          <div className="text-[10px] text-gray-500 uppercase tracking-widest font-semibold mb-2">
            자동 입력 정보
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-lg divide-y divide-gray-800 text-xs">
            {[
              ['항공사', info.airline],
              ['편명', info.flightNumber],
              ['구간', `${info.origin} → ${info.destination}`],
              ['항공기', `${info.aircraftType} / ${info.registration}`],
              ['운항 기간', `${seasonInfo.from} ~ ${seasonInfo.to}`],
              ['대상 국가', `${country.flag} ${country.countryName} (${country.countryCode})`],
              ['허가 종류', country.permitType],
            ].map(([label, value]) => (
              <div key={label} className="flex items-center gap-2 px-3 py-2">
                <span className="text-gray-500 w-20 shrink-0">{label}</span>
                <span className="text-gray-300">{value}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Manual input section */}
        <div className="px-4 pt-2 pb-2">
          <div className="text-[10px] text-gray-500 uppercase tracking-widest font-semibold mb-2">
            추가 입력 사항
          </div>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[11px] text-gray-400 mb-1 block">진입 Fix (Entry)</label>
                <input
                  className="w-full bg-gray-800 border border-gray-700 text-white text-xs rounded px-2.5 py-2 outline-none focus:border-blue-500"
                  value={entryFix}
                  onChange={e => setEntryFix(e.target.value.toUpperCase())}
                  placeholder="예) BOBTU"
                />
              </div>
              <div>
                <label className="text-[11px] text-gray-400 mb-1 block">진출 Fix (Exit)</label>
                <input
                  className="w-full bg-gray-800 border border-gray-700 text-white text-xs rounded px-2.5 py-2 outline-none focus:border-blue-500"
                  value={exitFix}
                  onChange={e => setExitFix(e.target.value.toUpperCase())}
                  placeholder="예) LATVO"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[11px] text-gray-400 mb-1 block">순항 고도</label>
                <select
                  className="w-full bg-gray-800 border border-gray-700 text-white text-xs rounded px-2.5 py-2 outline-none focus:border-blue-500"
                  value={cruiseLevel}
                  onChange={e => setCruiseLevel(e.target.value)}
                >
                  {FL_OPTIONS.map(fl => <option key={fl} value={fl}>{fl}</option>)}
                </select>
              </div>
              <div>
                <label className="text-[11px] text-gray-400 mb-1 block">통과 시간대 (UTC)</label>
                <input
                  className="w-full bg-gray-800 border border-gray-700 text-white text-xs rounded px-2.5 py-2 outline-none focus:border-blue-500"
                  value={transitWindow}
                  onChange={e => setTransitWindow(e.target.value)}
                  placeholder="예) 17:30~18:15"
                />
              </div>
            </div>

            <div>
              <label className="text-[11px] text-gray-400 mb-1 block">운항 빈도</label>
              <select
                className="w-full bg-gray-800 border border-gray-700 text-white text-xs rounded px-2.5 py-2 outline-none focus:border-blue-500"
                value={frequency}
                onChange={e => setFrequency(e.target.value)}
              >
                <option>매일 (Daily)</option>
                <option>주 7회 (7x Weekly)</option>
                <option>주 5회 (5x Weekly)</option>
                <option>주 3회 (3x Weekly)</option>
                <option>주 1회 (1x Weekly)</option>
                <option>부정기 (Charter)</option>
              </select>
            </div>

            <div>
              <label className="text-[11px] text-gray-400 mb-1 block">담당자 연락처</label>
              <input
                className="w-full bg-gray-800 border border-gray-700 text-white text-xs rounded px-2.5 py-2 outline-none focus:border-blue-500"
                value={contactInfo}
                onChange={e => setContactInfo(e.target.value)}
                placeholder="이메일 또는 전화번호"
              />
            </div>

            <div>
              <label className="text-[11px] text-gray-400 mb-1 block">비고 (Notes)</label>
              <textarea
                rows={2}
                className="w-full bg-gray-800 border border-gray-700 text-white text-xs rounded px-2.5 py-2 outline-none focus:border-blue-500 resize-none"
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="추가 요청 사항"
              />
            </div>
          </div>
        </div>

        {/* Preview */}
        <div className="px-4 pb-4">
          <div className="flex items-center justify-between mb-2">
            <div className="text-[10px] text-gray-500 uppercase tracking-widest font-semibold">
              신청서 미리보기
            </div>
            <button
              onClick={copyToClipboard}
              className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-blue-400 transition-colors"
            >
              {copied ? <Check size={11} className="text-green-400" /> : <Copy size={11} />}
              {copied ? '복사됨' : '복사'}
            </button>
          </div>
          <pre className="bg-gray-900 border border-gray-800 rounded-lg p-3 text-[10px] text-gray-400 leading-relaxed whitespace-pre-wrap font-mono overflow-x-auto">
            {previewText}
          </pre>
        </div>
      </div>

      {/* Action buttons */}
      <div className="px-4 py-3 border-t border-gray-800 flex gap-2 shrink-0">
        <button
          onClick={() => handleSave('draft')}
          className="flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-semibold bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg transition-colors border border-gray-700"
        >
          <Save size={12} /> 임시저장
        </button>
        <button
          onClick={() => handleSave('submitted')}
          className="flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
        >
          <FileText size={12} /> 신청서 제출
        </button>
      </div>
    </div>
  )
}
