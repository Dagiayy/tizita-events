import { Slideshow } from '@/components/guest/Slideshow';

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <Slideshow locator={token} />;
}
