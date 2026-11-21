import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { api } from '../convex/_generated/api'
import type { Id } from '../convex/_generated/dataModel'
import './App.css'

// The demo watch (convex/seed.ts).
const DEVICE_ID = 'watch-1'
// The watch polls at least once a minute; three missed minutes means no signal.
const NO_SIGNAL_AFTER_MS = 3 * 60 * 1000
// A fall this recent leads the page; older ones only appear in the history.
const FRESH_FALL_MS = 30 * 60 * 1000
// "Fabian is on the way" leads the page only this long after the fall; then it is history.
const ON_THE_WAY_MS = 10 * 60 * 1000
const WEEK_MS = 7 * 24 * 60 * 60 * 1000
// How often the "last seen" texts are refreshed.
const CLOCK_TICK_MS = 15 * 1000
const WHO_STORAGE_KEY = 'emily.who'

type Overview = NonNullable<ReturnType<typeof useQuery<typeof api.portal.overview>>>
type Incident = Overview['incidents'][number]
// Green: all is well. Pink: look here. Plain: nothing to say yet.
type Mood = 'calm' | 'alert' | 'plain'

const timeFormat = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' })
const dayFormat = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'short', day: 'numeric' })

function dayLabel(ms: number, now: number): string {
  const day = new Date(ms).toDateString()
  if (day === new Date(now).toDateString()) return 'Today'
  if (day === new Date(now - 24 * 60 * 60 * 1000).toDateString()) return 'Yesterday'
  return dayFormat.format(ms)
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

// How far Emily's eyes travel toward the pointer, in SVG units.
const LOOK_MAX_X = 7
const LOOK_MAX_Y = 5
// The pointer distance (px) at which her eyes reach that limit.
const LOOK_REACH_PX = 320

// Speech-to-text writes sounds as tags: "[silence]", "[sighs]". Those are not words
// the person said, so they are never shown as a quote.
function spokenWords(transcript: string | null): string | null {
  if (transcript === null) return null
  const words = transcript.replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim()
  return words === '' ? null : words
}

const isOpen = (incident: Incident) =>
  incident.status === 'emergency' || incident.status === 'precautionary'

// Emily's cloud in her two pastels. Eyes are open and blink now and then (App.css);
// when something needs attention her brows lift and the smile goes.
function EmilyCloud({ mood }: { mood: Mood }) {
  const svgRef = useRef<SVGSVGElement>(null)

  // Her eyes follow the pointer (mouse, pen or finger). Set as CSS variables so React
  // does not re-render on every move.
  useEffect(() => {
    const svg = svgRef.current
    if (!svg || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let frame = 0
    const look = (event: PointerEvent) => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const box = svg.getBoundingClientRect()
        const dx = event.clientX - (box.left + box.width / 2)
        const dy = event.clientY - (box.top + box.height * 0.6)
        const pull = Math.min(1, Math.hypot(dx, dy) / LOOK_REACH_PX)
        const angle = Math.atan2(dy, dx)
        svg.style.setProperty('--look-x', (Math.cos(angle) * pull * LOOK_MAX_X).toFixed(2))
        svg.style.setProperty('--look-y', (Math.sin(angle) * pull * LOOK_MAX_Y).toFixed(2))
      })
    }
    window.addEventListener('pointermove', look, { passive: true })
    window.addEventListener('pointerdown', look, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('pointermove', look)
      window.removeEventListener('pointerdown', look)
    }
  }, [])

  return (
    <svg ref={svgRef} className={`emily emily-${mood}`} viewBox="0 0 200 160" role="img" aria-label="Emily">
      <defs>
        <linearGradient id="emily-base" x1="0" y1="0.1" x2="1" y2="0.9">
          <stop offset="0" stopColor="#a6dfbd" />
          <stop offset="0.52" stopColor="#e3ecd6" />
          <stop offset="1" stopColor="#f3a9c0" />
        </linearGradient>
        <radialGradient id="emily-pink" cx="0.2" cy="0.86" r="0.46">
          <stop offset="0" stopColor="#f7b9cb" />
          <stop offset="1" stopColor="#f7b9cb" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="emily-green" cx="0.72" cy="0.18" r="0.42">
          <stop offset="0" stopColor="#bfe9cf" />
          <stop offset="1" stopColor="#bfe9cf" stopOpacity="0" />
        </radialGradient>
        <path
          id="emily-shape"
          d="M50 152C22 152 6 126 17 100c6-14 13-22 13-38 0-22 18-35 37-32C76 11 102 3 124 16c9 5 14 12 27 12 22 0 36 18 32 38-2 12 6 22 10 37 7 27-11 49-37 49Z"
        />
      </defs>
      <use href="#emily-shape" fill="url(#emily-base)" />
      <use href="#emily-shape" fill="url(#emily-pink)" />
      <use href="#emily-shape" fill="url(#emily-green)" />
      <g className="emily-brows" fill="none" stroke="#51645a" strokeOpacity="0.3" strokeWidth="5.5" strokeLinecap="round">
        <path className="emily-brow-left" d="M64 68q9-6 18-3" />
        <path className="emily-brow-right" d="M120 65q9-3 18 3" />
      </g>
      <g className="emily-look">
        <g className="emily-eyes" fill="#46584f">
          <ellipse cx="76" cy="96" rx="9.5" ry="12.5" />
          <ellipse cx="126" cy="96" rx="9.5" ry="12.5" />
        </g>
        <g fill="#fff" fillOpacity="0.85" className="emily-glints">
          <circle cx="79" cy="91" r="3" />
          <circle cx="129" cy="91" r="3" />
        </g>
      </g>
      <path className="emily-smile" d="M92 118q9 7 18 0" fill="none" stroke="#46584f" strokeWidth="4.5" strokeLinecap="round" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="m4.5 10.6 3.6 3.6 7.4-8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function AlertIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 3 17.8 16.5H2.2L10 3Z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M10 8.2v3.6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="10" cy="14.1" r="1.1" fill="currentColor" />
    </svg>
  )
}

function ClockIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="7.2" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M10 6v4.2l2.6 1.7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// "I'm on my way". If this phone does not know who is holding it yet, the same
// button asks, and the answer both confirms and is remembered.
function OnMyWay({
  names,
  who,
  onGo,
  compact = false,
}: {
  names: string[]
  who: string | null
  onGo: (name: string) => Promise<void>
  compact?: boolean
}) {
  const [choosing, setChoosing] = useState(false)
  const [sending, setSending] = useState(false)

  const go = async (name: string) => {
    setSending(true)
    try {
      await onGo(name)
    } finally {
      setSending(false)
      setChoosing(false)
    }
  }

  if (choosing || (who === null && !compact)) {
    return (
      <div className={compact ? 'go-who go-who-compact' : 'go-who'}>
        <p id="go-who-label">Who is on the way?</p>
        <div role="group" aria-labelledby="go-who-label">
          {names.map((name) => (
            <button key={name} type="button" className="go" onClick={() => go(name)} disabled={sending}>
              {name}
            </button>
          ))}
        </div>
      </div>
    )
  }

  if (compact) {
    return (
      <button
        type="button"
        className="go-link"
        onClick={() => (who === null ? setChoosing(true) : go(who))}
        disabled={sending}
      >
        {sending ? 'Sending…' : 'I’m on my way'}
      </button>
    )
  }

  return (
    <div className="go-wrap">
      <button type="button" className="go" onClick={() => go(who!)} disabled={sending}>
        {sending ? 'Sending…' : 'I’m on my way'}
      </button>
      <p className="go-as">
        Confirming as {who}.{' '}
        <button type="button" className="text-button" onClick={() => setChoosing(true)}>
          Not you?
        </button>
      </p>
    </div>
  )
}

