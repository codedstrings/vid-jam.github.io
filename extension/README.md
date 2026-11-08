# VidJam for Meet (extension, work in progress)

Draw on your own video in Google Meet with hand gestures. Everyone in the call sees the drawing, because it is part of the video your camera sends. The extension does not use PeerJS or any server: Meet carries the video.

## Try it

1. Open `chrome://extensions` (or `edge://extensions`), turn on **Developer mode**, click **Load unpacked** and pick this `extension/` folder.
2. Click the VidJam toolbar icon and switch it **on** (it starts off). The switch applies the next time Meet opens the camera, so reload the Meet tab if it is already open.
3. Join a call. The popup shows what is going on: tracker state, camera streams, tracking rate, drawing on/off and the last few events.
4. Gestures are the web app's: thumb above index = draw on, thumb below = off, index up = draw, index below middle finger = erase, pinky up = clear. `Alt+D` or the popup button toggles drawing by hand.

If anything misbehaves, switch VidJam off in the popup and reload the Meet tab. After editing files here, click the reload icon on the extension's card and reload Meet.

## How it works

```
Meet page (page world)                           hidden extension iframe (own process)
-----------------------                          -------------------------------------
vidjam.js wraps getUserMedia
  camera -> <video> -> canvas  (+ strokes)  --> sent to Meet as the camera stream
  small mirrored frame (ImageBitmap) ---------> tracker.js: MediaPipe Hands
  gestures -> draw / erase / clear  <---------- 21 landmarks back
```

| File | Role |
| --- | --- |
| `vidjam.js` | Page world, at `document_start`. Wraps `getUserMedia`, composites camera + strokes, applies gestures, publishes status. |
| `tracker.html`, `tracker.js` | Extension page loaded as a hidden iframe. Runs MediaPipe, so inference never blocks Meet's main thread. |
| `bridge.js` | Isolated world. Links the page script, the popup and `chrome.storage` through attributes on `<html>`. |
| `popup.*` | Toolbar popup: on/off switch, live status, manual controls. |
| `hands/` | Copy of the web app's MediaPipe files. |

Design choices:
- **Tracking is out-of-page.** The first version ran MediaPipe inside Meet's page and froze the tab. Now only a small downscaled frame (320 px wide, up to 20 per second) crosses to the tracker.
- **One tracked stream.** Meet can open the camera more than once (lobby, then call); only the newest stream is tracked.
- **Fails safe.** If anything goes wrong Meet gets the plain camera. The real camera is released when Meet stops the track and when the tab closes.
- **Off by default.** Nothing touches the camera until you switch it on.

## Not verified yet / known limits

- The hidden-iframe design has not been run in a real call yet. If the tracker shows `failed` in the popup, its message says why.
- `MIRROR_OUTPUT` (top of `vidjam.js`) decides whether others see a mirrored picture. Mirrored makes drawn text readable to them, but Meet's own self-view mirrors again, so your preview looks un-mirrored.
- The compositing loop uses timers, so Chrome may throttle it in a background tab. Insertable Streams would be the sturdier fix if the picture freezes when the tab is hidden.
- Gestures are copied from the web app and will be replaced later (pinch to draw). The drawing color is fixed to green.
