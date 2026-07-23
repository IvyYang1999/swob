import { SectionShell } from './SectionShell'
import { useI18n } from '../i18n-context'

export function ProblemSection() {
  const { strings } = useI18n()
  const p = strings.problem

  return (
    <SectionShell id="problem" title={p.title} align="center">
      <div className="grid-3" style={{ marginTop: 8 }}>
        {p.pains.map((pain) => (
          <div key={pain.title} style={cardStyle}>
            <span style={{ fontSize: 28, display: 'block', marginBottom: 16 }}>{pain.icon}</span>
            <h3 style={{ fontSize: 17, fontWeight: 650, color: 'var(--color-bright)', marginBottom: 8 }}>{pain.title}</h3>
            <p style={{ fontSize: 15, lineHeight: 1.6, color: 'var(--color-secondary)' }}>{pain.desc}</p>
          </div>
        ))}
      </div>
    </SectionShell>
  )
}

const cardStyle: React.CSSProperties = {
  background: 'var(--color-surface)', borderRadius: 'var(--radius-md)',
  padding: '32px 24px', textAlign: 'left', border: '1px solid var(--color-edge)',
}
