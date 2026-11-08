// Popup: on/off switch, live status from the Meet tab (via bridge.js), and two manual controls.
const $ = (id) => document.getElementById(id)
const enabledInput = $('enabled')

// the switch lives in chrome.storage; bridge.js passes it on to the page
chrome.storage.local.get({ enabled: false }).then(({ enabled }) => { enabledInput.checked = enabled })
enabledInput.addEventListener('change', () => {
  chrome.storage.local.set({ enabled: enabledInput.checked })
  refresh()
})

async function askMeetTab(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab) throw new Error('no active tab')
  return chrome.tabs.sendMessage(tab.id, message)   // rejects if bridge.js isn't running in that tab
}

$('toggleDraw').addEventListener('click', () => askMeetTab({ type: 'vidjam-command', command: 'toggle-draw' }).catch(() => {}))
$('clear').addEventListener('click', () => askMeetTab({ type: 'vidjam-command', command: 'clear' }).catch(() => {}))

function setRow(id, text, tone) {
  const el = $(id)
  el.textContent = text
  el.className = tone || ''
}

function renderEvents(events) {
  const list = $('events')
  list.replaceChildren()
  if (!events.length) {
    const empty = document.createElement('li')
    empty.className = 'empty'
    empty.textContent = 'Nothing yet'
    list.append(empty)
    return
  }
  for (const event of events.slice().reverse()) {
    const item = document.createElement('li')
    const time = document.createElement('time')
    time.textContent = new Date(event.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    const text = document.createElement('span')
    text.textContent = event.message
    item.append(time, text)
    list.append(item)
  }
}

function renderNoTab(enabled) {
  setRow('tab', 'not found', 'warn')
  for (const id of ['pipelines', 'tracker', 'fps', 'draw']) setRow(id, '-')
  $('hint').textContent = enabled
    ? 'Open Google Meet in this tab. If it is already open, reload it once.'
    : 'Turn VidJam on, then open (or reload) a Meet tab.'
  $('toggleDraw').disabled = $('clear').disabled = true
  renderEvents([])
}

function render({ status, enabled }) {
  enabledInput.checked = enabled
  if (!status) return renderNoTab(enabled)

  $('version').textContent = 'v' + status.version
  setRow('tab', 'connected', 'ok')
  setRow('pipelines', String(status.pipelines), status.pipelines ? 'ok' : '')

  const trackerText = { idle: 'not started', loading: 'loading model…', ready: 'ready', failed: 'failed' }[status.tracker]
  const trackerTone = { idle: '', loading: 'warn', ready: 'ok', failed: 'bad' }[status.tracker]
  setRow('tracker', status.trackerError ? trackerText + ': ' + status.trackerError : trackerText, trackerTone)

  setRow('fps', status.tracker === 'ready' ? status.trackFps + ' fps' : '-')
  setRow('draw', status.drawMode ? 'ON' : 'off', status.drawMode ? 'ok' : '')

  $('hint').textContent = !enabled
    ? 'VidJam is off. Turn it on, then reload the Meet tab (applies when the camera next starts).'
    : status.pipelines
      ? 'Draw gestures: thumb above index = on, thumb below = off. Alt+D also toggles.'
      : 'On. Join or turn on your camera in Meet to start.'
  $('toggleDraw').disabled = $('clear').disabled = !status.pipelines
  renderEvents(status.events)
}

async function refresh() {
  try {
    render(await askMeetTab({ type: 'vidjam-status' }))
  } catch (err) {
    renderNoTab(enabledInput.checked)
  }
}

refresh()
setInterval(refresh, 700)
