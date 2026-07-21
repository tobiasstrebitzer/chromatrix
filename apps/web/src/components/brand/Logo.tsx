import * as React from 'react'
import { useIsBusy } from '@/lib/activity'
import { cn } from '@/lib/utils'

/**
 * The chromatrix logo: a 3×3 grid with the leading diagonal lit - the identity matrix.
 *
 * Driven by a single requestAnimationFrame controller rather than CSS animations. CSS could express each mode
 * on its own, but not the moves *between* them: switching `animation-name` snaps the element to the new
 * animation's start value, which is exactly the hard cut we want to avoid. Here every mode is a continuous
 * target that the loop eases toward, so default → activity → hover blend in any order and at any moment.
 *
 * The one thing that is NOT eased is position. Cell positions are read straight off the ring path, and it is
 * the *phase* along that path that is smoothed. That distinction is load-bearing: easing a position toward a
 * moving target would cut corners diagonally, whereas advancing a phase along a path whose segments are each
 * axis-aligned can only ever produce horizontal or vertical movement.
 */

/** 3 columns on a 9px pitch with 6px cells fills the 24px box edge-to-edge. */
const CELL = 6
const PITCH = 9

/**
 * The outer ring, clockwise, as [x, y]. Order is load-bearing: consecutive entries differ on exactly one
 * axis, which is what makes every interpolated point on this path axis-aligned.
 */
const RING: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [PITCH, 0],
  [PITCH * 2, 0],
  [PITCH * 2, PITCH],
  [PITCH * 2, PITCH * 2],
  [PITCH, PITCH * 2],
  [0, PITCH * 2],
  [0, PITCH],
]

const CENTRE: readonly [number, number] = [PITCH, PITCH]

/** Seconds for one full revolution. */
const ORBIT_SECONDS = 2.4
/** Seconds for one shimmer cycle. */
const SHIMMER_SECONDS = 3.2
/** Exponential-smoothing time constants (seconds). Smaller = snappier. */
const TAU_SPIN = 0.35
const TAU_HOVER = 0.16
/** Slow, so the activity tint drifts rather than blinks. */
const TAU_TINT = 0.55
const HOVER_SCALE = 1.15

/**
 * Activity mode tints only *some* cells green at a time, at partial strength - the movement is the signal and
 * a fully green grid would read as a status colour rather than as motion. Each cell re-rolls its own target
 * on its own schedule, so the greens wander instead of pulsing together.
 */
const ACTIVITY_TINT_MAX = 0.5
/** Odds a re-roll picks "no tint", i.e. the cell drifts back to plain grey/white. */
const TINT_OFF_CHANCE = 0.5
const TINT_HOLD_MIN = 0.6
const TINT_HOLD_JITTER = 1.4

/**
 * Hover keeps re-rolling each cell's colour for as long as the pointer is over it, so the flare is alive
 * rather than a single frozen state. Faster cadence and a snappier ease than the activity tint - hover is a
 * direct response to the user, so it should feel eager.
 */
const HOVER_ROLL_MIN = 0.35
const HOVER_ROLL_JITTER = 0.75
const TAU_HOVER_COLOR = 0.25
/** Mid greys that read against both a near-black and a near-white panel. */
const HOVER_GREYS: Rgb[] = [
  [143, 143, 143],
  [176, 176, 176],
]
/** Shimmer is damped during activity but not switched off - the grey↔white breathing is what green plays against. */
const SHIMMER_ACTIVITY_DAMP = 0.4

/**
 * Hover flare: a single green hue at three depths, indexed by grid position. One hue rather than a spectrum
 * keeps this a brand accent instead of a rainbow, and the diagonal takes the brightest stop so the
 * identity-matrix reading survives even at full bloom.
 *
 * Local rather than a design token on purpose: the system is achromatic ("colour is information"), and
 * promoting these to tokens.css would invite them into the UI proper.
 */
const FLARE = [
  '#4ade80', // 0 · diagonal
  '#22c55e',
  '#16a34a',
  '#22c55e',
  '#4ade80', // 4 · diagonal (centre)
  '#22c55e',
  '#16a34a',
  '#22c55e',
  '#4ade80', // 8 · diagonal
]

/** On the diagonal a cell is dominant, off it recessive. Shimmer moves within a band, never across. */
const BAND = {
  diagonal: { base: 0.85, peak: 1 },
  offDiagonal: { base: 0.2, peak: 0.34 },
} as const

type Rgb = [number, number, number]

/** The distinct greens in FLARE, as rgb - the pool a hover re-roll can draw an "other green" from. */
const FLARE_RGB: Rgb[] = [
  [74, 222, 128],
  [34, 197, 94],
  [22, 163, 74],
]

