import { Starfield } from './Starfield'
import { useI18n } from '../i18n-context'
import { CollectDemo } from '../demos/CollectDemo'
import { RELEASE_VERSION, useMacDownload } from '../download'

export function Hero() {
  const { locale, strings } = useI18n()
  const download = useMacDownload()
  const h = strings.hero
  const architecture = download.architecture === 'arm64'
    ? (locale === 'zh' ? 'Apple 芯片' : 'Apple Silicon')
    : (locale === 'zh' ? 'Intel Mac' : 'Intel Mac')
  const alternate = download.alternateArchitecture === 'arm64'
    ? (locale === 'zh' ? 'Apple 芯片版' : 'Apple Silicon build')
    : (locale === 'zh' ? 'Intel 版' : 'Intel build')

  return (
    <section id="hero" style={styles.hero}>
      <div style={styles.starfieldWrap}><Starfield /></div>
      <div className="container" style={styles.content}>
        <h1 style={styles.headline}>
          <span style={styles.brand}>{h.brand}</span><br />
          {h.headline}
        </h1>
        <p style={styles.sub}>{h.sub}</p>
        <div style={styles.actions}>
          <a href={download.url} style={styles.primaryBtn}>
            {locale === 'zh'
              ? `下载 v${RELEASE_VERSION} · ${architecture}`
              : `Download v${RELEASE_VERSION} · ${architecture}`}
          </a>
          <a href="#capabilities" style={styles.secondaryBtn}>{h.secondary}</a>
        </div>
        <p style={styles.architectureHint}>
          {locale === 'zh' ? '架构不对？' : 'Wrong architecture?'}{' '}
          <a href={download.alternateUrl} style={styles.alternateLink}>{alternate}</a>
        </p>
        <div style={styles.productDemo}>
          <CollectDemo />
        </div>
      </div>
    </section>
  )
}

const styles: Record<string, React.CSSProperties> = {
  hero: { position: 'relative', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', paddingTop: 80, paddingBottom: 40, overflow: 'hidden', background: 'linear-gradient(180deg, #faf9fc 0%, #ffffff 60%)' },
  starfieldWrap: { position: 'absolute', inset: 0, opacity: 0.35 },
  content: { position: 'relative', zIndex: 1, width: '100%', minWidth: 0, textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center' },
  headline: { width: '100%', fontSize: 'clamp(38px, 8vw, 56px)', fontWeight: 800, lineHeight: 1.1, color: 'var(--color-bright)', letterSpacing: '-0.03em', marginBottom: 20 },
  brand: { color: 'var(--color-accent)' },
  sub: { fontSize: 18, lineHeight: 1.7, color: 'var(--color-secondary)', maxWidth: 580, marginBottom: 32 },
  actions: { display: 'flex', gap: 12, flexWrap: 'wrap', justifyContent: 'center', marginBottom: 12 },
  primaryBtn: { fontSize: 15, fontWeight: 600, color: '#fff', background: 'var(--color-accent)', padding: '12px 28px', borderRadius: 'var(--radius-sm)', textDecoration: 'none', transition: 'background 0.15s, transform 0.1s' },
  secondaryBtn: { fontSize: 15, fontWeight: 600, color: 'var(--color-accent)', background: 'var(--color-accent-light)', padding: '12px 28px', borderRadius: 'var(--radius-sm)', textDecoration: 'none', transition: 'background 0.15s' },
  architectureHint: { fontSize: 13, color: 'var(--color-muted)', marginBottom: 36 },
  alternateLink: { color: 'var(--color-accent)', textUnderlineOffset: 3 },
  productDemo: { width: '100%', maxWidth: 900, textAlign: 'left' },
}
