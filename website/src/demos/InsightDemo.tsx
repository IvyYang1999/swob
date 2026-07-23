import { DemoShell } from './DemoShell'
import { INSIGHT_STATS } from './fixtures'

export function InsightDemo() {
  return (
    <DemoShell>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        {/* Tab 栏 */}
        <div style={tabBarStyle}>
          <span style={tabActiveStyle}>总览</span>
          <span style={tabStyle}>成本与缓存</span>
          <span style={tabStyle}>会话与效率</span>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
          {/* 统计卡片 */}
          <div style={statsGridStyle}>
            <StatCard label="已处理 Tokens" value={INSIGHT_STATS.totalTokens} sub="API 等价值" accent />
            <StatCard label="API 等价成本" value={INSIGHT_STATS.totalCost} sub="按实际模型定价" />
            <StatCard label="会话总数" value={String(INSIGHT_STATS.sessions)} sub={`平均 ${INSIGHT_STATS.avgTurns} 轮/会话`} />
          </div>

          {/* 口径标签 */}
          <div style={calibrationStyle}>
            <span style={calibrationBadge}>口径</span>
            <span>input + output tokens · 含 cache_read · 按发布定价</span>
          </div>

          {/* 排名 */}
          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-bright)', marginBottom: 10 }}>
              项目排名（Token 消耗）
            </div>
            {INSIGHT_STATS.ranking.map((r, i) => (
              <div key={r.name} style={rankItemStyle}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
                  <span style={{ fontSize: 11, color: 'var(--color-muted)', fontWeight: 600, width: 16 }}>
                    {i < 3 ? ['P95', 'P75', 'P50'][i] : `#${i + 1}`}
                  </span>
                  <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-primary)' }}>{r.name}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ fontSize: 11, color: 'var(--color-muted)', fontFamily: 'var(--font-mono)' }}>{r.tokens}</span>
                  <span style={{ fontSize: 11, color: 'var(--color-accent)', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{r.cost}</span>
                  <div style={{ width: 60, height: 4, background: 'var(--color-edge)', borderRadius: 2, overflow: 'hidden' }}>
                    <div style={{ width: `${r.pct}%`, height: '100%', background: 'var(--color-accent)', borderRadius: 2 }} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </DemoShell>
  )
}

function StatCard({ label, value, sub, accent }: { label: string; value: string; sub: string; accent?: boolean }) {
  return (
    <div style={statCardStyle}>
      <div style={{ fontSize: 10, fontWeight: 500, color: 'var(--color-muted)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: accent ? 'var(--color-accent)' : 'var(--color-bright)', fontFamily: 'var(--font-mono)', letterSpacing: '-0.02em' }}>
        {value}
      </div>
      <div style={{ fontSize: 10, color: 'var(--color-faint)', marginTop: 2 }}>{sub}</div>
    </div>
  )
}

const tabBarStyle: React.CSSProperties = {
  display: 'flex', gap: 2, padding: '8px 12px', borderBottom: '1px solid var(--color-edge)', overflowX: 'auto',
}
const tabStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 500, padding: '5px 10px', color: 'var(--color-muted)', borderRadius: 'var(--radius-sm)', whiteSpace: 'nowrap',
}
const tabActiveStyle: React.CSSProperties = {
  ...tabStyle, background: 'color-mix(in srgb, var(--color-accent) 10%, transparent)', color: 'var(--color-accent)', borderBottom: '2px solid var(--color-accent)',
}
const statsGridStyle: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8,
}
const statCardStyle: React.CSSProperties = {
  padding: '12px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--color-edge)', background: 'var(--color-surface)',
}
const calibrationStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, marginTop: 10, fontSize: 10, color: 'var(--color-faint)',
}
const calibrationBadge: React.CSSProperties = {
  fontSize: 9, fontWeight: 600, padding: '1px 5px', borderRadius: 3, background: 'var(--color-accent-light)', color: 'var(--color-accent)',
}
const rankItemStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--color-edge-subtle)',
}
