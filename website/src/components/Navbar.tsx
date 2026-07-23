import { useState } from 'react'
import { useI18n } from '../i18n-context'
import { useMacDownload } from '../download'

const GITHUB_URL = 'https://github.com/IvyYang1999/swob'
const FEEDBACK_URL = 'https://github.com/IvyYang1999/swob/issues'

export function Navbar() {
  const [menuOpen, setMenuOpen] = useState(false)
  const { locale, strings, switchLocale } = useI18n()
  const download = useMacDownload()
  const nav = strings.nav

  const NAV_ITEMS = [
    { label: nav.capabilities, href: '#capabilities' },
    { label: nav.trust, href: '#trust' },
    { label: nav.faq, href: '#faq' },
    { label: nav.docs, href: '/docs/' },
  ]

  return (
    <nav className="navbar">
      <div className="navbar-inner">
        <a href="/" className="navbar-logo">
          <img src="/favicon.svg" alt="Swob" width={28} height={28} />
          <span className="navbar-logo-text">Swob</span>
        </a>

        <div className="navbar-links">
          {NAV_ITEMS.map((item) => (
            <a key={item.href} href={item.href} className="navbar-link">
              {item.label}
            </a>
          ))}
        </div>

        <div className="navbar-icons">
          <a href={GITHUB_URL} target="_blank" rel="noopener" className="navbar-icon" title="GitHub" aria-label="GitHub">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
          </a>
          <a href={FEEDBACK_URL} target="_blank" rel="noopener" className="navbar-icon" title={locale === 'zh' ? '反馈建议' : 'Feedback'} aria-label="Feedback">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
          </a>
        </div>

        <button
          className="navbar-lang"
          onClick={() => switchLocale(locale === 'zh' ? 'en' : 'zh')}
          title={locale === 'zh' ? 'Switch to English' : '切换到中文'}
        >
          {locale === 'zh' ? 'EN' : '中'}
        </button>

        <a href={download.url} className="navbar-cta">
          {nav.download}
        </a>

        <button
          className="navbar-burger"
          onClick={() => setMenuOpen(!menuOpen)}
          aria-label="菜单"
        >
          <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
            {menuOpen ? (
              <path d="M6 6l10 10M16 6L6 16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            ) : (
              <path d="M4 7h14M4 11h14M4 15h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            )}
          </svg>
        </button>
      </div>

      {menuOpen && (
        <div className="navbar-mobile-menu">
          {NAV_ITEMS.map((item) => (
            <a key={item.href} href={item.href} className="navbar-mobile-link" onClick={() => setMenuOpen(false)}>
              {item.label}
            </a>
          ))}
          <a href={GITHUB_URL} target="_blank" rel="noopener" className="navbar-mobile-link" onClick={() => setMenuOpen(false)}>GitHub</a>
          <a href={FEEDBACK_URL} target="_blank" rel="noopener" className="navbar-mobile-link" onClick={() => setMenuOpen(false)}>
            {locale === 'zh' ? '反馈建议' : 'Feedback'}
          </a>
          <button
            className="navbar-mobile-link"
            onClick={() => { switchLocale(locale === 'zh' ? 'en' : 'zh'); setMenuOpen(false) }}
            style={{ background: 'none', border: 'none', textAlign: 'left', cursor: 'pointer' }}
          >
            {locale === 'zh' ? 'English' : '中文'}
          </button>
          <a href={download.url} className="navbar-mobile-cta" onClick={() => setMenuOpen(false)}>
            {nav.download}
          </a>
        </div>
      )}
    </nav>
  )
}
