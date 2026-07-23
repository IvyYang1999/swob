import { I18nProvider } from './i18n-context'
import { Navbar } from './components/Navbar'
import { Hero } from './components/Hero'
import { ProblemSection } from './components/ProblemSection'
import { CapabilitySection } from './components/CapabilitySection'
import { TrustSection } from './components/TrustSection'
import { AudienceSection } from './components/AudienceSection'
import { FaqSection } from './components/FaqSection'
import { Footer } from './components/Footer'

export default function App() {
  return (
    <I18nProvider>
      <Navbar />
      <main>
        <Hero />
        <ProblemSection />
        <CapabilitySection />
        <TrustSection />
        <AudienceSection />
        <FaqSection />
      </main>
      <Footer />
    </I18nProvider>
  )
}
