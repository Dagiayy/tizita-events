'use client';
import { use } from 'react';
import { EventConsole } from '@/components/host/EventConsole';

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <EventConsole id={id} />;
}
