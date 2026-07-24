import { useEffect, useRef } from 'react'
import { api } from '../api/client'
import { useApp } from '../AppContext'
import { classifyLevel, getThresholds } from '../lib/weatherClassify'
import type { WeatherAlert, WeatherLevel } from '../types'

const POLL_INTERVAL_MS = 5 * 60 * 1000  // 5분 (SPECI 대응)

const LEVEL_LABEL: Record<WeatherLevel, string> = {
  1: '양호',
  2: '주의',
  3: '심각',
}

function makeAlertMessage(icao: string, level: WeatherLevel, cat: string, gust: number | null, wx: string[]): string {
  const displayCat = cat === 'VFR' ? '' : ` — ${cat}`
  const parts: string[] = [`[${LEVEL_LABEL[level]}] ${icao}${displayCat}`]
  if (wx.length > 0) parts.push(wx.join(' '))
  if (gust) parts.push(`돌풍 ${gust}kt`)
  return parts.join(' / ')
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
          // Classify using user-defined thresholds for this airport
          const thresholds = getThresholds(state.weatherConfig, d.icao)
          const level = classifyLevel(d, thresholds)
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
            message: makeAlertMessage(d.icao, level, d.flight_category, d.gust_kt, d.weather),
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
