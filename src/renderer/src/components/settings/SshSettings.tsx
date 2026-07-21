import { useEffect, useState } from 'react'
import { Server } from 'lucide-react'
import { useStore } from '../../store'
import { useT } from '../../i18n'
import { copy, SettingField, SshTutorial } from './shared'
import { RemoteConnectionSection } from './sections'

export function SshSettings() {
  const { locale, sshConfig, setSshConfig } = useStore()
  const t = useT()
  const [sshHost, setSshHost] = useState(sshConfig?.host || '')
  const [sshUser, setSshUser] = useState(sshConfig?.user || '')
  const [sshRemotePath, setSshRemotePath] = useState(sshConfig?.remotePath || '')

  useEffect(() => {
    setSshHost(sshConfig?.host || '')
    setSshUser(sshConfig?.user || '')
    setSshRemotePath(sshConfig?.remotePath || '')
  }, [sshConfig])

  const saveSsh = async () => {
    if (!sshHost.trim() || !sshUser.trim()) return
    await setSshConfig({ host: sshHost.trim(), user: sshUser.trim(), remotePath: sshRemotePath.trim() || undefined })
  }

  return (
    <>
      <SettingField
        label={copy(locale, 'SSH 主机', 'SSH host', 'SSH ホスト')}
        hint={copy(locale, '用于恢复来自另一台机器的会话。', 'Used to resume sessions from another machine.', '別のマシンのセッションを再開するために使用します。')}
        icon={<Server size={12} />}
      >
        <div className="space-y-2 max-w-96">
          <input value={sshHost} onChange={(event) => setSshHost(event.target.value)} placeholder={t('settings.ssh_host')} className="w-full px-2 py-1.5 text-xs bg-surface border border-edge rounded-md text-primary placeholder:text-faint focus:outline-none focus:border-edge-focus" />
          <input value={sshUser} onChange={(event) => setSshUser(event.target.value)} placeholder={t('settings.ssh_user')} className="w-full px-2 py-1.5 text-xs bg-surface border border-edge rounded-md text-primary placeholder:text-faint focus:outline-none focus:border-edge-focus" />
          <input value={sshRemotePath} onChange={(event) => setSshRemotePath(event.target.value)} placeholder={t('settings.ssh_remote_path')} className="w-full px-2 py-1.5 text-xs bg-surface border border-edge rounded-md text-primary placeholder:text-faint focus:outline-none focus:border-edge-focus" />
          <div className="flex gap-2">
            <button onClick={() => void saveSsh()} disabled={!sshHost.trim() || !sshUser.trim()} className="px-3 py-1.5 rounded-md text-xs font-medium bg-accent/15 text-accent hover:bg-accent/25 disabled:opacity-40">{t('settings.ssh_save')}</button>
            {sshConfig && <button onClick={() => setSshConfig(null)} className="px-3 py-1.5 rounded-md text-xs text-muted hover:bg-hover hover:text-soft-red">{t('settings.ssh_clear')}</button>}
          </div>
        </div>
      </SettingField>
      <RemoteConnectionSection />
      <SshTutorial locale={locale} />
    </>
  )
}
