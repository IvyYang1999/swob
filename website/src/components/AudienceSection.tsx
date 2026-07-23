import { SectionShell } from './SectionShell'
import { useI18n } from '../i18n-context'

export function AudienceSection() {
  const { strings } = useI18n()
  const a = strings.audience

  return (
    <SectionShell id="audience" label={a.label} title={a.title} description={a.desc} align="center">
      <div className="grid-3">
        {a.personas.map((p) => (
          <div key={p.role} style={cardStyle}>
            <span style={{ fontSize: 32, display: 'block', marginBottom: 16 }}>{p.emoji}</span>
            <h3 style={{ fontSize: 18, fontWeight: 650, color: 'var(--color-bright)', marginBottom: 8 }}>{p.role}</h3>
            <p style={{ fontSize: 15, lineHeight: 1.6, color: 'var(--color-secondary)' }}>{p.scenario}</p>
          </div>
        ))}
      </div>
    </SectionShell>
  )
}

const cardStyle: React.CSSProperties = { borderRadius: 'var(--radius-md)', padding: '32px 24px', textAlign: 'left', border: '1px solid var(--color-edge)', background: 'var(--color-base)' }
