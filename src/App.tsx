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
// How many recent feed rows to load for the step-by-step view (the backend's maximum).
const FEED_LIMIT = 200
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

type Reply = 'go' | 'false'

// The two answers to a fall: "I'm on my way" and "It was a false alarm". If this phone
// does not know who is holding it yet, the tapped answer asks, then both confirms and
// remembers. `showGo` is false once someone is already on the way.
function Respond({
  names,
  who,
  onGo,
  onFalseAlarm,
  compact = false,
  showGo = true,
}: {
  names: string[]
  who: string | null
  onGo: (name: string) => Promise<void>
  onFalseAlarm: (name: string) => Promise<void>
  compact?: boolean
  showGo?: boolean
}) {
  const [asking, setAsking] = useState<Reply | null>(null)
  const [sending, setSending] = useState(false)

  const send = async (reply: Reply, name: string) => {
    setSending(true)
    try {
      await (reply === 'go' ? onGo(name) : onFalseAlarm(name))
    } finally {
      setSending(false)
      setAsking(null)
    }
  }
  const choose = (reply: Reply) => (who === null ? setAsking(reply) : send(reply, who))

  if (asking !== null) {
    return (
      <div className={compact ? 'go-who go-who-compact' : 'go-who'}>
        <p id="go-who-label">{asking === 'go' ? 'Who is on the way?' : 'Who is saying it was a false alarm?'}</p>
        <div role="group" aria-labelledby="go-who-label">
          {names.map((name) => (
            <button key={name} type="button" className="go" onClick={() => send(asking, name)} disabled={sending}>
              {name}
            </button>
          ))}
        </div>
        <button type="button" className="text-button go-cancel" onClick={() => setAsking(null)}>
          Cancel
        </button>
      </div>
    )
  }

  if (compact) {
    return (
      <div className="go-links">
        {showGo && (
          <button type="button" className="go-link" onClick={() => choose('go')} disabled={sending}>
            I’m on my way
          </button>
        )}
        <button type="button" className="go-link go-link-quiet" onClick={() => choose('false')} disabled={sending}>
          It was a false alarm
        </button>
      </div>
    )
  }

  return (
    <div className="go-wrap">
      {showGo && (
        <button type="button" className="go" onClick={() => choose('go')} disabled={sending}>
          {sending ? 'Sending…' : 'I’m on my way'}
        </button>
      )}
      <button type="button" className="go-second" onClick={() => choose('false')} disabled={sending}>
        It was a false alarm
      </button>
      {who !== null && (
        <p className="go-as">
          Answering as {who}.{' '}
          <button type="button" className="text-button" onClick={() => setAsking(showGo ? 'go' : 'false')}>
            Not you?
          </button>
        </p>
      )}
    </div>
  )
}

// The top of the page answers one question: is she OK right now?
function NowPanel({
  overview,
  now,
  who,
  onGo,
  onFalseAlarm,
}: {
  overview: Overview
  now: number
  who: string | null
  onGo: (incidentId: Id<'incidents'>, name: string) => Promise<void>
  onFalseAlarm: (incidentId: Id<'incidents'>, name: string) => Promise<void>
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
  // Someone is already going: the only answer left is "false alarm".
  let showGo = true

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
    action = fresh
    showGo = false
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
          <Respond
            names={familyNames}
            who={who}
            showGo={showGo}
            onGo={(name) => onGo(action._id, name)}
            onFalseAlarm={(name) => onFalseAlarm(action._id, name)}
          />
        )}

        {watchLine && <p className="now-watch">{watchLine}</p>}
      </div>
    </section>
  )
}

type FallEvent = { _id: string; createdAt: number; text: string; level: 'info' | 'precautionary' | 'emergency' }
type Step = { key: string; at: number | null; text: string }

// One fall in one plain sentence: how it ended first, then what she said.
function summarize(incident: Incident, personName: string): { kind: 'ok' | 'alert' | 'wait'; title: string; said: string } {
  const words = spokenWords(incident.transcript)
  const said = words ? `${personName} said “${words}”` : `${personName} did not answer Emily`
  switch (incident.status) {
    case 'acknowledged':
      return { kind: 'ok', title: `${incident.acknowledgedBy ?? 'Someone'} went to help`, said }
    case 'closed':
      return incident.falseAlarmBy
        ? { kind: 'ok', title: 'False alarm', said: `${incident.falseAlarmBy} said it was a false alarm` }
        : { kind: 'ok', title: `${personName} was OK`, said }
    case 'emergency':
      return { kind: 'alert', title: 'Nobody has answered this fall', said }
    case 'precautionary':
      return { kind: 'alert', title: 'Nobody has answered this possible fall', said }
    default:
      return { kind: 'wait', title: `Emily is checking on ${personName}`, said }
  }
}

