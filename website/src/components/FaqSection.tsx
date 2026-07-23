import { useState } from 'react'
import { SectionShell } from './SectionShell'
import { useI18n } from '../i18n-context'

function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false)

  return (
    <div style={{ borderBottom: '1px solid var(--color-edge)' }}>
      <button
        style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '20px 0', background: 'none', border: 'none', fontSize: 16, fontWeight: 600, color: 'var(--color-bright)', textAlign: 'left', cursor: 'pointer' }}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span>{q}</span>
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" style={{ transform: open ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.2s', flexShrink: 0 }}>
          <path d="M5 8l5 5 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && <div style={{ fontSize: 15, lineHeight: 1.65, color: 'var(--color-secondary)', paddingBottom: 20 }}>{a}</div>}
    </div>
  )
}

export function FaqSection() {
  const { strings } = useI18n()
  const f = strings.faq

  return (
    <SectionShell id="faq" label={f.label} title={f.title} align="center">
      <div style={{ maxWidth: 680, margin: '0 auto', textAlign: 'left' }}>
        {f.items.map((item) => (
          <FaqItem key={item.q} q={item.q} a={item.a} />
        ))}
      </div>
    </SectionShell>
  )
}
