import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { buttonVariants } from '@/components/ui'
import { Page } from '@/components/conductor/Page'
import { callAction } from '@/lib/actions'

/** Opening an invite link joins the team (the link carries a one-time code). */
export default function JoinPage() {
  const { code = '' } = useParams()
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    callAction<{ teamId: string }>('joinTeam', { code })
      .then((res) => navigate(`/t/${res.teamId}`, { replace: true }))
      .catch((e: Error) => setError(e.message))
  }, [code, navigate])

  return (
    <Page>
      <div className="mx-auto mt-16 max-w-sm rounded-xl border border-border bg-card p-6 text-center" data-testid="join-page">
        {error ? (
          <>
            <p className="font-medium">Couldn't join</p>
            <p className="mt-1 text-sm text-muted-foreground">{error}</p>
            <Link to="/teams" className={buttonVariants({ variant: 'secondary', className: 'mt-4' })}>
              Back to teams
            </Link>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Joining the team…</p>
        )}
      </div>
    </Page>
  )
}
