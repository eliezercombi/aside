// Wires the bridge, the display, the task source and the phone page together.

import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import { getTextWidth } from '@evenrealities/pretext'

import { mountCompanion } from './companion.ts'
import { wavFromPcm } from './core/audio.ts'
import { DemoSource, RelaySource } from './core/tasks.ts'
import type { Source } from './core/tasks.ts'
import { App } from './ui/app.ts'
import type { Input, Voice } from './ui/app.ts'
import { Display } from './ui/display.ts'
import type { Bridge } from './ui/display.ts'
import { translate } from './ui/input.ts'
import type { HubEvent } from './ui/input.ts'
import type { Page } from './ui/pages.ts'
import './style.css'

const STORE = 'aside.v1'
const log = (message: string): void => console.log(`[aside] ${message}`)

interface Saved {
  /** Address and token of the relay that holds the Notion token. Null means the built-in demo list. */
  relay: { url: string; token: string } | null
}

function load(): Saved {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) ?? 'null') as Partial<Saved> | null
    if (raw?.relay?.url && raw.relay.token) return { relay: { url: String(raw.relay.url), token: String(raw.relay.token) } }
  } catch { /* fall through to the demo */ }
  return { relay: null }
}

type Host = Bridge & {
  onEvenHubEvent: (cb: (event: HubEvent) => void) => () => void
  audioControl: (isOpen: boolean) => Promise<boolean>
}

/** Stand-in used in a plain browser tab, where no glasses host exists. */
const previewBridge: Host = {
  audioControl: async () => true,
  createStartUpPageContainer: async () => 0,
  rebuildPageContainer: async () => true,
  textContainerUpgrade: async () => true,
  shutDownPageContainer: async () => true,
  onEvenHubEvent: () => () => {},
}

async function connect(): Promise<{ bridge: Host; preview: boolean }> {
  const found = await Promise.race([
    waitForEvenAppBridge().then((bridge) => bridge as unknown as Host),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 2500)),
  ])
  return found ? { bridge: found, preview: false } : { bridge: previewBridge, preview: true }
}

const saved = load()
const source: Source = saved.relay ? new RelaySource(saved.relay.url, saved.relay.token) : new DemoSource()
const { bridge, preview } = await connect()
const display = new Display(bridge, { log })

// Push-to-talk: PCM frames from the glasses are collected while the touchpad is held,
// then sent to the relay, which is the only place that knows the speech service key.
const pcm: Uint8Array[] = []
let capturing = false
const voice: Voice = {
  start: () => {
    pcm.length = 0
    capturing = true
    void bridge.audioControl(true).catch((error) => log(`microphone: ${String(error)}`))
  },
  stop: async () => {
    capturing = false
    await bridge.audioControl(false).catch(() => false)
    return pcm.length ? source.transcribe(wavFromPcm(pcm)) : ''
  },
  cancel: () => {
    capturing = false
    void bridge.audioControl(false).catch(() => false)
  },
}

let companion: { update: (page: Page) => void } | null = null

const app = new App({
  source,
  voice,
  measure: getTextWidth,
  render: (page) => {
    display.show(page)
    companion?.update(page)
  },
  exit: () => display.exit(),
})

const handle = (input: Input): void => void app.input(input).catch((error) => log(`input failed: ${String(error)}`))

bridge.onEvenHubEvent((event) => {
  const audio = (event.audioEvent as { audioPcm?: ArrayLike<number> } | undefined)?.audioPcm
  if (audio) {
    if (capturing) pcm.push(Uint8Array.from(audio))
    return
  }
  const what = translate(event)
  if (what === null || what === 'background' || what === 'exit') return
  if (what === 'foreground') return void refresh()
  handle(what)
})

/** Pull the list again, but never under a screen the user is acting on. */
async function refresh(): Promise<void> {
  if (app.busy || app.screen.kind !== 'today') return
  try {
    await app.refresh()
  } catch (error) {
    app.note = error instanceof Error ? error.message : String(error)
  }
  app.render()
}

companion = mountCompanion(document.getElementById('app') as HTMLElement, {
  app,
  preview,
  relay: () => saved.relay,
  setRelay: (next) => {
    saved.relay = next
    localStorage.setItem(STORE, JSON.stringify(saved))
    // The source is chosen at start-up, so switching it restarts the page.
    setTimeout(() => location.reload(), 300)
  },
  capture: (text) => void app.capture(text).catch((error) => log(`capture failed: ${String(error)}`)),
  input: handle,
})

await app.start()
setInterval(() => void refresh(), 60_000)
log(`ready (${preview ? 'browser preview' : 'glasses bridge'}, ${saved.relay ? 'relay' : 'demo list'})`)
