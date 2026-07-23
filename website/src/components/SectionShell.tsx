interface SectionShellProps {
  id: string
  label?: string
  title: string
  description?: string
  children?: React.ReactNode
  align?: 'left' | 'center'
  background?: string
}

export function SectionShell({
  id,
  label,
  title,
  description,
  children,
  align = 'left',
  background,
}: SectionShellProps) {
  return (
    <section
      id={id}
      className="section"
      style={{ background: background || 'transparent' }}
    >
      <div
        className="container"
        style={align === 'center' ? { textAlign: 'center' } : undefined}
      >
        {label && <div className="section-label">{label}</div>}
        <h2 className="section-title">{title}</h2>
        {description && (
          <p
            className="section-desc"
            style={align === 'center' ? { margin: '0 auto 40px' } : { marginBottom: 40 }}
          >
            {description}
          </p>
        )}
        {children}
      </div>
    </section>
  )
}
