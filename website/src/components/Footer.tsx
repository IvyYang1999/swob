import { useI18n } from '../i18n-context'
import { RELEASE_PAGE_URL, RELEASE_VERSION, useMacDownload } from '../download'

const GITHUB_URL = 'https://github.com/IvyYang1999/swob'
const FEEDBACK_URL = 'https://github.com/IvyYang1999/swob/issues'

export function Footer() {
  const { locale, strings } = useI18n()
  const download = useMacDownload()
  const f = strings.footer
  const architecture = download.architecture === 'arm64'
    ? (locale === 'zh' ? 'Apple 芯片' : 'Apple Silicon')
    : (locale === 'zh' ? 'Intel Mac' : 'Intel Mac')
  const alternate = download.alternateArchitecture === 'arm64'
    ? (locale === 'zh' ? 'Apple 芯片版' : 'Apple Silicon build')
    : (locale === 'zh' ? 'Intel 版' : 'Intel build')

  return (
    <footer id="download" style={{ background: 'var(--color-surface)', borderTop: '1px solid var(--color-edge)' }}>
      <div className="container" style={{ paddingTop: 80, paddingBottom: 40 }}>
        <div style={{ textAlign: 'center', marginBottom: 64 }}>
          <h2 style={{ fontSize: 36, fontWeight: 700, lineHeight: 1.15, color: 'var(--color-bright)', letterSpacing: '-0.02em', marginBottom: 16 }}>
            {f.ctaTitle}
          </h2>
          <p style={{ fontSize: 17, color: 'var(--color-secondary)', marginBottom: 28 }}>
            {f.ctaDesc}
          </p>
          <a
            href={download.url}
            style={{ display: 'inline-block', fontSize: 16, fontWeight: 600, color: '#fff', background: 'var(--color-accent)', padding: '14px 32px', borderRadius: 'var(--radius-sm)', textDecoration: 'none' }}
          >
            {locale === 'zh'
              ? `下载 v${RELEASE_VERSION} · ${architecture}`
              : `Download v${RELEASE_VERSION} · ${architecture}`}
          </a>
          <div style={{ marginTop: 14, fontSize: 13, color: 'var(--color-muted)' }}>
            <a href={download.alternateUrl} style={linkStyle}>{alternate}</a>
            <span aria-hidden="true"> · </span>
            <a href={RELEASE_PAGE_URL} style={linkStyle}>
              {locale === 'zh' ? '全部安装包与校验信息' : 'All installers and verification'}
            </a>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: 24, borderTop: '1px solid var(--color-edge)', flexWrap: 'wrap', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <img src="/favicon.svg" alt="Swob" width={20} height={20} />
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-muted)' }}>Swob</span>
          </div>
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
            <a href="/docs/" style={linkStyle}>{locale === 'zh' ? '文档' : 'Docs'}</a>
            <a href={GITHUB_URL} target="_blank" rel="noopener" style={linkStyle}>GitHub</a>
            <a href={FEEDBACK_URL} target="_blank" rel="noopener" style={linkStyle}>{locale === 'zh' ? '反馈建议' : 'Feedback'}</a>
            <a href={`${GITHUB_URL}/blob/master/LICENSE`} target="_blank" rel="noopener" style={linkStyle}>Apache-2.0</a>
          </div>
        </div>
      </div>
    </footer>
  )
}

const linkStyle: React.CSSProperties = { fontSize: 13, color: 'var(--color-muted)', textDecoration: 'none' }
