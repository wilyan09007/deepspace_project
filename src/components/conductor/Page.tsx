import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

export function Page({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return <div className={cn('mx-auto w-full px-4 py-6 sm:px-6 sm:py-8', wide ? 'max-w-[1500px]' : 'max-w-5xl')}>{children}</div>
}

export function Crumbs({ items }: { items: Array<{ label: string; to?: string }> }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-2 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
      {items.map((item, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <ChevronRight className="h-3 w-3" aria-hidden />}
          {item.to ? (
            <Link to={item.to} className="hover:text-foreground">
              {item.label}
            </Link>
          ) : (
            <span className="text-foreground/80">{item.label}</span>
          )}
        </span>
      ))}
    </nav>
  )
}

export function Panel({ title, action, children, className, testId }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; testId?: string }) {
  return (
    <section data-testid={testId} className={cn('rounded-xl border border-border bg-card', className)}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
          <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
          {action}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  )
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <code className={cn('rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground/90', className)}>{children}</code>
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <p className="py-6 text-center text-sm text-muted-foreground">{label}</p>
}

/** A stable color per agent name, used for agent chips. */
const HUES = [172, 38, 262, 200, 330, 120, 18]
export function agentHue(name: string): number {
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return HUES[h % HUES.length]!
}

export function AgentChip({ name, kind }: { name: string; kind?: string }) {
  const hue = agentHue(name)
  return (
    <span
      className="inline-flex max-w-full items-center gap-1 truncate rounded-full border px-2 py-0.5 text-[11px] font-medium"
      style={{ borderColor: `hsl(${hue} 60% 45% / 0.5)`, color: `hsl(${hue} 70% 72%)`, background: `hsl(${hue} 60% 40% / 0.12)` }}
      title={kind === 'demo' ? `${name} (demo agent)` : name}
    >
      {name}
    </span>
  )
}
