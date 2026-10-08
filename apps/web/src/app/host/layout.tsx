'use client';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { AuthGate } from '@/components/AuthGate';
import { Icon } from '@/components/ui';
import { useI18n } from '@/lib/i18n';

export default function HostLayout({ children }: { children: ReactNode }) {
  const { t } = useI18n(); const path = usePathname();
  const menu = [
    <a key="events" href="/host" className={path === '/host' || path.startsWith('/host/events') || path === '/host/new' ? 'on' : ''}><Icon name="events" size={20} />{t('host.events.title')}</a>,
    <a key="account" href="/host/account" className={path === '/host/account' ? 'on' : ''}><Icon name="account" size={20} />Account</a>,
  ];
  return <AuthGate title={t('host.title')} menu={menu} nav={<a className="btn sm icon ghost" href="/host/account" aria-label="Account" title="Account"><Icon name="settings" /></a>}>{children}</AuthGate>;
}
