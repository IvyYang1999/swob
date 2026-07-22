import { useState, useRef, useEffect } from 'react'
import { HelpCircle, BookOpen, Keyboard, Bug, MessageCircle } from 'lucide-react'
import { useT } from '../i18n'

const DISCORD_INVITE_URL = 'https://discord.gg/placeholder'
const DOCS_URL = 'https://github.com/IvyYang1999/swob'
const WISH_URL = 'https://github.com/IvyYang1999/swob/issues/new?labels=wish&title='

function openExternal(url: string): void {
  void window.api.openExternalUrl(url).catch(() => {
    window.open(url, '_blank')
  })
}

function buildBugReportUrl(): string {
  // Version info not immediately available here; use a simpler URL
  return 'https://github.com/IvyYang1999/swob/issues/new?template=bug_report.md&labels=bug&title='
}

interface HelpMenuItemProps {
  icon: typeof BookOpen
  label: string
  onClick: () => void
}

function HelpMenuItem({ icon: Icon, label, onClick }: HelpMenuItemProps) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-secondary hover:bg-hover hover:text-primary rounded transition-colors text-left"
    >
      <Icon size={13} className="shrink-0 text-muted" />
      <span>{label}</span>
    </button>
  )
}

export function HelpMenu() {
  const t = useT()
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (
        menuRef.current && !menuRef.current.contains(e.target as Node) &&
        buttonRef.current && !buttonRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    const escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    document.addEventListener('keydown', escHandler)
    return () => {
      document.removeEventListener('mousedown', handler)
      document.removeEventListener('keydown', escHandler)
    }
  }, [open])

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={() => setOpen((prev) => !prev)}
        className={`p-1.5 rounded hover:bg-hover ${open ? 'text-primary' : 'text-secondary hover:text-primary'}`}
        title={t('toolbar.help')}
      >
        <HelpCircle size={14} />
      </button>
      {open && (
        <div
          ref={menuRef}
          className="absolute right-0 top-full mt-1 w-48 bg-base border border-edge rounded-lg shadow-xl py-1 z-50"
        >
          <HelpMenuItem
            icon={BookOpen}
            label={t('toolbar.help_docs')}
            onClick={() => { openExternal(DOCS_URL); setOpen(false) }}
          />
          <HelpMenuItem
            icon={Keyboard}
            label={t('toolbar.help_shortcuts')}
            onClick={() => {
              // Open the keyboard shortcuts page on GitHub docs
              openExternal(DOCS_URL)
              setOpen(false)
            }}
          />
          <HelpMenuItem
            icon={Bug}
            label={t('toolbar.help_report_bug')}
            onClick={() => { openExternal(buildBugReportUrl()); setOpen(false) }}
          />
          {DISCORD_INVITE_URL !== 'https://discord.gg/placeholder' && (
            <HelpMenuItem
              icon={MessageCircle}
              label={t('toolbar.help_discord')}
              onClick={() => { openExternal(DISCORD_INVITE_URL); setOpen(false) }}
            />
          )}
        </div>
      )}
    </div>
  )
}
