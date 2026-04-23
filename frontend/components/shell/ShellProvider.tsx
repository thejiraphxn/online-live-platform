'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Shell } from './Shell';
import { api, type Me } from '@/lib/api';
import { ToastProvider } from '@/components/ui/Toast';

export function ShellProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    api<Me>('/auth/me')
      .then(setMe)
      .catch(() => router.push('/login'))
      .finally(() => setReady(true));
  }, [router]);

  if (!ready) {
    return (
      <div className="h-screen flex items-center justify-center text-ink-soft text-sm">
        Loading…
      </div>
    );
  }
  if (!me) return null;
  return (
    <ToastProvider>
      <Shell me={me}>{children}</Shell>
    </ToastProvider>
  );
}
