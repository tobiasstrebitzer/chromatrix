# Spike S4 — live view + human takeover (the manual-login tool)

**Research question (docs/PRD.md §7, S4):** is CDP screencast + input-injection good enough to (a) let an
operator complete a one-time identity login by hand, and (b) take over a tab occasionally — without
disrupting a concurrent agent or leaking automation? This is a v1 requirement: it's how identities get
logged in, and it unblocks the decisive S2 target matrix.

## Approach

CDP `Page.startScreencast` (JPEG q75, ack-throttled) for the picture; `Input.dispatchMouseEvent` /
`Input.dispatchKeyEvent` for control — which produce **isTrusted** events (indistinguishable from a real
user, unlike JS-synthesized events). One screencast is fanned out to all connected viewers (no N× encode).
This is the same design Steel (`casting.handler.ts`) and Browserbase ship; WebRTC/neko is out of scope.

## Automated self-test (hard gate, no human needed)

```bash
pnpm s4:test    # from repo root — headless; verifies the mechanism
```

Checks: screencast frames flow; an injected mouse click fires the page handler with `isTrusted === true`;
injected keyboard types into a focused input.

## Interactive viewer (the actual login tool)

```bash
pnpm s4                                          # opens https://example.com (ephemeral profile)
START_URL=https://www.linkedin.com/login \
  PROFILE_DIR=./.profiles/linkedin  pnpm s4      # persistent profile — the login STICKS
```

Then open the printed `http://127.0.0.1:<port>` in your browser and drive the tab: click and type directly
on the frame. Use a **throwaway account first**. With `PROFILE_DIR` set, the resulting `userDataDir` is a
persistent identity profile chromatrix can reuse (one long-lived Chrome per identity — docs/PRD.md §4).

## Notes / limitations (turn-1 scope)

- Coordinate mapping is normalized [0..1] → CSS-px via the frame's `deviceWidth/Height` metadata (no
  `Emulation.setDeviceMetricsOverride`, which the research flags as a stealth-sensitive domain).
- Key mapping covers printable chars + Enter/Tab/Backspace/arrows/Escape — enough for logins; not a full
  keymap (no IME/composition, limited modifiers).
- "pause → live → resume" agent-handoff isn't exercised here (no agent is running during a login). It's a
  gateway concern for when takeover coexists with automation; the primitives (attach a second session,
  screencast, inject) are proven here.
- Screencast is repaint-driven: idle pages send ~0 fps (expected). Fine for login-grade interaction.
