import { ResponsiveGridLayout, useContainerWidth } from 'react-grid-layout'
import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'
import type { ResponsiveLayouts, Layout } from 'react-grid-layout'
import { useLayoutStore } from '../stores/layoutStore'
import { WIDGET_REGISTRY } from './widgetRegistry'
import WidgetWrapper from './WidgetWrapper'

export default function WidgetGrid() {
  const { layouts, widgets, scales, locked, setLayouts, removeWidget, setScale } = useLayoutStore()
  const { width, containerRef } = useContainerWidth({ initialWidth: 1280 })

  const handleLayoutChange = (_layout: Layout, allLayouts: ResponsiveLayouts) => {
    setLayouts(allLayouts)
  }

  return (
    <div ref={containerRef} style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
      <ResponsiveGridLayout
        width={width}
        layouts={layouts}
        breakpoints={{ lg: 1200, md: 996, sm: 768 }}
        cols={{ lg: 12, md: 10, sm: 6 }}
        rowHeight={60}
        margin={[6, 6]}
        containerPadding={[6, 6]}
        dragConfig={{ enabled: !locked, handle: '.widget-drag-handle', threshold: 3, bounded: false }}
        resizeConfig={{ enabled: !locked, handles: ['se'] }}
        onLayoutChange={handleLayoutChange}
      >
        {widgets.map(({ id, widgetType }) => {
          const meta = WIDGET_REGISTRY[widgetType]
          if (!meta) return null
          const WidgetComponent = meta.component
          return (
            <div key={id}>
              <WidgetWrapper
                title={meta.name}
                locked={locked}
                onRemove={() => removeWidget(id)}
                scale={scales[id] ?? 1}
                onScaleChange={(s) => setScale(id, s)}
              >
                <WidgetComponent />
              </WidgetWrapper>
            </div>
          )
        })}
      </ResponsiveGridLayout>
    </div>
  )
}