// The top of the page answers one question: is she OK right now?
function NowPanel({
  overview,
  now,
  who,
  onGo,
}: {
  overview: Overview
  now: number
  who: string | null
  onGo: (incidentId: Id<'incidents'>, name: string) => Promise<void>
}) {
  const { personName, lastHeartbeat, battery, familyNames } = overview
  const latest = overview.incidents[0]
  const fresh = latest !== undefined && now - latest.createdAt < FRESH_FALL_MS ? latest : null
  const never = lastHeartbeat === null
  const online = !never && now - lastHeartbeat < NO_SIGNAL_AFTER_MS

  // Calm is the default: nothing is waiting for anyone.
  let mood: Mood = 'calm'
  let headline = `${personName} is doing fine`
  const unanswered = overview.incidents.filter(isOpen).length
  const lastDay = latest ? dayLabel(latest.createdAt, now) : ''
  const lastWhen =
    lastDay === 'Today' ? 'today' : lastDay === 'Yesterday' ? 'yesterday' : `on ${lastDay}`
  let detail: string | null = !latest
    ? 'No falls detected.'
    : unanswered > 0
      ? `Nothing new. ${unanswered === 1 ? 'One older fall was' : `${unanswered} older falls were`} never answered.`
      : `No falls need attention. The last one was ${lastWhen} at ${timeFormat.format(latest.createdAt)}.`
  let quote: string | null = null
  let action: Incident | null = null

  if (fresh && isOpen(fresh)) {
    mood = 'alert'
    headline =
      fresh.status === 'emergency'
        ? `${personName} fell at ${timeFormat.format(fresh.createdAt)}`
        : `${personName} may have fallen at ${timeFormat.format(fresh.createdAt)}`
    quote = spokenWords(fresh.transcript)
    detail = quote ? null : `No answer from ${personName} yet.`
    action = fresh
  } else if (fresh && fresh.status === 'asking') {
    mood = 'alert'
    headline = `Possible fall at ${timeFormat.format(fresh.createdAt)}`
    detail = `Emily is asking ${personName} if everything is OK.`
  } else if (fresh && fresh.status === 'acknowledged' && now - fresh.createdAt < ON_THE_WAY_MS) {
    headline = `${fresh.acknowledgedBy ?? 'Someone'} is on the way`
    detail = `${personName} fell at ${timeFormat.format(fresh.createdAt)}. Emily told ${personName} that help is coming.`
  } else if (never) {
    mood = 'plain'
    headline = `Waiting for ${personName}’s watch`
    detail = 'It has not connected yet.'
  } else if (!online) {
    mood = 'alert'
    headline = `No signal since ${timeFormat.format(lastHeartbeat)}`
    detail = `Emily cannot reach ${personName}’s watch. It may be off or out of Wi-Fi.`
  }

  const watchLine = never
    ? null
    : `Watch seen ${formatAgo(lastHeartbeat, now)}${battery !== null ? ` · battery ${Math.round(battery)}%` : ''}`

  return (
    <section className={`now now-${mood}`} aria-live="polite">
      <div className="now-inner">
        <div className="brand">
          <EmilyCloud mood={mood} />
          <span className="wordmark">Emily</span>
        </div>

        <h1>{headline}</h1>
        {quote && <blockquote>“{quote}”</blockquote>}
        {detail && <p className="now-detail">{detail}</p>}

        {action && (
          <OnMyWay names={familyNames} who={who} onGo={(name) => onGo(action._id, name)} />
        )}

        {watchLine && <p className="now-watch">{watchLine}</p>}
      </div>
    </section>
  )
}

function stateOf(incident: Incident): { kind: 'ok' | 'alert' | 'wait'; text: string } {
  switch (incident.status) {
    case 'acknowledged':
      return { kind: 'ok', text: `${incident.acknowledgedBy ?? 'Someone'} went` }
    case 'closed':
      return { kind: 'ok', text: 'Was OK' }
    case 'emergency':
      return { kind: 'alert', text: 'Emergency, nobody confirmed' }
    case 'precautionary':
      return { kind: 'alert', text: 'Possible fall, nobody confirmed' }
    default:
      return { kind: 'wait', text: 'Emily is checking' }
  }
}

function FallRow({
  incident,
  names,
  who,
  onGo,
  showAction,
}: {
  incident: Incident
  names: string[]
  who: string | null
  onGo: (incidentId: Id<'incidents'>, name: string) => Promise<void>
  showAction: boolean
}) {
  const state = stateOf(incident)
  const said = spokenWords(incident.transcript)
  return (
    <li className="fall">
      <p className="fall-when">
        <time dateTime={new Date(incident.createdAt).toISOString()}>
          {timeFormat.format(incident.createdAt)}
        </time>
        <span title="Strength of the impact">{incident.impactMaxG.toFixed(1)} g</span>
      </p>
      <div className="fall-body">
        <p className={said ? 'fall-said' : 'fall-said fall-silent'}>
          {said ? `“${said}”` : 'No answer'}
        </p>
        <p className={`fall-state fall-state-${state.kind}`}>
          {state.kind === 'ok' ? <CheckIcon /> : state.kind === 'alert' ? <AlertIcon /> : <ClockIcon />}
          <span>{state.text}</span>
        </p>
        {showAction && (
          <OnMyWay compact names={names} who={who} onGo={(name) => onGo(incident._id, name)} />
        )}
      </div>
    </li>
  )
}

type Tab = 'new' | 'today' | 'week'
const TAB_ORDER: Tab[] = ['new', 'today', 'week']

