import { lazy, Suspense } from 'react'
import { useI18n } from '../i18n-context'

const CollectDemo = lazy(() => import('../demos/CollectDemo').then(m => ({ default: m.CollectDemo })))
const RecoverDemo = lazy(() => import('../demos/RecoverDemo').then(m => ({ default: m.RecoverDemo })))
const InsightDemo = lazy(() => import('../demos/InsightDemo').then(m => ({ default: m.InsightDemo })))
const CompanionDemo = lazy(() => import('../demos/CompanionDemo').then(m => ({ default: m.CompanionDemo })))

const DEMOS = [CollectDemo, RecoverDemo, InsightDemo, CompanionDemo]
const CAP_IDS = ['collect', 'recover', 'insight', 'companion']

const DemoFallback = () => (
  <div style={{ aspectRatio: '4/3', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-surface)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--color-edge)' }}>
    <span style={{ fontSize: 13, color: 'var(--color-muted)' }}>Loading…</span>
  </div>
)

export function CapabilitySection() {
  const { strings } = useI18n()
  const c = strings.capabilities

  return (
    <section id="capabilities" className="section">
      <div className="container">
        <div className="section-label">{c.label}</div>
        <h2 className="section-title" style={{ marginBottom: 64 }}>{c.title}</h2>

        {c.items.map((item, i) => {
          const Demo = DEMOS[i]
          return (
            <div key={CAP_IDS[i]} id={CAP_IDS[i]} className={`cap-row${i % 2 !== 0 ? ' reverse' : ''}`}>
              <div className="cap-text">
                <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase' as const, color: 'var(--color-accent)', marginBottom: 8 }}>
                  {item.label}
                </div>
                <h3 style={{ fontSize: 28, fontWeight: 700, lineHeight: 1.2, color: 'var(--color-bright)', letterSpacing: '-0.01em', marginBottom: 12 }}>
                  {item.title}
                </h3>
                <p style={{ fontSize: 16, lineHeight: 1.65, color: 'var(--color-secondary)' }}>
                  {item.desc}
                </p>
              </div>
              <div className="cap-demo-wrap">
                <Suspense fallback={<DemoFallback />}>
                  <Demo />
                </Suspense>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
