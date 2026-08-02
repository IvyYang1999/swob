import { describe, expect, it } from 'vitest'
import {
  createDefaultDashboardLayout,
  migrateDashboardLayout,
  type DashboardLayoutConfig
} from './builtin-widgets'

/**
 * R4 contract lock: Layout migration adds token-mix to old layouts.
 *
 * Users with schema-1 layouts from before token-mix was introduced must
 * get the widget auto-inserted by migrateDashboardLayout.
 */
describe('migrateDashboardLayout', () => {
  it('adds token-mix to old layout missing it', () => {
    // Build an old layout that has everything except token-mix
    const oldLayout: DashboardLayoutConfig = {
      schemaVersion: 1,
      pages: {
        overview: {
          sections: [
            { id: 'stats', columns: 1, widgetIds: ['overview.stats'] },
            { id: 'accounting-note', columns: 1, widgetIds: ['overview.accounting-note'] },
            { id: 'token-heatmap', columns: 1, widgetIds: ['overview.token-heatmap'] },
            { id: 'breakdowns', columns: 3, widgetIds: ['overview.by-source', 'overview.by-model', 'overview.top-projects'] },
            { id: 'daily-trend', columns: 1, widgetIds: ['overview.daily-trend'] },
            { id: 'daily-timeline', columns: 1, widgetIds: ['overview.daily-timeline'] }
          ]
        },
        cost: { sections: [{ id: 'cost-cards', columns: 2, widgetIds: ['cost.summary', 'cost.pricing-trace'] }] },
        sessions: {
          sections: [
            { id: 'session-ranking', columns: 1, widgetIds: ['sessions.ranking'] },
            { id: 'session-distributions', columns: 2, widgetIds: ['sessions.turn-distribution', 'sessions.hourly'] }
          ]
        },
        workflow: {
          sections: [
            { id: 'tool-usage', columns: 1, widgetIds: ['workflow.tool-usage'] },
            { id: 'code-changes', columns: 2, widgetIds: ['workflow.code-changes'] }
          ]
        },
        quality: { sections: [{ id: 'quality-summary', columns: 1, widgetIds: ['quality.summary'] }] },
        audit: {
          sections: [
            { id: 'report-generator', columns: 1, widgetIds: ['audit.report-generator'] },
            { id: 'audit-report', columns: 1, widgetIds: ['audit.report'] }
          ]
        }
      }
    }

    // Verify token-mix is absent before migration
    const allWidgetsBefore = oldLayout.pages.overview.sections.flatMap((s) => s.widgetIds)
    expect(allWidgetsBefore).not.toContain('overview.token-mix')

    const migrated = migrateDashboardLayout(oldLayout)

    // Verify token-mix is now present
    const allWidgetsAfter = migrated.pages.overview.sections.flatMap((s) => s.widgetIds)
    expect(allWidgetsAfter).toContain('overview.token-mix')

    // Verify it's inserted after breakdowns section
    const sectionIds = migrated.pages.overview.sections.map((s) => s.id)
    const breakdownsIdx = sectionIds.indexOf('breakdowns')
    const tokenMixIdx = sectionIds.indexOf('token-mix')
    expect(tokenMixIdx).toBe(breakdownsIdx + 1)
  })

  it('does not duplicate token-mix if already present', () => {
    const current = createDefaultDashboardLayout()
    const allWidgets = current.pages.overview.sections.flatMap((s) => s.widgetIds)
    expect(allWidgets.filter((w) => w === 'overview.token-mix')).toHaveLength(1)

    const migrated = migrateDashboardLayout(current)
    const allWidgetsAfter = migrated.pages.overview.sections.flatMap((s) => s.widgetIds)
    expect(allWidgetsAfter.filter((w) => w === 'overview.token-mix')).toHaveLength(1)
  })

  it('original layout is not mutated (immutable migration)', () => {
    const oldLayout: DashboardLayoutConfig = {
      schemaVersion: 1,
      pages: {
        overview: {
          sections: [
            { id: 'stats', columns: 1, widgetIds: ['overview.stats'] },
            { id: 'breakdowns', columns: 3, widgetIds: ['overview.by-source', 'overview.by-model', 'overview.top-projects'] },
          ]
        },
        cost: { sections: [] },
        sessions: { sections: [] },
        workflow: { sections: [] },
        quality: { sections: [] },
        audit: { sections: [] }
      }
    }
    const sectionCountBefore = oldLayout.pages.overview.sections.length

    migrateDashboardLayout(oldLayout)

    // Original must not have been mutated
    expect(oldLayout.pages.overview.sections).toHaveLength(sectionCountBefore)
  })
})
