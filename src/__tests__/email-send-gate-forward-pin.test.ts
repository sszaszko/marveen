import { describe, it, expect } from 'vitest'
import { copyFileSync, existsSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, pinnedDraftWriterRun } from '../../scripts/email-send-gate.mjs'

// LOCAL (owner decision 2026-11-23, Telegram 2951): scripts/gmail-tovabbitas.py builds a forward DRAFT to procurement@ /
// szaszko@ only. Its run names a recipient (--to), which the address rule reads as a send; the pin (path + SHA-256,
// one plain command) exempts exactly this file, like gmail-vazlat.py. The install-local file is absent upstream.
const ROOT = join(__dirname, '..', '..')
const FWD = join(ROOT, 'scripts', 'gmail-tovabbitas.py')

describe.skipIf(!existsSync(FWD))('pinned forward-draft writer', () => {
  const run = `${FWD} --fiok info --uzenet m1 --to procurement@agopen.shop --to szaszko@agopen.shop`
  const dec = (cmd: string, caller = 'expert', level = 3) =>
    gateDecision('Bash', { command: cmd }, null, ROOT, level, caller)

  it('the pinned script with --to passes, as a draft writer, at any level and for any caller', () => {
    expect(pinnedDraftWriterRun(run, ROOT)).toBe(true)
    expect(dec(run).deny).toBe(false)
    expect(dec(`${run} --tenyleg`).deny).toBe(false)
    expect(dec(run, 'coder', 2).deny).toBe(false)
  })
  it('a compound or substituted run is not the pinned run', () => {
    expect(dec(`${run}; echo x`).deny).toBe(true)
    expect(dec(`${run} --megjegyzes-fajl $(id)`).deny).toBe(true)
    expect(dec(`${run} | cat`).deny).toBe(true)
  })
  it('a copy of the script elsewhere is not pinned (the pin is the path next to the gate)', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fwd-pin-')))
    const copy = join(dir, 'gmail-tovabbitas.py')
    copyFileSync(FWD, copy)
    const cmd = `${copy} --fiok info --uzenet m1 --to procurement@agopen.shop`
    expect(pinnedDraftWriterRun(cmd, dir)).toBe(false)
    expect(gateDecision('Bash', { command: cmd }, null, dir, 3, 'expert').deny).toBe(true)
  })
})
