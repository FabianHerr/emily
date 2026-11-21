import { useEffect, useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { api } from '../convex/_generated/api'
import type { Id } from '../convex/_generated/dataModel'
import './App.css'

// The demo watch (convex/seed.ts).
const DEVICE_ID = 'watch-1'
// The watch polls at least once a minute; three missed minutes means no signal.
const NO_SIGNAL_AFTER_MS = 3 * 60 * 1000
// How often the "last seen" texts are refreshed.
const CLOCK_TICK_MS = 15 * 1000
const WHO_STORAGE_KEY = 'emily.who'

type Overview = NonNullable<ReturnType<typeof useQuery<typeof api.portal.overview>>>
type Incident = Overview['incidents'][number]

const timeFormat = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' })
const dayFormat = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' })

function formatWhen(ms: number, now: number): string {
  const sameDay = new Date(ms).toDateString() === new Date(now).toDateString()
  return sameDay ? `Today, ${timeFormat.format(ms)}` : `${dayFormat.format(ms)}, ${timeFormat.format(ms)}`
}

function formatAgo(ms: number, now: number): string {
  const minutes = Math.floor((now - ms) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`
}

function readWho(): string | null {
  try {
    return localStorage.getItem(WHO_STORAGE_KEY)
  } catch {
    return null
  }
}

function saveWho(name: string) {
  try {
    localStorage.setItem(WHO_STORAGE_KEY, name)
  } catch {
    // Private window: the choice just lasts for this visit.
  }
}

// Ticks so "2 min ago" and "No signal" stay true without new data.
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS)
    return () => clearInterval(timer)
  }, [])
  return now
}

// Emily's cloud, in her two pastels (green and pink).
function EmilyCloud() {
  return (
    <svg viewBox="0 0 200 160" role="img" aria-label="Emily">
      <defs>
        <linearGradient id="cloud-base" x1="0" y1="0.1" x2="1" y2="0.9">
          <stop offset="0" stopColor="#c9ecd6" />
          <stop offset="0.5" stopColor="#e6ead9" />
          <stop offset="1" stopColor="#f9c9d6" />
        </linearGradient>
        <radialGradient id="cloud-pink" cx="0.2" cy="0.85" r="0.45">
          <stop offset="0" stopColor="#fbd3dd" />
          <stop offset="1" stopColor="#fbd3dd" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="cloud-green" cx="0.72" cy="0.2" r="0.4">
          <stop offset="0" stopColor="#d6f1df" />
          <stop offset="1" stopColor="#d6f1df" stopOpacity="0" />
        </radialGradient>
      </defs>
      <g>
        <path id="cloud-shape" d="M50 152C22 152 6 126 17 100c6-14 13-22 13-38 0-22 18-35 37-32C76 11 102 3 124 16c9 5 14 12 27 12 22 0 36 18 32 38-2 12 6 22 10 37 7 27-11 49-37 49Z" fill="url(#cloud-base)" />
        <use href="#cloud-shape" fill="url(#cloud-pink)" />
        <use href="#cloud-shape" fill="url(#cloud-green)" />
      </g>
      <g fill="none" stroke="#5d6f66" strokeWidth="7.5" strokeLinecap="round">
        <path d="M63 97a14 14 0 0 1 28 0" />
        <path d="M111 97a14 14 0 0 1 28 0" />
      </g>
      <g fill="none" stroke="#5d6f66" strokeOpacity="0.22" strokeWidth="6" strokeLinecap="round">
        <path d="M64 72q8-6 16-3" />
        <path d="M122 69q8-3 16 3" />
      </g>
    </svg>
  )
}

function Brand() {
  return (
    <div className="brand">
      <EmilyCloud />
      <span className="wordmark">Emily</span>
    </div>
  )
}

type Tone = 'emergency' | 'precautionary' | 'calm' | 'checking'

// What the family needs to know about one fall, in words (never colour alone).
function describe(incident: Incident): { tone: Tone; label: string; state: string; open: boolean } {
  switch (incident.status) {
    case 'emergency':
      return { tone: 'emergency', label: 'Emergency', state: 'Unconfirmed', open: true }
    case 'precautionary':
      return { tone: 'precautionary', label: 'Possible fall', state: 'Unconfirmed', open: true }
    case 'acknowledged':
      return {
        tone: 'calm',
        label: incident.level === 'precautionary' ? 'Possible fall' : 'Emergency',
        state: `${incident.acknowledgedBy ?? 'Someone'} is on the way`,
        open: false,
      }
    case 'closed':
      return { tone: 'calm', label: 'No alert', state: 'Was OK', open: false }
    default:
      return { tone: 'checking', label: 'Fall detected', state: 'Checking', open: false }
  }
}

function ToneIcon({ tone }: { tone: Tone }) {
  if (tone === 'emergency' || tone === 'precautionary') {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M10 2.5 18.5 17h-17L10 2.5Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        <path d="M10 8v4.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="10" cy="14.6" r="1" fill="currentColor" />
      </svg>
    )
  }
  if (tone === 'calm') {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="7.6" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path d="m6.6 10.3 2.3 2.3 4.5-4.9" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="7.6" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M10 5.8V10l2.8 1.8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function StatusCard({ overview, now }: { overview: Overview; now: number }) {
  const { personName, lastHeartbeat, battery } = overview
  const never = lastHeartbeat === null
  const online = !never && now - lastHeartbeat < NO_SIGNAL_AFTER_MS
  const headline = never
    ? `Waiting for ${personName}'s watch`
    : online
      ? `${personName} is protected`
      : `No signal since ${timeFormat.format(lastHeartbeat)}`

  return (
    <section className={`status ${online ? 'status-on' : 'status-off'}`} aria-live="polite">
      <span className="status-dot" aria-hidden="true" />
      <div>
        <h1>{headline}</h1>
        <p>
          {never
            ? 'The watch has not connected yet.'
            : `Watch last seen ${formatAgo(lastHeartbeat, now)}`}
          {battery !== null && ` · Battery ${Math.round(battery)}%`}
        </p>
      </div>
    </section>
  )
}

function WhoPicker({
  names,
  who,
  onPick,
}: {
  names: string[]
  who: string | null
  onPick: (name: string) => void
}) {
  if (names.length === 0) return null
  return (
    <fieldset className="who">
      <legend>You are</legend>
      {names.map((name) => (
        <label key={name} className={name === who ? 'who-chip who-chip-on' : 'who-chip'}>
          <input type="radio" name="who" checked={name === who} onChange={() => onPick(name)} />
          {name}
        </label>
      ))}
    </fieldset>
  )
}

function IncidentCard({
  incident,
  now,
  who,
  onAcknowledge,
}: {
  incident: Incident
  now: number
  who: string | null
  onAcknowledge: (id: Id<'incidents'>) => Promise<void>
}) {
  const [sending, setSending] = useState(false)
  const { tone, label, state, open } = describe(incident)

  const handleClick = async () => {
    setSending(true)
    try {
      await onAcknowledge(incident._id)
    } finally {
      setSending(false)
    }
  }

  return (
    <li className={`fall fall-${tone}`}>
      <header>
        <span className="fall-badge">
          <ToneIcon tone={tone} />
          {label}
        </span>
        <time dateTime={new Date(incident.createdAt).toISOString()}>
          {formatWhen(incident.createdAt, now)}
        </time>
      </header>

      {incident.transcript ? (
        <blockquote>“{incident.transcript}”</blockquote>
      ) : (
        <p className="fall-silent">
          {incident.status === 'asking' ? 'Emily is checking in.' : 'No answer recorded.'}
        </p>
      )}

      <footer>
        <span className="fall-state">{state}</span>
        <span className="fall-impact">Impact {incident.impactMaxG.toFixed(1)} g</span>
      </footer>

      {open && (
        <button type="button" className="go" onClick={handleClick} disabled={sending || who === null}>
          {who === null ? 'Choose who you are first' : sending ? 'Sending…' : 'On my way'}
        </button>
      )}
    </li>
  )
}

function App() {
  const overview = useQuery(api.portal.overview, { deviceId: DEVICE_ID })
  const onMyWay = useMutation(api.portal.onMyWay)
  const now = useNow()
  const [who, setWho] = useState<string | null>(readWho)
  const [error, setError] = useState<string | null>(null)

  if (overview === undefined) {
    return (
      <main className="page">
        <Brand />
        <p className="quiet">Loading…</p>
      </main>
    )
  }
  if (overview === null) {
    return (
      <main className="page">
        <Brand />
        <p className="quiet">This watch is not set up yet.</p>
      </main>
    )
  }

  // A remembered name that is no longer in the family does not count.
  const activeWho = who !== null && overview.familyNames.includes(who) ? who : null
  const pickWho = (name: string) => {
    setWho(name)
    saveWho(name)
  }

  const acknowledge = async (incidentId: Id<'incidents'>) => {
    if (activeWho === null) return
    setError(null)
    try {
      const result = await onMyWay({ incidentId, name: activeWho })
      if (!result.ok) setError('Could not confirm. Try again.')
    } catch {
      setError('Could not confirm. Check your connection and try again.')
    }
  }

  return (
    <main className="page">
      <Brand />
      <StatusCard overview={overview} now={now} />
      <WhoPicker names={overview.familyNames} who={activeWho} onPick={pickWho} />

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <h2>Falls</h2>
      {overview.incidents.length === 0 ? (
        <p className="quiet">No falls recorded. {overview.personName}'s watch is keeping an eye out.</p>
      ) : (
        <ul className="falls">
          {overview.incidents.map((incident) => (
            <IncidentCard
              key={incident._id}
              incident={incident}
              now={now}
              who={activeWho}
              onAcknowledge={acknowledge}
            />
          ))}
        </ul>
      )}
    </main>
  )
}

export default App
