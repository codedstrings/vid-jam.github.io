// VidJam for Meet: runs in the page's own JS world (see manifest.json), before Meet's code.
// Meet asks for the camera through navigator.mediaDevices.getUserMedia; we wrap it, draw on top of the real
// camera, and hand Meet a stream made from that canvas. Hand tracking runs in a hidden extension frame
// (tracker.html), never on Meet's main thread. Everything fails safe: on any error Meet gets the plain camera.
(function () {
  'use strict'

  // ===== Config =====
  const VERSION = '0.2.0'
  const MIRROR_OUTPUT = false     // meet already mirrors the camera, so we don't need to do it again
  const STROKE_COLOR = '#00ff00'
  const STROKE_WIDTH = 3
  const ERASE_SIZE = 50
  const OUTPUT_FPS = 30
  const TRACK_FPS = 20           // max frames per second sent to the tracker
  const TRACK_WIDTH = 320        // tracking frames are downscaled to this width
  const TRACKER_LOAD_TIMEOUT_MS = 45000
  const TRACKER_FRAME_TIMEOUT_MS = 2000

  const root = document.documentElement
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
  const extensionBase = () => root.dataset.vidjamBase || ''
  const isEnabled = () => root.dataset.vidjamEnabled === '1'


  // ===== Status for the popup (published on <html>, read by bridge.js) =====
  const status = {
    version: VERSION,
    pipelines: 0,
    tracker: 'idle',         // idle | loading | ready | failed
    trackerError: null,
    drawMode: false,
    trackFps: 0,
    events: []               // last few log lines, so problems are visible without opening the console
  }
  let publishTimer = null

  function publishStatus() {
    if (publishTimer) return
    publishTimer = setTimeout(() => {
      publishTimer = null
      status.pipelines = pipelines.size
      root.dataset.vidjamStatus = JSON.stringify(status)
    }, 400)
  }

  function logEvent(message, ...extra) {
    console.log('[VidJam]', message, ...extra)
    status.events.push({ time: Date.now(), message })
    if (status.events.length > 12) status.events.shift()
    publishStatus()
  }


  // ===== Tracker frame (MediaPipe lives in tracker.html) =====
  class TrackerClient {
    constructor() {
      this.nextId = 1
      this.pending = new Map()   // frame id -> resolve
      this.origin = new URL(extensionBase()).origin
      this.ready = new Promise((resolve, reject) => {
        this.resolveReady = resolve
        this.rejectReady = reject
      })
      this.ready.catch(() => {})   // failure is reported through status, not as an unhandled rejection

      this.iframe = document.createElement('iframe')
      this.iframe.src = extensionBase() + 'tracker.html'
      this.iframe.setAttribute('aria-hidden', 'true')
      this.iframe.style.cssText = 'position:fixed;left:-10px;top:-10px;width:1px;height:1px;border:0;opacity:0;pointer-events:none'
      window.addEventListener('message', (event) => this.onMessage(event))
      ;(document.body || root).appendChild(this.iframe)

      status.tracker = 'loading'
      logEvent('loading hand tracker')
      this.loadTimer = setTimeout(() => this.fail('timed out loading the hand tracker'), TRACKER_LOAD_TIMEOUT_MS)
    }

    fail(message) {
      clearTimeout(this.loadTimer)
      status.tracker = 'failed'
      status.trackerError = message
      logEvent('tracker failed: ' + message)
      this.rejectReady(new Error(message))
    }

    onMessage(event) {
      if (event.source !== this.iframe.contentWindow) return
      const message = event.data
      if (!message || message.vidjam !== 'tracker') return

      if (message.type === 'ready') {
        clearTimeout(this.loadTimer)
        status.tracker = 'ready'
        logEvent('hand tracker ready')
        this.resolveReady()
      } else if (message.type === 'error') {
        if (status.tracker === 'ready') logEvent('tracker error: ' + message.message)
        else this.fail(message.message)
      } else if (message.type === 'landmarks') {
        const resolve = this.pending.get(message.id)
        if (resolve) {
          this.pending.delete(message.id)
          resolve(message.landmarks)
        }
      }
    }

    // sends one frame (transferred, not copied) and resolves with landmarks, or null for "no hand"
    process(bitmap) {
      const id = this.nextId++
      return new Promise((resolve) => {
        this.pending.set(id, resolve)
        this.iframe.contentWindow.postMessage({ vidjam: 'frame', id, bitmap }, this.origin, [bitmap])
        setTimeout(() => {
          if (this.pending.delete(id)) resolve(null)   // tracker too slow or stuck: carry on without it
        }, TRACKER_FRAME_TIMEOUT_MS)
      })
    }
  }

  let tracker = null
  function getTracker() {
    if (!tracker) tracker = new TrackerClient()
    return tracker
  }


  // ===== Gestures (same rules as the web app) =====
  // landmark indices: 0 wrist, 2-4 thumb, 5-8 index, 12 middle tip, 16 ring tip, 20 pinky tip
  const sameColumn = (a, b) => a.x.toFixed(1) === b.x.toFixed(1)
  const isDrawOnGesture = (lm) => lm[4].y < lm[8].y - 0.05 && sameColumn(lm[4], lm[20]) && sameColumn(lm[4], lm[8]) && sameColumn(lm[5], lm[8]) && sameColumn(lm[2], lm[4])
  const isDrawOffGesture = (lm) => lm[4].y > lm[8].y + 0.05 && sameColumn(lm[4], lm[20]) && sameColumn(lm[4], lm[8]) && sameColumn(lm[5], lm[8]) && lm[5].y > lm[0].y
  const isPointing = (lm) => lm[8].y < lm[16].y - 0.1 && lm[3].y > lm[8].y
  const isClearGesture = (lm) => lm[20].y < lm[12].y - ((-lm[12].z * 0.833) + 0.05)


  // ===== One pipeline per camera stream =====
  const pipelines = new Set()
  // only the newest stream is tracked: Meet can open the camera more than once (lobby, then call)
  const trackingTarget = () => Array.from(pipelines).pop()

  class Pipeline {
    constructor(cameraTrack) {
      this.cameraTrack = cameraTrack
      this.stopped = false
      this.drawMode = false
      this.tip = null        // fingertip in output pixels, null when no hand
      this.prevTip = null

      this.video = document.createElement('video')   // raw camera: source of the picture and of the tracking frames
      this.video.muted = true
      this.video.playsInline = true
      this.video.srcObject = new MediaStream([cameraTrack])
      this.video.play().catch(err => logEvent('camera preview failed to start: ' + err))

      const { width = 640, height = 480 } = cameraTrack.getSettings()
      this.output = this.makeCanvas(width, height)    // composite that Meet will send
      this.strokes = this.makeCanvas(width, height)   // persistent drawing layer
      this.small = this.makeCanvas(TRACK_WIDTH, Math.round(TRACK_WIDTH * height / width))   // tracking frame
      this.outputCtx = this.output.getContext('2d')
      this.strokesCtx = this.strokes.getContext('2d')
      this.smallCtx = this.small.getContext('2d')
      this.outputStream = this.output.captureStream(OUTPUT_FPS)

      this.composite()
      this.trackLoop()
    }

    makeCanvas(width, height) {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      return canvas
    }

    stop() {
      if (this.stopped) return
      this.stopped = true
      clearTimeout(this.compositeTimer)
      this.cameraTrack.stop()          // releases the real camera
      this.video.srcObject = null
      pipelines.delete(this)
      logEvent('camera released')
    }

    setDrawMode(on) {
      this.drawMode = on
      status.drawMode = on
      publishStatus()
    }

    clearStrokes() {
      this.strokesCtx.clearRect(0, 0, this.strokes.width, this.strokes.height)
    }

    // composite camera + strokes + fingertip dot at a steady rate, independent of how fast tracking is
    composite() {
      if (this.stopped) return
      const { video, output, outputCtx: ctx } = this
      if (video.readyState >= 2 && video.videoWidth) {
        if (output.width !== video.videoWidth || output.height !== video.videoHeight) {
          for (const canvas of [this.output, this.strokes]) {
            canvas.width = video.videoWidth
            canvas.height = video.videoHeight
          }
          this.small.height = Math.round(TRACK_WIDTH * video.videoHeight / video.videoWidth)
        }
        ctx.save()
        if (MIRROR_OUTPUT) {
          ctx.translate(output.width, 0)
          ctx.scale(-1, 1)
        }
        ctx.drawImage(video, 0, 0, output.width, output.height)
        ctx.restore()
        ctx.drawImage(this.strokes, 0, 0)
        if (this.drawMode && this.tip) {
          ctx.beginPath()
          ctx.fillStyle = STROKE_COLOR
          ctx.arc(this.tip.x, this.tip.y, 9, 0, 2 * Math.PI)
          ctx.fill()
        }
      }
      this.compositeTimer = setTimeout(() => this.composite(), 1000 / OUTPUT_FPS)
    }

    // small, mirrored (if the output is) copy of the current camera frame, ready to transfer
    captureTrackingFrame() {
      const { small, smallCtx: ctx, video } = this
      ctx.save()
      if (MIRROR_OUTPUT) {
        ctx.translate(small.width, 0)
        ctx.scale(-1, 1)
      }
      ctx.drawImage(video, 0, 0, small.width, small.height)
      ctx.restore()
      return createImageBitmap(small)
    }

    // feed new camera frames to the tracker; Meet keeps getting video while the model is still loading
    async trackLoop() {
      try {
        await getTracker().ready
      } catch (err) {
        if (status.tracker === 'idle') {   // failed before the tracker even started (e.g. no extension URL)
          status.tracker = 'failed'
          status.trackerError = String(err)
          logEvent('tracker could not start: ' + err)
        }
        return
      }

      let lastFrameTime = -1
      let lastRun = 0
      let framesThisSecond = 0
      let secondStart = performance.now()

      while (!this.stopped) {
        const now = performance.now()
        const isTarget = trackingTarget() === this
        const due = now - lastRun >= 1000 / TRACK_FPS
        const hasNewFrame = this.video.readyState >= 2 && this.video.videoWidth && this.video.currentTime !== lastFrameTime

        if (isTarget && due && hasNewFrame) {
          lastRun = now
          lastFrameTime = this.video.currentTime
          try {
            const bitmap = await this.captureTrackingFrame()
            const landmarks = await getTracker().process(bitmap)
            if (!this.stopped) this.applyLandmarks(landmarks)
            framesThisSecond++
          } catch (err) {
            logEvent('tracking error: ' + err)
            await sleep(1000)
          }
        } else {
          await sleep(15)
        }

        if (now - secondStart >= 1000 && isTarget) {
          status.trackFps = framesThisSecond
          framesThisSecond = 0
          secondStart = now
          publishStatus()
        }
      }
    }

    // gesture logic: toggle draw mode, then draw / erase / clear on the strokes layer
    applyLandmarks(landmarks) {
      if (!landmarks) {
        this.tip = this.prevTip = null   // hand lost: don't connect the next stroke to the old position
        return
      }
      const { width, height } = this.output
      this.prevTip = this.tip
      this.tip = { x: landmarks[8].x * width, y: landmarks[8].y * height }

      if (isDrawOnGesture(landmarks)) this.setDrawMode(true)
      if (isDrawOffGesture(landmarks)) this.setDrawMode(false)
      if (!this.drawMode) return

      const ctx = this.strokesCtx
      if (isPointing(landmarks)) {
        if (landmarks[8].y > landmarks[12].y) {
          // index below middle finger: erase
          ctx.clearRect(this.tip.x - 20, this.tip.y - 20, ERASE_SIZE, ERASE_SIZE)
        } else if (this.prevTip) {
          ctx.beginPath()
          ctx.moveTo(this.prevTip.x, this.prevTip.y)
          ctx.strokeStyle = STROKE_COLOR
          ctx.lineWidth = STROKE_WIDTH
          ctx.lineTo(this.tip.x, this.tip.y)
          ctx.stroke()
        }
      }
      if (isClearGesture(landmarks)) this.clearStrokes()
    }
  }


  // ===== Wrap getUserMedia =====
  const mediaDevices = navigator.mediaDevices
  const originalGetUserMedia = mediaDevices.getUserMedia.bind(mediaDevices)

  mediaDevices.getUserMedia = async function (constraints) {
    const stream = await originalGetUserMedia(constraints)
    if (!constraints || !constraints.video || stream.getVideoTracks().length === 0) return stream
    if (!isEnabled()) {
      logEvent('VidJam is off: camera passed through untouched')
      return stream
    }
    try {
      return wrapStream(stream)
    } catch (err) {
      logEvent('falling back to the plain camera: ' + err)
      return stream
    }
  }

  function wrapStream(stream) {
    const pipeline = new Pipeline(stream.getVideoTracks()[0])
    pipelines.add(pipeline)

    // when Meet stops our track (camera off, device switch), also release the real camera
    const outputTrack = pipeline.outputStream.getVideoTracks()[0]
    const nativeStop = outputTrack.stop.bind(outputTrack)
    outputTrack.stop = () => {
      nativeStop()
      pipeline.stop()
    }

    logEvent('camera wrapped')
    return new MediaStream([outputTrack, ...stream.getAudioTracks()])
  }

  // never leave the camera on after the tab goes away
  window.addEventListener('pagehide', () => Array.from(pipelines).forEach(pipeline => pipeline.stop()))


  // ===== Controls: popup commands and Alt+D =====
  function toggleDrawing() {
    const target = trackingTarget()
    if (target) target.setDrawMode(!target.drawMode)
  }

  new MutationObserver(() => {
    const command = (root.dataset.vidjamCommand || '').split(':')[0]
    if (command === 'toggle-draw') toggleDrawing()
    if (command === 'clear') pipelines.forEach(pipeline => pipeline.clearStrokes())
  }).observe(root, { attributes: true, attributeFilter: ['data-vidjam-command'] })

  window.addEventListener('keydown', (event) => {
    if (event.altKey && event.code === 'KeyD') toggleDrawing()
  })

  logEvent('loaded v' + VERSION)
})()