// Falls in three views: the ones still waiting for someone, today's, and the last 7 days.
function History({
  overview,
  now,
  who,
  onGo,
}: {
  overview: Overview
  now: number
  who: string | null
  onGo: (incidentId: Id<'incidents'>, name: string) => Promise<void>
}) {
  const { incidents, personName, familyNames } = overview
  const waiting = incidents.filter(isOpen)
  const today = incidents.filter((i) => dayLabel(i.createdAt, now) === 'Today')
  const week = incidents.filter((i) => now - i.createdAt < WEEK_MS)
  const lists: Record<Tab, Incident[]> = { new: waiting, today, week }

  // Until the person picks a tab: open on what needs them, otherwise on today.
  const [picked, setPicked] = useState<Tab | null>(null)
  const tab: Tab = picked ?? (waiting.length > 0 ? 'new' : 'today')

  const tabs: { id: Tab; label: string }[] = [
    { id: 'new', label: 'New' },
    { id: 'today', label: 'Today' },
    { id: 'week', label: 'This week' },
  ]
  const empty: Record<Tab, string> = {
    new: 'Nothing is waiting for you. Falls that nobody has answered show up here.',
    today: `No falls today. If ${personName} falls, it shows up here right away.`,
    week: 'No falls in the last 7 days.',
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
    const step = event.key === 'ArrowRight' ? 1 : -1
    const next = TAB_ORDER[(TAB_ORDER.indexOf(tab) + step + TAB_ORDER.length) % TAB_ORDER.length]
    setPicked(next)
    document.getElementById(`tab-${next}`)?.focus()
  }

  // The fresh open fall already has the big button at the top of the page.
  const leading =
    incidents.length > 0 && now - incidents[0].createdAt < FRESH_FALL_MS && isOpen(incidents[0])
      ? incidents[0]._id
      : null

  const shown = lists[tab]
  const days: { label: string; items: Incident[] }[] = []
  for (const incident of shown) {
    const label = dayLabel(incident.createdAt, now)
    const last = days[days.length - 1]
    if (last && last.label === label) last.items.push(incident)
    else days.push({ label, items: [incident] })
  }
  // One day needs no day heading on the Today tab.
  const showDayHeadings = tab !== 'today'

  return (
    <section className="history">
      <h2>Falls</h2>
      <div className="tabs" role="tablist" aria-label="Which falls to show" onKeyDown={onKeyDown}>
        {tabs.map(({ id, label }) => (
          <button
            key={id}
            id={`tab-${id}`}
            type="button"
            role="tab"
            aria-selected={tab === id}
            aria-controls="falls-panel"
            tabIndex={tab === id ? 0 : -1}
            className={id === 'new' && waiting.length > 0 ? 'tab tab-urgent' : 'tab'}
            onClick={() => setPicked(id)}
          >
            {label}
            <span className="tab-count">{lists[id].length}</span>
          </button>
        ))}
      </div>

      <div id="falls-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {shown.length === 0 ? (
          <p className="quiet">{empty[tab]}</p>
        ) : (
          days.map((day) => (
            <div key={day.label} className="day">
              {showDayHeadings && <h3>{day.label}</h3>}
              <ul>
                {day.items.map((incident) => (
                  <FallRow
                    key={incident._id}
                    incident={incident}
                    names={familyNames}
                    who={who}
                    onGo={onGo}
                    showAction={isOpen(incident) && incident._id !== leading}
                  />
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
    </section>
  )
}

function App() {
  const overview = useQuery(api.portal.overview, { deviceId: DEVICE_ID })
  const onMyWay = useMutation(api.portal.onMyWay)
  const now = useNow()
  const [who, setWho] = useState<string | null>(readWho)
  const [error, setError] = useState<string | null>(null)

  if (overview === undefined || overview === null) {
    return (
      <main>
        <section className="now now-plain">
          <div className="now-inner">
            <div className="brand">
              <EmilyCloud mood="plain" />
              <span className="wordmark">Emily</span>
            </div>
            <h1>{overview === null ? 'This watch is not set up yet' : 'Connecting…'}</h1>
          </div>
        </section>
      </main>
    )
  }

  // A remembered name that is no longer in the family does not count.
  const activeWho = who !== null && overview.familyNames.includes(who) ? who : null

  const go = async (incidentId: Id<'incidents'>, name: string) => {
    setWho(name)
    saveWho(name)
    setError(null)
    try {
      const result = await onMyWay({ incidentId, name })
      if (!result.ok) setError('That did not go through. Tap “I’m on my way” again.')
    } catch {
      setError('No connection. Check your internet and tap “I’m on my way” again.')
    }
  }

  return (
    <main>
      <NowPanel overview={overview} now={now} who={activeWho} onGo={go} />
      <div className="page">
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <History overview={overview} now={now} who={activeWho} onGo={go} />
      </div>
    </main>
  )
}

export default App
