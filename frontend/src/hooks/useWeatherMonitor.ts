import { useEffect, useRef } from 'react'
import { api } from '../api/client'
import { useApp } from '../AppContext'
import { explainLevel, getThresholds } from '../lib/weatherClassify'
import type { WeatherAlert, WeatherLevel } from '../types'

const POLL_INTERVAL_MS = 5 * 60 * 1000  // 5분 (SPECI 대응)

const LEVEL_LABEL: Record<WeatherLevel, string> = {
  1: '양호',
  2: '주의',
  3: '심각',
}

// MVFR/IFR 같은 일반 카테고리가 아니라, 실제로 이 레벨을 유발한 METAR 원문
// 조각을 그대로 근거로 보여줌 (예: "BKN008", "G35KT", "TSRA")
function makeAlertMessage(icao: string, level: WeatherLevel, reason: string): string {
  return reason ? `[${LEVEL_LABEL[level]}] ${icao} — ${reason}` : `[${LEVEL_LABEL[level]}] ${icao}`
}

export function useWeatherMonitor(icaos: string[]) {
  const { state, dispatch } = useApp()
  const lastAlertedLevel = useRef<Record<string, WeatherLevel>>({})

  async function fetchWeather() {
    if (icaos.length === 0) return
    dispatch({ type: 'SET_WEATHER_LOADING', payload: true })
    try {
      const res = await api.weather.bulk(icaos)
      if (res.data && res.data.length > 0) {
        dispatch({ type: 'SET_WEATHER_DATA', payload: res.data })

        const newAlerts: WeatherAlert[] = []
        for (const d of res.data) {
          // Classify using user-defined thresholds for this airport — combines
          // both classification paths (structured fields + raw-token parse)
          // the same way MapView/AirportPanel do, so the toast never disagrees
          // with what's shown on the map/panel for the same METAR.
          const thresholds = getThresholds(state.weatherConfig, d.icao)
          const { level, reason } = explainLevel(d, thresholds)
          const prev = lastAlertedLevel.current[d.icao]

          if (level < 2) {
            // 이전에 주의/심각이었다가 양호로 회복된 경우 recovery 알림
            if (prev !== undefined && prev >= 2) {
              newAlerts.push({
                id: `${d.icao}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                icao: d.icao,
                level: 1,
                message: `[회복] ${d.icao} — 기상 양호`,
                time: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }),
              })
            }
            delete lastAlertedLevel.current[d.icao]
            continue
          }
          if (prev === level) continue
          lastAlertedLevel.current[d.icao] = level
          newAlerts.push({
            id: `${d.icao}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            icao: d.icao,
            level,
            message: makeAlertMessage(d.icao, level, reason),
            time: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }),
          })
        }
        if (newAlerts.length > 0) {
          dispatch({ type: 'ADD_WEATHER_ALERTS', payload: newAlerts })
        }
      }
    } catch (e) {
      console.warn('Weather fetch failed:', e)
    } finally {
      dispatch({ type: 'SET_WEATHER_LOADING', payload: false })
    }
  }

  useEffect(() => {
    if (icaos.length === 0) return
    fetchWeather()
    const timer = setInterval(fetchWeather, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [icaos.join(',')])

  return { weatherData: state.weatherData, weatherLoading: state.weatherLoading }
}
