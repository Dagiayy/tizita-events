'use client';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { AuthGate } from '@/components/AuthGate';
import { Icon, type IconName } from '@/components/ui';
import { useI18n } from '@/lib/i18n';

const NAV = [['', 'dashboard'], ['/events', 'events'], ['/orgs', 'orgs'], ['/payments', 'payments'], ['/storage', 'storage'], ['/moderation', 'moderation'], ['/access', 'access'], ['/compliance', 'compliance'], ['/audit', 'audit'], ['/config', 'config']] as const;

export default function AdminLayout({ children }: { children: ReactNode }) {
  const { t } = useI18n(); const path = usePathname();
  const link = (href: string, key: IconName, icon: boolean) => {
    const full = `/admin${href}`; const on = href === '' ? path === '/admin' : path.startsWith(full);
    return <a key={key} href={full} className={on ? 'on' : ''}>{icon && <Icon name={key as IconName} size={20} />}{t(`admin.nav.${key}`)}</a>;
  };
  return (
    <AuthGate staff title={t('admin.title')} menu={NAV.map(([href, key]) => link(href, key, true))}>
      <div className="wrap side" style={{ paddingTop: 16, paddingBottom: 40 }}>
        <nav aria-label="admin">{NAV.map(([href, key]) => link(href, key, false))}</nav>
        <div className="stack" style={{ minWidth: 0 }}>{children}</div>
      </div>
    </AuthGate>
  );
}
