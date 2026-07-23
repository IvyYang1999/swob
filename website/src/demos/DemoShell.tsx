interface DemoShellProps {
  children: React.ReactNode
  aspectRatio?: string
}

export function DemoShell({ children, aspectRatio = '4/3' }: DemoShellProps) {
  return (
    <div style={{ position: 'relative', width: '100%', minWidth: 0 }}>
      <div style={{
        borderRadius: 'var(--radius-lg)',
        border: '1px solid var(--color-edge)',
        background: 'var(--color-base)',
        boxShadow: 'var(--shadow-md)',
        overflow: 'hidden',
        aspectRatio,
      }}>
        {children}
      </div>
      <div style={{
        position: 'absolute',
        top: 8,
        right: 12,
        fontSize: 10,
        color: 'var(--color-faint)',
        background: 'rgba(255,255,255,0.8)',
        padding: '2px 8px',
        borderRadius: 12,
        backdropFilter: 'blur(4px)',
      }}>
        可交互演示
      </div>
    </div>
  )
}
