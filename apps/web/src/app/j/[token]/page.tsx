import type { Metadata } from 'next';
import { GuestApp } from '@/components/guest/GuestApp';

const API = process.env.API_INTERNAL_URL || 'http://localhost:4000';

/**
 * Social preview metadata (spec 6.2 "Sharing"): when a link is pasted into WhatsApp/Telegram the card shows the event name
 * and a generic line. No photo, no host personal data, and the page stays `noindex` (private events are never indexed, D14).
 */
export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const { token } = await params;
  try {
    const res = await fetch(`${API}/v1/events/${encodeURIComponent(token)}/context?preview=1`, { cache: 'no-store', signal: AbortSignal.timeout(2500) });
    if (res.ok) {
      const c = await res.json();
      const title = c.event?.name ?? 'EventSnap';
      return {
        title, robots: { index: false, follow: false },
        openGraph: { title, description: 'Share your photos in one private event gallery · ፎቶዎችዎን በአንድ የግል ጋለሪ ያጋሩ', type: 'website', siteName: 'EventSnap' },
        twitter: { card: 'summary', title },
      };
    }
  } catch { /* API unreachable: fall back to defaults */ }
  return { title: 'EventSnap', robots: { index: false, follow: false } };
}

// QR / private link target. No account and no app install required (D01).
export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <GuestApp locator={token} />;
}
