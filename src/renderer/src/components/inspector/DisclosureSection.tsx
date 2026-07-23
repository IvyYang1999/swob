import { useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

interface DisclosureSectionProps {
  title: string
  defaultOpen?: boolean
  children: ReactNode
  badge?: ReactNode
  icon?: ReactNode
}

export function DisclosureSection({
  title,
  defaultOpen = false,
  children,
  badge,
  icon
}: DisclosureSectionProps) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <section>
      <button
        onClick={() => setOpen(!open)}
        className="flex min-w-0 items-center gap-2 overflow-hidden text-xs font-medium text-secondary mb-2 hover:text-body w-full"
      >
        <span className="shrink-0">
          {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        </span>
        {icon && <span className="shrink-0">{icon}</span>}
        <span className="min-w-0 flex-1 truncate text-left" title={title}>{title}</span>
        {badge != null && <span className="text-faint ml-auto shrink-0">{badge}</span>}
      </button>
      {open && children}
    </section>
  )
}
