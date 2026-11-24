// Scrolling-sheet VexFlow palette — Theme → CSS paint for every VexFlow path.
//
// The canvas SheetView reads cream ink on dark stages and dark-slate ink on
// the paper stage (see SheetView.setTheme); this maps the same ink onto the
// VexFlow scrolling sheet so both staves agree. Pending / wait-mode targets
// read in the app accent. Total over Theme: every key is always defined.

import { accentCSS, hexToCSS, isLightTheme, type Theme } from '../renderer/theme'

// Cream noteheads on dark stages; dark-slate ink on the paper stage.
const NOTE_DARK = '#f0e6d2'
const NOTE_LIGHT = '#2b2f3a'
// Staff furniture: brighter warm parchment on dark (1.5px lines need the
// extra lift against the stage), slate on paper.
const STAFF_DARK = '#ece2cc'
const STAFF_LIGHT = '#333a47'
// Rests sit one step back from note ink so pitched heads lead (Simply-style).
const REST_DARK = '#9d927c'
const REST_LIGHT = '#8a8fa0'
// Secondary glyphs (clefs, annotations, fingerings): muted by one step.
const TEXT_DARK = '#c8c0a8'
const TEXT_LIGHT = '#6b7280'

export interface VexSheetStyle {
  // StaveNote / GraceNote setStyle fill — noteheads.
  readonly noteFill: string
  // StaveNote / GraceNote setStyle stroke — stems, flags, beams, dots,
  // accidentals, and notehead outlines.
  readonly noteStroke: string
  // Rest glyphs (GhostNote / rest StaveNotes) fill — muted one step back so
  // pitched noteheads lead.
  readonly restFill: string
  // Stave horizontal lines.
  readonly staffLine: string
  // BarNote glyphs, stave end caps, and bar connectors.
  readonly barLine: string
  // Ledger-line strokes above / below the staves — same ink as staff lines.
  readonly ledgerLine: string
  // TextNote / Annotation fill alongside the app font stack at the call site.
  readonly textFont: string
  // Pending-chord and wait-mode target fill, in the app accent.
  readonly pendingFill: string
  // Pending-chord and wait-mode target stroke (stems, ledgers), same accent.
  readonly pendingStroke: string
}

export function vexSheetStyle(theme: Theme): VexSheetStyle {
  const light = isLightTheme(theme)
  const note = light ? NOTE_LIGHT : NOTE_DARK
  // Light stages pin the grid explicitly (gridColor); otherwise fall back to
  // the parchment / slate staff ink so bar joints never clash with the lines.
  const staff =
    theme.gridColor === undefined ? (light ? STAFF_LIGHT : STAFF_DARK) : hexToCSS(theme.gridColor)
  const pending = accentCSS(theme)
  return {
    noteFill: note,
    noteStroke: note,
    restFill: light ? REST_LIGHT : REST_DARK,
    staffLine: staff,
    barLine: staff,
    ledgerLine: staff,
    textFont: light ? TEXT_LIGHT : TEXT_DARK,
    pendingFill: pending,
    pendingStroke: pending,
  }
}
