# @chromatrix/web (placeholder)

Viewer/takeover SPA (React 19 + Vite + Tailwind v4). **Not built yet** — scaffolded during spike **S4**
(see `docs/PRD.md` §4, §7). Renders a tab via CDP `Page.startScreencast` (JPEG q~75, ack-throttled) and
injects human input via `Input.dispatch*` (produces `isTrusted` events), with a pause → live → resume
takeover handshake. Also the tool used to complete the one-time manual identity logins.
