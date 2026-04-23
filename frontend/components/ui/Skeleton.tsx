export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div
      className={[
        'bg-paper-alt border border-ink/10 rounded animate-pulse',
        className,
      ].join(' ')}
    />
  );
}

export function SkeletonRow({ cols = 4 }: { cols?: number }) {
  return (
    <div
      className="grid gap-3 py-2"
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
    >
      {Array.from({ length: cols }).map((_, i) => (
        <Skeleton key={i} className="h-5" />
      ))}
    </div>
  );
}
