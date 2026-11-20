// Help at the foot of the navigation (LIN-639): one button that opens a small menu: Report a bug (⇧R), Request a
// feature (⇧F), Documentation, and this build's version, quiet, at the bottom. Keyboard shortcuts stay in the workspace
// menu. The menu floats in the top layer (ui/floating.ts), like the workspace menu.
import { useT } from '@linedesk/i18n/react'
import { useRef } from 'react'
import { Item } from '../shell/WorkspaceMenu.tsx'
import { useMenu } from '../shell/useMenu.ts'
import { useAnchoredList } from '../ui/floating.ts'
import { Icon } from '../ui/kit.tsx'
import { appVersion, DOCS_URL, REPORT_KEYS, type ReportKind } from './report.ts'

export function HelpMenu({ navOpen, onReport }: { navOpen: boolean; onReport: (kind: ReportKind) => void }) {
  const t = useT()
  const menu = useMenu(navOpen)
  const list = useRef<HTMLDivElement>(null)
  useAnchoredList(menu.open, menu.trigger, list, { minWidth: 220 })
  return (
    <div className="help-wrap" ref={menu.root}>
      <button
        type="button"
        ref={menu.trigger}
        className="nav-item help-btn"
        aria-haspopup="menu"
        aria-expanded={menu.open}
        title={t('shell.helpMenu.tip')}
        onClick={() => menu.setOpen(!menu.open)}
        onKeyDown={menu.onTriggerKeyDown}
      >
        <Icon name="help" size={15} />
        <span className="lbl">{t('shell.helpMenu.button')}</span>
      </button>
      {menu.open && (
        <div
          ref={list}
          popover="manual"
          className="ws-menu help-menu k-float"
          role="menu"
          aria-label={t('shell.helpMenu.label')}
          onKeyDown={menu.onKeyDown}
        >
          <Item
            label={t('shell.helpMenu.reportBug')}
            icon="bug"
            keys={REPORT_KEYS.bug}
            onClick={menu.choose(() => onReport('bug'))}
          />
          <Item
            label={t('shell.helpMenu.requestFeature')}
            icon="bulb"
            keys={REPORT_KEYS.feature}
            onClick={menu.choose(() => onReport('feature'))}
          />
          <a
            role="menuitem"
            className="nav-item"
            href={DOCS_URL}
            target="_blank"
            rel="noreferrer"
            onClick={() => menu.setOpen(false)}
          >
            <Icon name="book" size={15} />
            <span className="lbl">{t('shell.helpMenu.docs')}</span>
            <Icon name="arrow-up-right" size={13} className="help-ext" />
          </a>
          <hr />
          <div className="help-version" title={appVersion()}>
            {t('shell.helpMenu.version', { version: appVersion() })}
          </div>
        </div>
      )}
    </div>
  )
}