function hexToRgb(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function parseRgb(value: string): Rgb {
  const m = value.match(/-?\d+(\.\d+)?/g)
  return m ? [Number(m[0]), Number(m[1]), Number(m[2])] : [255, 255, 255]
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t

const lerpRgb = (a: Rgb, b: Rgb, t: number): Rgb => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]

/**
 * One draw from the hover palette. Weighted toward green so the flare still reads as green overall, but
 * mixed with the theme's own foreground (white on dark, near-black on light) and mid greys so the grid
 * shifts rather than turning uniformly green.
 */
function pickHoverColor(cellGreen: Rgb, restColor: Rgb): Rgb {
  const r = Math.random()
  if (r < 0.4) return cellGreen
  if (r < 0.55) return FLARE_RGB[Math.floor(Math.random() * FLARE_RGB.length)]!
  if (r < 0.8) return restColor
  return HOVER_GREYS[Math.floor(Math.random() * HOVER_GREYS.length)]!
}

/** Frame-rate independent exponential smoothing. */
const approach = (current: number, target: number, tau: number, dt: number) =>
  current + (target - current) * (1 - Math.exp(-dt / tau))

/** A point on the ring path. `u` is in revolutions; each 1/8 segment is axis-aligned, so this always is too. */
function ringPoint(u: number): readonly [number, number] {
  const wrapped = ((u % 1) + 1) % 1
  const scaled = wrapped * RING.length
  const i = Math.floor(scaled)
  const t = scaled - i
  const from = RING[i]!
  const to = RING[(i + 1) % RING.length]!
  return [lerp(from[0], to[0], t), lerp(from[1], to[1], t)]
}

interface Cell {
  ring?: number
  base: readonly [number, number]
  diagonal: boolean
  flare: Rgb
  shimmerPhase: number
}

const GRID_CELLS = 9

const CELLS: Cell[] = [
  ...RING.map((base, ring) => ({ base, ring: ring as number | undefined })),
  { base: CENTRE, ring: undefined },
].map(({ base, ring }) => {
  // Index by grid position, so flare hue and shimmer offset are stable per cell rather than per render order.
  const index = (base[1] / PITCH) * 3 + base[0] / PITCH
  return {
    ring,
    base,
    diagonal: base[0] === base[1],
    flare: hexToRgb(FLARE[index]!),
    // Stagger so the grid breathes unevenly; a synchronised pulse reads as a blink.
    shimmerPhase: index / GRID_CELLS,
  }
})

interface LogoProps {
  size?: number
  className?: string
  title?: string
  /** Force activity mode. Defaults to the global in-flight signal (see lib/activity). */
  activity?: boolean
  /** Disable the hover flare - for decorative placements where the logo isn't a target. */
  interactive?: boolean
}

export function Logo({ size = 16, className, title = 'chromatrix', activity, interactive = true }: LogoProps) {
  const busy = useIsBusy()
  const active = activity ?? busy

  const svgRef = React.useRef<SVGSVGElement>(null)
  const rectRefs = React.useRef<Array<SVGRectElement | null>>([])

  // Mode lives in refs, not state: the animation loop reads it every frame and must not be torn down and
  // rebuilt (losing its phase) every time a mode flips.
  const wantSpin = React.useRef(false)
  const wantHover = React.useRef(false)
  wantSpin.current = active

  React.useEffect(() => {
    const svg = svgRef.current
    if (!svg) return

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    let raf = 0
    let last = performance.now()
    let phase = 0
    let spin = 0
    /** Where the orbit is allowed to stop. See the comment at `landing` below. */
    let landing: number | null = null
    let hover = 0
    let restColor = parseRgb(getComputedStyle(svg).color)
    let colorCheck = 0
    // Per-instance, so two logos on the page drift independently rather than in lockstep.
    const tints = CELLS.map((cell) => ({
      value: 0,
      target: 0,
      nextRoll: 0,
      // Hover colour starts at rest so the first blend has nowhere jarring to come from.
      hoverColor: [...restColor] as Rgb,
      hoverTarget: [...cell.flare] as Rgb,
      hoverRoll: 0,
    }))

    const frame = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05) // clamp: a backgrounded tab must not fast-forward
      last = now

      const spinTarget = wantSpin.current ? 1 : 0
      const hoverTarget = wantHover.current && interactive ? 1 : 0

      if (reduced) {
        spin = spinTarget
        hover = hoverTarget
      } else {
        hover = approach(hover, hoverTarget, TAU_HOVER, dt)
        spin = approach(spin, spinTarget, TAU_SPIN, dt)
      }

      /**
       * Landing. When activity ends, the orbit can't just stop - cells would freeze mid-segment, off the
       * grid. It runs on to the next half revolution instead: the two bright diagonal cells sit opposite
       * each other, so half a turn puts the grid back in a visually identical arrangement, and the
       * off-diagonal cells merely permute among themselves. That bounds the wind-down at ~1.2s instead of
       * the full 2.4s a whole revolution would need.
       */
      if (!wantSpin.current && landing === null && spin > 0.001) {
        landing = Math.ceil(phase * 2 + 0.001) / 2
      }
      if (wantSpin.current) landing = null

      if (!reduced) {
        if (landing !== null) {
          phase = approach(phase, landing, TAU_SPIN, dt)
          if (Math.abs(landing - phase) < 0.0005) {
            phase = landing % 1
            landing = null
            spin = 0
          }
        } else if (spin > 0.001) {
          phase += (dt / ORBIT_SECONDS) * spin
        }
      }

      // The rest colour is inherited (currentColor), so it changes with the theme. Re-read it about twice a
      // second rather than every frame - it's a style read, and nothing here changes that fast.
      colorCheck += dt
      if (colorCheck > 0.5) {
        colorCheck = 0
        restColor = parseRgb(getComputedStyle(svg).color)
      }

      const t = now / 1000
      for (let i = 0; i < CELLS.length; i++) {
        const cell = CELLS[i]!
        const node = rectRefs.current[i]
        if (!node) continue

        // Position: exact point on the ring path - never eased, so never diagonal.
        const [x, y] =
          cell.ring === undefined ? cell.base : ringPoint(cell.ring / RING.length + (reduced ? 0 : phase))

        const band = cell.diagonal ? BAND.diagonal : BAND.offDiagonal
        // Shimmer is damped while spinning, not silenced: the grey↔white breathing is what the green tint
        // reads against, and killing it would leave activity looking flat.
        const wave = reduced
          ? 0
          : (0.5 + 0.5 * Math.sin(2 * Math.PI * (t / SHIMMER_SECONDS + cell.shimmerPhase))) *
            (1 - SHIMMER_ACTIVITY_DAMP * spin)
        const opacity = lerp(band.base + (band.peak - band.base) * wave, 1, hover)

        // Activity tint: each cell drifts toward its own randomly re-rolled target, so only some are green at
        // any moment. Scaled by `spin`, so it fades in with the orbit and back out when it lands.
        const tint = tints[i]!
        if (!reduced) {
          if (t >= tint.nextRoll) {
            tint.target = Math.random() < TINT_OFF_CHANCE ? 0 : 0.35 + Math.random() * 0.65
            tint.nextRoll = t + TINT_HOLD_MIN + Math.random() * TINT_HOLD_JITTER
          }
          tint.value = approach(tint.value, tint.target, TAU_TINT, dt)
        }
        // Activity tint sits underneath; hover blends over the top of whatever that produced.
        const activityColor = lerpRgb(restColor, cell.flare, spin * tint.value * ACTIVITY_TINT_MAX)

        // While hovered, each cell keeps re-rolling its own colour target on its own clock, so the flare
        // shifts between greens, the theme foreground and greys instead of freezing on one green.
        if (hover > 0.01 && !reduced) {
          if (t >= tint.hoverRoll) {
            tint.hoverTarget = pickHoverColor(cell.flare, restColor)
            tint.hoverRoll = t + HOVER_ROLL_MIN + Math.random() * HOVER_ROLL_JITTER
          }
          tint.hoverColor = lerpRgb(tint.hoverColor, tint.hoverTarget, 1 - Math.exp(-dt / TAU_HOVER_COLOR))
        } else if (hover <= 0.01) {
          // Reset while idle so the next hover opens from rest rather than from the last colour it held.
          tint.hoverColor = [...restColor] as Rgb
          tint.hoverRoll = 0
        }

        const blended = lerpRgb(activityColor, tint.hoverColor, hover)
        const fill: Rgb = [Math.round(blended[0]), Math.round(blended[1]), Math.round(blended[2])]

        node.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)`
        node.style.opacity = opacity.toFixed(3)
        node.style.fill = `rgb(${fill[0]}, ${fill[1]}, ${fill[2]})`
      }

      svg.style.transform = `scale(${lerp(1, HOVER_SCALE, hover).toFixed(4)})`
      raf = requestAnimationFrame(frame)
    }

    // Native listeners rather than React's onPointerEnter/Leave: those are synthesised from delegated
    // pointerover/out at the root, and this component already drives everything imperatively anyway.
    const enter = () => {
      wantHover.current = true
    }
    const leave = () => {
      wantHover.current = false
    }
    svg.addEventListener('pointerenter', enter)
    svg.addEventListener('pointerleave', leave)

    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      svg.removeEventListener('pointerenter', enter)
      svg.removeEventListener('pointerleave', leave)
    }
  }, [interactive])

  return (
    <svg
      width={size}
      height={size}
      viewBox='0 0 24 24'
      fill='none'
      role='img'
      aria-label={title}
      ref={svgRef}
      className={cn('shrink-0 select-none', className)}
      xmlns='http://www.w3.org/2000/svg'>
      {CELLS.map((cell, i) => (
        <rect
          key={`${cell.base[0]}-${cell.base[1]}`}
          ref={(node) => {
            rectRefs.current[i] = node
          }}
          width={CELL}
          height={CELL}
          rx='1.5'
          fill='currentColor'
          // Static fallback so the mark is correct before the first frame (and if JS never runs).
          style={{ transform: `translate(${cell.base[0]}px, ${cell.base[1]}px)`, opacity: cell.diagonal ? 1 : 0.28 }}
        />
      ))}
    </svg>
  )
}
