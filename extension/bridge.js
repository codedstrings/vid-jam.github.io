// Runs in the extension's isolated world and links three parties:
//   the page script (vidjam.js, page world), the popup, and chrome.storage.
// The page and this script share the DOM, so they talk through attributes on <html>:
//   data-vidjam-base     extension URL, for the page script to load the tracker frame
//   data-vidjam-enabled  "1" / "0", the popup's on/off switch
//   data-vidjam-status   JSON status published by the page script
//   data-vidjam-command  "<command>:<timestamp>", sent from the popup to the page script
const root = document.documentElement
root.dataset.vidjamBase = chrome.runtime.getURL("")

const setEnabled = (enabled) => { root.dataset.vidjamEnabled = enabled ? "1" : "0" }
chrome.storage.local.get({ enabled: false }).then(({ enabled }) => setEnabled(enabled))
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.enabled) setEnabled(changes.enabled.newValue)
})

// the popup asks for status and sends commands
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "vidjam-status") {
    let status = null
    try { status = JSON.parse(root.dataset.vidjamStatus || "null") } catch (err) { /* page script not ready yet */ }
    sendResponse({ status, enabled: root.dataset.vidjamEnabled === "1" })
  } else if (message.type === "vidjam-command") {
    root.dataset.vidjamCommand = message.command + ":" + Date.now()
    sendResponse({ ok: true })
  }
})
