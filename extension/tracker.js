// Hidden extension page, loaded as an iframe inside Meet. It runs MediaPipe Hands here, in its own process,
// so inference can never block Meet's main thread. The page script (vidjam.js) sends in small camera
// frames and gets the 21 hand landmarks back.
//
// messages in : { vidjam: 'frame', id, bitmap }
// messages out: { vidjam: 'tracker', type: 'ready' | 'error' | 'landmarks', ... }
const parentWindow = window.parent
const send = (message) => parentWindow.postMessage({ vidjam: 'tracker', ...message }, 'https://meet.google.com')

const hands = new Hands({ locateFile: (file) => 'hands/' + file })
hands.setOptions({
  selfieMode: false,   // the page mirrors the frame itself, when it wants a mirrored picture
  maxNumHands: 1,
  modelComplexity: 1,
  minDetectionConfidence: 0.6,
  minTrackingConfidence: 0.6
})

let currentFrameId = null
hands.onResults((results) => {
  const landmarks = results.multiHandLandmarks && results.multiHandLandmarks[0]
  send({
    type: 'landmarks',
    id: currentFrameId,
    landmarks: landmarks ? landmarks.map(({ x, y, z }) => ({ x, y, z })) : null
  })
})

let ready = false
hands.initialize()
  .then(() => {
    ready = true
    send({ type: 'ready' })
  })
  .catch((err) => send({ type: 'error', message: String((err && err.message) || err) }))

window.addEventListener('message', async (event) => {
  if (event.source !== parentWindow) return
  const message = event.data
  if (!message || message.vidjam !== 'frame') return

  if (!ready) {
    send({ type: 'landmarks', id: message.id, landmarks: null })
    return
  }
  currentFrameId = message.id
  try {
    await hands.send({ image: message.bitmap })   // onResults above replies with the landmarks
  } catch (err) {
    send({ type: 'error', message: String((err && err.message) || err) })
    send({ type: 'landmarks', id: message.id, landmarks: null })
  } finally {
    message.bitmap.close()
  }
})
