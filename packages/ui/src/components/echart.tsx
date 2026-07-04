import * as echarts from 'echarts'
import { useEffect, useRef } from 'react'

// Minimal ECharts wrapper: init once, setOption on change, resize + dispose. Canvas can't ride the CSS
// cascade, so callers feed it concrete token colors from useEchartsTheme().
export const EChart = ({ option, height = 200 }: { option: echarts.EChartsOption; height?: number }) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)

  useEffect(() => {
    if (!containerRef.current) {
      return
    }

    const chart = echarts.init(containerRef.current, null, { renderer: 'canvas' })

    chartRef.current = chart
    const observer = new ResizeObserver(() => chart.resize())

    observer.observe(containerRef.current)

    return () => {
      observer.disconnect()
      chart.dispose()
      chartRef.current = null
    }
  }, [])

  useEffect(() => {
    chartRef.current?.setOption(option, true)
  }, [option])

  return <div ref={containerRef} style={{ width: '100%', height }} />
}
