import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
// Self-hosted fonts (no third-party font CDN: data residency + works on weak links).
import '@fontsource/noto-sans/latin-400.css';
import '@fontsource/noto-sans/latin-700.css';
import '@fontsource/noto-sans-ethiopic/ethiopic-400.css';
import '@fontsource/noto-sans-ethiopic/ethiopic-700.css';
import './globals.css';
import { I18nProvider } from '@/lib/i18n';
import { ServiceWorker } from '@/components/ServiceWorker';

export const metadata: Metadata = {
  title: 'EventSnap',
  description: 'Share event photos privately in one live gallery.',
  manifest: '/manifest.webmanifest',
  robots: { index: false, follow: false },       // private events are never indexed
  applicationName: 'EventSnap',
  appleWebApp: { capable: true, title: 'EventSnap', statusBarStyle: 'default' },
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#f0475a' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <I18nProvider>
          {children}
          <ServiceWorker />
        </I18nProvider>
      </body>
    </html>
  );
}
