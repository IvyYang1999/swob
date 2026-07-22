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
        className="flex items-center gap-2 text-xs font-medium text-secondary mb-2 hover:text-body w-full"
      >
        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        {icon}
        <span>{title}</span>
        {badge != null && <span className="text-faint ml-auto">{badge}</span>}
      </button>
      {open && children}
    </section>
  )
}
