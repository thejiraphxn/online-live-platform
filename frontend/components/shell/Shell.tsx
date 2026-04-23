'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Avatar } from '@/components/ui/Avatar';
import { RoleBadge } from '@/components/ui/RoleBadge';
import type { Me } from '@/lib/api';
import { api } from '@/lib/api';
import { CourseRole } from '@/lib/enums';

function NavItem({
  href,
  icon,
  label,
  active,
}: {
  href: string;
  icon: string;
  label: string;
  active?: boolean;
}) {
  return (
    <Link
      href={href}
      className={[
        'flex items-center gap-2.5 px-2.5 py-1.5 rounded text-sm font-medium border',
        active
          ? 'bg-accent-soft text-accent border-accent'
          : 'bg-transparent text-ink border-transparent hover:bg-paper-alt',
      ].join(' ')}
    >
      <span className="w-6 text-center font-mono text-lg leading-none">{icon}</span>
      <span>{label}</span>
    </Link>
  );
}

export function Shell({
  me,
  children,
  activeTeacher,
  activeStudent,
}: {
  me: Me;
  children: React.ReactNode;
  activeTeacher?: string;
  activeStudent?: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const teacherMemberships = me.memberships.filter((m) => m.role === CourseRole.TEACHER);
  const isTeacher = teacherMemberships.length > 0;
  const activeKey =
    (isTeacher ? activeTeacher : activeStudent) ??
    (pathname?.startsWith('/courses') ? 'courses' : 'home');

  async function logout() {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    router.push('/login');
  }

  const teacherNav = [
    { k: 'home', icon: '⌂', label: 'Dashboard', href: '/dashboard' },
    { k: 'courses', icon: '▤', label: 'My Courses', href: '/courses' },
  ];
  const studentNav = [
    { k: 'home', icon: '⌂', label: 'Dashboard', href: '/dashboard' },
    { k: 'courses', icon: '▤', label: 'My Courses', href: '/courses' },
  ];
  const nav = isTeacher ? teacherNav : studentNav;

  return (
    <div className="h-screen bg-paper text-ink flex">
      <aside className="w-[200px] bg-paper-alt border-r border-ink flex flex-col p-3 gap-1 flex-shrink-0">
        <div className="font-bold text-base px-2 py-1 flex items-center gap-2">
          <span className="text-2xl leading-none">◐</span>
          <span>OLP</span>
        </div>
        <div className="h-px bg-ink/20 my-2" />
        {nav.map((it) => (
          <NavItem
            key={it.k}
            href={it.href}
            icon={it.icon}
            label={it.label}
            active={activeKey === it.k}
          />
        ))}
      </aside>
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-12 border-b border-ink bg-paper flex items-center gap-3 px-5 flex-shrink-0">
          <div className="flex-1" />
          <Avatar name={me.name} size={26} />
          <div className="flex flex-col leading-tight">
            <span className="text-xs font-bold">{me.name}</span>
            <RoleBadge role={isTeacher ? CourseRole.TEACHER : CourseRole.STUDENT} />
          </div>
          <button
            onClick={logout}
            className="ml-2 text-xs text-ink-soft hover:text-ink underline"
          >
            sign out
          </button>
        </header>
        <main className="flex-1 overflow-auto bg-paper">{children}</main>
      </div>
    </div>
  );
}