// What happened, step by step. Uses the activity feed when it has this fall; older
// falls (from before the feed existed) get the steps we can tell from the fall itself.
function stepsOf(incident: Incident, personName: string, events: FallEvent[] | undefined): Step[] {
  if (events && events.length > 0) {
    // A "said" row that holds only sound tags ("[typing]") was not speech.
    const onlySounds = /said: "\s*(\[[^\]]*\]\s*)+"$/
    return events.map((e) => ({
      key: e._id,
      at: e.createdAt,
      text: onlySounds.test(e.text) ? `${personName} did not say any words` : e.text,
    }))
  }
  const words = spokenWords(incident.transcript)
  const steps: Step[] = [
    { key: 'fall', at: incident.createdAt, text: `Fall detected (impact ${incident.impactMaxG.toFixed(1)} g)` },
    { key: 'said', at: null, text: words ? `${personName} said: “${words}”` : `${personName} did not answer` },
  ]
  if (incident.status === 'acknowledged') {
    steps.push({ key: 'end', at: null, text: `${incident.acknowledgedBy ?? 'Someone'} is on the way` })
  } else if (incident.status === 'closed') {
    steps.push({
      key: 'end',
      at: null,
      text: incident.falseAlarmBy ? `${incident.falseAlarmBy} marked this as a false alarm` : 'No alert was needed',
    })
  } else if (isOpen(incident)) {
    steps.push({ key: 'end', at: null, text: 'The family was alerted. Nobody has answered yet.' })
  }
  return steps
}

const stepTimeFormat = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })

function FallRow({
  incident,
  personName,
  events,
  names,
  who,
  onGo,
  onFalseAlarm,
  showAction,
}: {
  incident: Incident
  personName: string
  events: FallEvent[] | undefined
  names: string[]
  who: string | null
  onGo: (incidentId: Id<'incidents'>, name: string) => Promise<void>
  onFalseAlarm: (incidentId: Id<'incidents'>, name: string) => Promise<void>
  showAction: boolean
}) {
  const [open, setOpen] = useState(false)
  const { kind, title, said } = summarize(incident, personName)
  const detailId = `fall-${incident._id}`

  return (
    <li className={open ? 'fall fall-open' : 'fall'}>
      <button
        type="button"
        className="fall-head"
        aria-expanded={open}
        aria-controls={detailId}
        onClick={() => setOpen(!open)}
      >
        <span className={`fall-mark fall-mark-${kind}`}>
          {kind === 'ok' ? <CheckIcon /> : kind === 'alert' ? <AlertIcon /> : <ClockIcon />}
        </span>
        <span className="fall-text">
          <span className="fall-title">{title}</span>
          <span className="fall-said">{said}</span>
        </span>
        <time dateTime={new Date(incident.createdAt).toISOString()}>
          {timeFormat.format(incident.createdAt)}
        </time>
        <svg className="fall-chevron" viewBox="0 0 20 20" aria-hidden="true">
          <path d="m6 8 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {showAction && (
        <div className="fall-action">
          <Respond
            compact
            names={names}
            who={who}
            onGo={(name) => onGo(incident._id, name)}
            onFalseAlarm={(name) => onFalseAlarm(incident._id, name)}
          />
        </div>
      )}

      {open && (
        <div id={detailId} className="fall-detail">
          <h4>What happened</h4>
          <ol>
            {stepsOf(incident, personName, events).map((step) => (
              <li key={step.key}>
                <span className="step-time">{step.at === null ? '' : stepTimeFormat.format(step.at)}</span>
                <span>{step.text}</span>
              </li>
            ))}
          </ol>
          {incident.status === 'acknowledged' && (
            <Respond
              compact
              showGo={false}
              names={names}
              who={who}
              onGo={(name) => onGo(incident._id, name)}
              onFalseAlarm={(name) => onFalseAlarm(incident._id, name)}
            />
          )}
        </div>
      )}
    </li>
  )
}

type Tab = 'new' | 'today' | 'week'
const TAB_ORDER: Tab[] = ['new', 'today', 'week']

// Falls in three views: the ones still waiting for someone, today's, and the last 7 days.
function History({
  overview,
  eventsByFall,
  now,
  who,
  onGo,
  onFalseAlarm,
}: {
  overview: Overview
  eventsByFall: Map<string, FallEvent[]>
  now: number
  who: string | null
  onGo: (incidentId: Id<'incidents'>, name: string) => Promise<void>
  onFalseAlarm: (incidentId: Id<'incidents'>, name: string) => Promise<void>
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
                    personName={personName}
                    events={eventsByFall.get(incident._id)}
                    names={familyNames}
                    who={who}
                    onGo={onGo}
                    onFalseAlarm={onFalseAlarm}
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
  // The activity feed, for the step-by-step view of each fall.
  const feed = useQuery(api.events.list, { deviceId: DEVICE_ID, limit: FEED_LIMIT })
  const onMyWay = useMutation(api.portal.onMyWay)
  const markFalseAlarm = useMutation(api.portal.markFalseAlarm)
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

  // Feed rows grouped by fall, oldest step first (the feed arrives newest first).
  const eventsByFall = new Map<string, FallEvent[]>()
  for (const event of feed ?? []) {
    if (!event.incidentId) continue
    const steps = eventsByFall.get(event.incidentId) ?? []
    steps.unshift(event)
    eventsByFall.set(event.incidentId, steps)
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

  const falseAlarm = async (incidentId: Id<'incidents'>, name: string) => {
    setWho(name)
    saveWho(name)
    setError(null)
    try {
      const result = await markFalseAlarm({ incidentId, name })
      if (!result.ok) setError('That did not go through. Tap “It was a false alarm” again.')
    } catch {
      setError('No connection. Check your internet and try again.')
    }
  }

  return (
    <main>
      <NowPanel overview={overview} now={now} who={activeWho} onGo={go} onFalseAlarm={falseAlarm} />
      <div className="page">
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <History overview={overview} eventsByFall={eventsByFall} now={now} who={activeWho} onGo={go} onFalseAlarm={falseAlarm} />
      </div>
    </main>
  )
}

export default App
