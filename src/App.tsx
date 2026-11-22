import { useEffect, useId, useRef, useState } from 'react'
import { useAction, useMutation, useQuery } from 'convex/react'
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
// "Clear list" remembers the moment it was pressed, on this device only; nothing is deleted.
const CLEARED_STORAGE_KEY = 'emily.clearedAt'
// Falls removed one by one with "Remove from list", on this device only.
const HIDDEN_STORAGE_KEY = 'emily.hiddenFalls'

type Overview = NonNullable<ReturnType<typeof useQuery<typeof api.portal.overview>>>
type Incident = Overview['incidents'][number]
// Calm (sky blue): all is well. Alert (coral): look here. Plain: nothing to say yet.
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

function readClearedAt(): number {
  try {
    return Number(localStorage.getItem(CLEARED_STORAGE_KEY)) || 0
  } catch {
    return 0
  }
}

function readHidden(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(HIDDEN_STORAGE_KEY) ?? '[]')
    return Array.isArray(saved) ? saved.filter((id) => typeof id === 'string') : []
  } catch {
    return []
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

// Emily as a soft clay cloud: pale sky body, coral cheeks. Eyes are open and blink now and then (App.css);
// when something needs attention her brows lift and the smile goes.
function EmilyCloud({ mood }: { mood: Mood }) {
  const svgRef = useRef<SVGSVGElement>(null)
  // Emily is drawn twice on phones (panel and short bar). Each drawing needs its own
  // ids: a shared id points at the first copy, and when that copy is hidden the
  // gradients vanish and she loses her body and eyes.
  const uid = useId().replace(/:/g, '')

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
    <svg ref={svgRef} className={`emily emily-${mood}`} viewBox="0 0 200 178" role="img" aria-label="Emily">
      <defs>
        {/* Soft matte clay: light from the top left, shade toward the bottom right. */}
        <radialGradient id={`emily-clay-${uid}`} cx="0.32" cy="0.22" r="0.95">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.45" stopColor="#edf5fb" />
          <stop offset="1" stopColor="#bdd5ea" />
        </radialGradient>
        <radialGradient id={`emily-cheek-${uid}`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#ff9f85" stopOpacity="0.75" />
          <stop offset="1" stopColor="#ff9f85" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`emily-eye-${uid}`} cx="0.38" cy="0.3" r="0.8">
          <stop offset="0" stopColor="#35597d" />
          <stop offset="1" stopColor="#14283d" />
        </radialGradient>
        <radialGradient id={`emily-ground-${uid}`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#16324a" stopOpacity="0.22" />
          <stop offset="1" stopColor="#16324a" stopOpacity="0" />
        </radialGradient>
        {/* Shading inside the edge plus a fine grain, so the surface reads as a soft
            solid object instead of a flat sticker. */}
        <filter id={`emily-material-${uid}`} x="-10%" y="-10%" width="120%" height="125%">
          <feComponentTransfer in="SourceAlpha" result="outside">
            <feFuncA type="table" tableValues="1 0" />
          </feComponentTransfer>
          <feGaussianBlur in="outside" stdDeviation="9" result="outsideSoft" />
          <feOffset in="outsideSoft" dx="-7" dy="-10" result="shadeShape" />
          <feFlood floodColor="#5d86ad" floodOpacity="0.5" />
          <feComposite in2="shadeShape" operator="in" />
          <feComposite in2="SourceAlpha" operator="in" result="shade" />
          <feOffset in="outsideSoft" dx="6" dy="8" result="lightShape" />
          <feFlood floodColor="#ffffff" floodOpacity="0.9" />
          <feComposite in2="lightShape" operator="in" />
          <feComposite in2="SourceAlpha" operator="in" result="light" />
          <feTurbulence type="fractalNoise" baseFrequency="1.1" numOctaves="2" seed="7" result="noise" />
          <feColorMatrix
            in="noise"
            type="matrix"
            values="0 0 0 0 0.09  0 0 0 0 0.2  0 0 0 0 0.3  0 0 0 0.16 0"
          />
          <feComposite in2="SourceAlpha" operator="in" result="grain" />
          <feMerge>
            <feMergeNode in="SourceGraphic" />
            <feMergeNode in="shade" />
            <feMergeNode in="light" />
            <feMergeNode in="grain" />
          </feMerge>
        </filter>
      </defs>
      <ellipse cx="102" cy="166" rx="74" ry="9" fill={`url(#emily-ground-${uid})`} />
      <path
        d="M50 152C22 152 6 126 17 100c6-14 13-22 13-38 0-22 18-35 37-32C76 11 102 3 124 16c9 5 14 12 27 12 22 0 36 18 32 38-2 12 6 22 10 37 7 27-11 49-37 49Z"
        fill={`url(#emily-clay-${uid})`}
        filter={`url(#emily-material-${uid})`}
      />
      <ellipse cx="52" cy="116" rx="19" ry="13" fill={`url(#emily-cheek-${uid})`} />
      <ellipse cx="150" cy="116" rx="19" ry="13" fill={`url(#emily-cheek-${uid})`} />
      <g className="emily-brows" fill="none" stroke="#1d3d5c" strokeOpacity="0.32" strokeWidth="5.5" strokeLinecap="round">
        <path className="emily-brow-left" d="M64 68q9-6 18-3" />
        <path className="emily-brow-right" d="M120 65q9-3 18 3" />
      </g>
      <g className="emily-look">
        <g className="emily-eyes" fill={`url(#emily-eye-${uid})`}>
          <ellipse cx="76" cy="96" rx="10" ry="13" />
          <ellipse cx="126" cy="96" rx="10" ry="13" />
        </g>
        <g fill="#fff" fillOpacity="0.92" className="emily-glints">
          <circle cx="79.5" cy="90.5" r="3.4" />
          <circle cx="129.5" cy="90.5" r="3.4" />
        </g>
      </g>
      <path className="emily-smile" d="M91 117q10 8 20 0" fill="none" stroke="#1d3d5c" strokeWidth="4.5" strokeLinecap="round" />
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

// Roughly the height of the short bar: it appears when the big panel is above this line.
const MINI_BAR_PX = 72

// On a phone the big panel scrolls away. This short bar slides in at the top once it
// has, so Emily and her state stay in view; tapping it goes back up. The desktop
// layout keeps the whole panel fixed, so the bar is hidden there (App.css).
function MiniState({
  mood,
  headline,
  heroRef,
}: {
  mood: Mood
  headline: string
  heroRef: React.RefObject<HTMLElement | null>
}) {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const hero = heroRef.current
    if (!hero) return
    // Shown once the big panel has scrolled up past the height of this bar.
    const update = () => setShown(hero.getBoundingClientRect().bottom < MINI_BAR_PX)
    update()
    window.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [heroRef])

  return (
    <button
      type="button"
      className={`mini mini-${mood}${shown ? ' mini-on' : ''}`}
      // The big panel already announces changes; this is the same text again.
      aria-hidden={!shown}
      tabIndex={shown ? 0 : -1}
      aria-label={`${headline}. Back to top`}
      onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
    >
      <EmilyCloud mood={mood} />
      <span>{headline}</span>
    </button>
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
    headline = `Help is on the way to ${personName}`
    action = fresh
    showGo = false
    quote = spokenWords(fresh.transcript)
    detail = `She fell at ${timeFormat.format(fresh.createdAt)} and knows someone is coming.`
  } else if (never) {
    mood = 'plain'
    headline = `Waiting for ${personName}’s watch`
    detail = 'It has not connected yet.'
  } else if (!online) {
    mood = 'alert'
    headline = `No signal since ${timeFormat.format(lastHeartbeat)}`
    detail = `Emily cannot reach ${personName}’s watch. It may be off or out of Wi-Fi.`
  }

  const heroRef = useRef<HTMLElement>(null)
  const watchLine = never
    ? null
    : `Watch seen ${formatAgo(lastHeartbeat, now)}${battery !== null ? ` · battery ${Math.round(battery)}%` : ''}`

  return (
    <>
    <MiniState mood={mood} headline={headline} heroRef={heroRef} />
    <section ref={heroRef} className={`now now-${mood}`} aria-live="polite">
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
    </>
  )
}

// Emily's level for a fall, in words.
function levelOf(incident: Incident): string {
  if (incident.superseded) return 'Replaced by a newer fall'
  if (incident.falseAlarmBy) return 'False alarm'
  if (incident.level === 'emergency' || incident.status === 'emergency') return 'Emergency'
  if (incident.status === 'acknowledged') return 'Emergency'
  if (incident.status === 'precautionary') return 'Possible fall'
  if (incident.status === 'asking') return 'Checking'
  return 'No emergency'
}

type FallEvent = { _id: string; createdAt: number; text: string; level: 'info' | 'precautionary' | 'emergency' }
type Step = { key: string; at: number | null; text: string }

// One fall in one plain sentence: how it ended first, then what she said.
function summarize(incident: Incident, personName: string): { kind: 'ok' | 'alert' | 'wait'; title: string; said: string } {
  const words = spokenWords(incident.transcript)
  const said = words ? `${personName} said “${words}”` : `${personName} did not answer Emily`
  switch (incident.status) {
    case 'acknowledged':
      // About her, not about who went: the reader is often the one who went.
      return { kind: 'ok', title: `${personName} needed help`, said }
    case 'closed':
      if (incident.superseded) {
        return { kind: 'wait', title: 'Replaced by a newer fall', said: `${personName} fell again before answering` }
      }
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
  onRemove,
}: {
  incident: Incident
  personName: string
  events: FallEvent[] | undefined
  names: string[]
  who: string | null
  onGo: (incidentId: Id<'incidents'>, name: string) => Promise<void>
  onFalseAlarm: (incidentId: Id<'incidents'>, name: string) => Promise<void>
  showAction: boolean
  onRemove: (() => void) | null
}) {
  const [open, setOpen] = useState(false)
  const { kind, title } = summarize(incident, personName)
  const detailId = `fall-${incident._id}`
  const words = spokenWords(incident.transcript)
  const level = levelOf(incident)

  // One message from Emily: how serious, how sure, what she heard, how it ended.
  return (
    <li className={`msg msg-${kind}`}>
      <span className="msg-avatar" aria-hidden="true">
        <svg viewBox="0 0 200 160">
          <path d="M50 152C22 152 6 126 17 100c6-14 13-22 13-38 0-22 18-35 37-32C76 11 102 3 124 16c9 5 14 12 27 12 22 0 36 18 32 38-2 12 6 22 10 37 7 27-11 49-37 49Z" />
        </svg>
      </span>
      <div className="msg-bubble">
        <p className="msg-meta">
          <span>Emily</span>
          <time dateTime={new Date(incident.createdAt).toISOString()}>
            {timeFormat.format(incident.createdAt)}
          </time>
        </p>
        <p className="msg-level">
          {kind === 'ok' ? <CheckIcon /> : kind === 'alert' ? <AlertIcon /> : <ClockIcon />}
          {level}
        </p>
        <dl className="msg-facts">
          <div>
            <dt>How sure</dt>
            <dd>{incident.confidence === null ? 'Fixed rule, no rating' : `${Math.round(incident.confidence * 100)}%`}</dd>
          </div>
          <div>
            <dt>{personName} said</dt>
            <dd>{words ? `“${words}”` : 'Nothing'}</dd>
          </div>
          <div>
            <dt>Now</dt>
            <dd>{title}</dd>
          </div>
        </dl>
        <button
          type="button"
          className="text-button msg-more"
          aria-expanded={open}
          aria-controls={detailId}
          onClick={() => setOpen(!open)}
        >
          {open ? 'Hide details' : 'Details'}
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
            {onRemove && (
              <button type="button" className="text-button fall-remove" onClick={onRemove}>
                Remove from list
              </button>
            )}
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
      </div>
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
  const { personName, familyNames } = overview
  const [clearedAt, setClearedAt] = useState<number>(readClearedAt)
  // The chat scrolls inside its own box and opens at the bottom, on the newest message.
  const chatRef = useRef<HTMLDivElement>(null)
  const [hidden, setHidden] = useState<string[]>(readHidden)
  const saveHidden = (ids: string[]) => {
    setHidden(ids)
    try {
      localStorage.setItem(HIDDEN_STORAGE_KEY, JSON.stringify(ids))
    } catch {
      // Private window: hidden for this visit only.
    }
  }
  const hideOne = (id: string) => saveHidden([...hidden, id])
  // Cleared or removed falls are hidden, except the ones still waiting for someone.
  const incidents = overview.incidents.filter(
    (i) => isOpen(i) || (i.createdAt > clearedAt && !hidden.includes(i._id)),
  )
  const hiddenCount = overview.incidents.length - incidents.length
  const clearList = (at: number) => {
    // "Show them again" (at = 0) also brings back the ones removed one by one.
    if (at === 0) saveHidden([])
    setClearedAt(at)
    try {
      if (at === 0) localStorage.removeItem(CLEARED_STORAGE_KEY)
      else localStorage.setItem(CLEARED_STORAGE_KEY, String(at))
    } catch {
      // Private window: the list is cleared for this visit only.
    }
  }
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

  // Like a chat: oldest at the top, newest at the bottom.
  const shown = [...lists[tab]].reverse()
  const newestId = shown.length > 0 ? shown[shown.length - 1]._id : null
  useEffect(() => {
    const toBottom = () => {
      const chat = chatRef.current
      if (chat) chat.scrollTop = chat.scrollHeight
    }
    toBottom()
    // Turning the phone changes the box's height: stay on the newest message.
    window.addEventListener('resize', toBottom)
    return () => window.removeEventListener('resize', toBottom)
  }, [newestId, tab, shown.length])
  const days: { label: string; items: Incident[] }[] = []
  for (const incident of shown) {
    const label = dayLabel(incident.createdAt, now)
    const last = days[days.length - 1]
    if (last && last.label === label) last.items.push(incident)
    else days.push({ label, items: [incident] })
  }

  return (
    <section className="history">
      <div className="history-head">
        <h2>Messages from Emily</h2>
        {incidents.length > waiting.length && (
          <button type="button" className="text-button" onClick={() => clearList(Date.now())}>
            Clear list
          </button>
        )}
      </div>
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

      <div id="falls-panel" className="chat" ref={chatRef} role="tabpanel" aria-labelledby={`tab-${tab}`} tabIndex={0}>
        {shown.length === 0 ? (
          <p className="quiet">{empty[tab]}</p>
        ) : (
          days.map((day) => (
            <div key={day.label} className="day">
              <h3>{day.label}</h3>
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
                    // A fall still waiting for someone cannot be removed.
                    onRemove={isOpen(incident) ? null : () => hideOne(incident._id)}
                  />
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
      {hiddenCount > 0 && (
        <p className="care-note">
          {hiddenCount} older {hiddenCount === 1 ? 'fall is' : 'falls are'} hidden on this device.{' '}
          <button type="button" className="text-button" onClick={() => clearList(0)}>
            Show them again
          </button>
        </p>
      )}
    </section>
  )
}

// A short two-note chime when a fall starts waiting for the family. Browsers only allow
// sound after the person has touched the page, so on a page nobody has touched it stays
// silent; the coral panel and the Pushover alert carry the news either way.
const TONE_NOTES_HZ = [660, 880]
const TONE_NOTE_SECONDS = 0.22
const TONE_VOLUME = 0.18

function playAlertTone() {
  try {
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return
    const context = new AudioContext()
    TONE_NOTES_HZ.forEach((hz, i) => {
      const start = context.currentTime + i * TONE_NOTE_SECONDS
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      oscillator.type = 'sine'
      oscillator.frequency.value = hz
      gain.gain.setValueAtTime(0, start)
      gain.gain.linearRampToValueAtTime(TONE_VOLUME, start + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.001, start + TONE_NOTE_SECONDS)
      oscillator.connect(gain).connect(context.destination)
      oscillator.start(start)
      oscillator.stop(start + TONE_NOTE_SECONDS)
    })
    setTimeout(() => void context.close(), TONE_NOTES_HZ.length * TONE_NOTE_SECONDS * 1000 + 200)
  } catch {
    // No audio on this device: nothing to do.
  }
}

// Plays the chime once each time a different fall becomes the one waiting on the family.
function AlertTone({ urgentId }: { urgentId: string | null }) {
  const lastId = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    // Not on the first render: a fall that was already waiting when the page opened
    // is not news, and the browser would block the sound anyway.
    if (lastId.current !== undefined && urgentId !== null && urgentId !== lastId.current) {
      playAlertTone()
    }
    lastId.current = urgentId
  }, [urgentId])
  return null
}

// "08:00" (24 h, as stored) -> "8:00 AM".
function formatPillTime(time: string): string {
  const [hours, minutes] = time.split(':').map(Number)
  const date = new Date()
  date.setHours(hours, minutes, 0, 0)
  return timeFormat.format(date)
}

// Emily's summary of the day, written on request from the activity feed.
function Summary({ overview, now }: { overview: Overview; now: number }) {
  const generate = useAction(api.reports.generate)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const report = overview.latestReport
  // The numbers are counted here, not written by the AI, so they are always right.
  const today = overview.incidents.filter((i) => dayLabel(i.createdAt, now) === 'Today' && !i.superseded)
  const facts = {
    falls: today.length,
    neededHelp: today.filter((i) => i.status === 'acknowledged').length,
    wasOk: today.filter((i) => i.status === 'closed').length,
    waiting: today.filter(isOpen).length,
  }

  const write = async () => {
    setBusy(true)
    setProblem(null)
    try {
      const result = await generate({ deviceId: DEVICE_ID })
      if (!result.ok) setProblem(result.text)
    } catch {
      setProblem('No connection. Check your internet and try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="care">
      <h2>Summary</h2>
      <dl className="day-facts">
        <div>
          <dt>Falls today</dt>
          <dd>{facts.falls}</dd>
        </div>
        <div>
          <dt>Needed help</dt>
          <dd>{facts.neededHelp}</dd>
        </div>
        <div>
          <dt>Was OK</dt>
          <dd>{facts.wasOk}</dd>
        </div>
        <div className={facts.waiting > 0 ? 'day-fact-alert' : undefined}>
          <dt>Still waiting</dt>
          <dd>{facts.waiting}</dd>
        </div>
      </dl>
      {report ? (
        <>
          <p className="summary-text">{report.text}</p>
          <p className="care-note">
            Written {dayLabel(report.createdAt, now).toLowerCase()} at {timeFormat.format(report.createdAt)}
          </p>
        </>
      ) : (
        <p className="quiet">Emily can add a sentence about how the day went.</p>
      )}
      {problem && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
      <button type="button" className="quiet-button" onClick={write} disabled={busy}>
        {busy ? 'Writing…' : report ? 'Write a new summary' : 'Summarize today'}
      </button>
    </section>
  )
}

// Pill reminders: Emily says them on the watch at the set time, every day.
function Pills({ overview }: { overview: Overview }) {
  const addPill = useMutation(api.portal.addPill)
  const removePill = useMutation(api.portal.removePill)
  const [name, setName] = useState('')
  const [time, setTime] = useState('08:00')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const add = async (event: React.FormEvent) => {
    event.preventDefault()
    if (name.trim() === '') {
      setProblem('Type the name of the pill first.')
      return
    }
    setBusy(true)
    setProblem(null)
    try {
      const result = await addPill({ deviceId: DEVICE_ID, name: name.trim(), time })
      if (result.ok) setName('')
      else setProblem(result.error ?? 'That did not save. Try again.')
    } catch {
      setProblem('No connection. Check your internet and try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="care">
      <h2>Pill reminders</h2>
      {overview.pills.length === 0 ? (
        <p className="quiet">
          None yet. Add one and Emily will remind {overview.personName} on the watch every day at that time.
        </p>
      ) : (
        <ul className="pills">
          {overview.pills.map((pill) => (
            <li key={pill._id}>
              <span className="pill-time">{formatPillTime(pill.time)}</span>
              <span className="pill-name">{pill.name}</span>
              <button
                type="button"
                className="text-button"
                onClick={() => void removePill({ pillId: pill._id })}
                aria-label={`Remove the ${pill.name} reminder`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <form className="pill-form" onSubmit={add}>
        <label>
          <span>Pill</span>
          <input
            type="text"
            value={name}
            maxLength={40}
            placeholder="Blood pressure"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          <span>Time</span>
          <input type="time" value={time} required onChange={(event) => setTime(event.target.value)} />
        </label>
        <button type="submit" className="quiet-button" disabled={busy}>
          {busy ? 'Adding…' : 'Add reminder'}
        </button>
      </form>
      {problem && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
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

  // The fall that is waiting on the family right now, if any (same test as NowPanel).
  const newest = overview.incidents[0]
  const urgentId =
    newest !== undefined && isOpen(newest) && now - newest.createdAt < FRESH_FALL_MS ? newest._id : null

  return (
    <main>
      <AlertTone urgentId={urgentId} />
      <NowPanel overview={overview} now={now} who={activeWho} onGo={go} onFalseAlarm={falseAlarm} />
      <div className="page">
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <History overview={overview} eventsByFall={eventsByFall} now={now} who={activeWho} onGo={go} onFalseAlarm={falseAlarm} />
        <Summary overview={overview} now={now} />
        <Pills overview={overview} />
      </div>
    </main>
  )
}

export default App
