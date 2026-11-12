import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error -- plain .mjs hook script, no types
import { pinnedShellMeta, pinnedSenderRun, gateDecision } from '../../scripts/email-send-gate.mjs'

// LOCAL (marveen 5505, ops-finance 5504, 2026-11-12): the pinned-run shell check reads the quote state the way bash
// does. A quoted "(Q3 2026)" in a draft subject is a literal word; the raw-string test refused it and the draft
// writer was judged a sender. The same pass closes two holes of the raw test: an unquoted # (a comment that hides
// --cimzett-ledger from bash but not from the gate) and an unquoted glob (it can expand into an unseen --fiok=...).

describe('pinnedShellMeta: shell syntax with the quote state', () => {
  it('lets literal punctuation through inside quotes', () => {
    for (const cmd of [
      'x --targy "Ajanlat (Q3 2026)"',
      "x --targy 'Ajanlat (Q3 2026)'",
      "x --targy 'a; b & c | d > e < f {g} $(h) `i` \\j # k * ? ['",
      'x --targy "a; b & c | d > e < f {g} # k * ? ["',
      'x --targy "Re: ajanlat" --to a@b.hu',
      'x --targy Ajanlat',
    ]) expect(pinnedShellMeta(cmd), cmd).toBe(false)
  })
  it('refuses what bash would act on', () => {
    for (const cmd of [
      'x --targy Ajanlat (Q3)',            // unquoted subshell syntax
      'x --targy "a $(id)"',              // substitution inside double quotes
      'x --targy "a `id`"',
      'x --targy "a \\" b"',              // escape inside double quotes
      'x --targy "a ${HOME}"',
      'x a; id',
      'x a && id',
      'x a | id',
      'x a > f',
      'x a\nid',
      "x 'a\nb'",                          // a newline anywhere
      'x --id r1 # --cimzett-ledger',     // a comment hides the rest of the line from bash
      'x --id r1 * ',                     // globs
      'x --id r? ',
      'x --id r[1]',
      'x --targy "unclosed',
      "x --targy 'unclosed",
    ]) expect(pinnedShellMeta(cmd), JSON.stringify(cmd)).toBe(true)
  })
})

describe('gateDecision: pinned runs with quoted punctuation', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pinned-quote-')))
  const script = join(dir, 'gmail-kuldes.py')
  writeFileSync(script, 'print("fake sender")\n')
  const pins = new Map([[script, createHash('sha256').update(readFileSync(script)).digest('hex')]])
  const d = (cmd: string) => gateDecision('Bash', { command: cmd }, null, dir, 3, 'ops-finance', pins)

  it('the sender with a # before --cimzett-ledger, or a glob, is not the pinned run any more', () => {
    // (the fake carries no send code, so the later send detection has nothing to see; the point measured here is
    // that the pinned opening no longer fires -- the real sender is judged a send by the script judge)
    expect(pinnedSenderRun(`${script} --fiok szaszko --id r1 --cimzett-ledger`, dir, pins)).toBe(true)
    expect(pinnedSenderRun(`${script} --fiok szaszko --id r1 # --cimzett-ledger`, dir, pins)).toBe(false)
    expect(pinnedSenderRun(`${script} --fiok szaszko --id r1 --cimzett-ledger *`, dir, pins)).toBe(false)
  })
  it('a quoted id or account word stays one literal word', () => {
    expect(d(`${script} --fiok 'szaszko' --id "r1" --cimzett-ledger`).deny).toBe(false)
  })
})

// With the install-local real files (absent upstream): the draft writer with a quoted parenthesis in the subject is
// exempt again, and the real sender with a hidden ledger flag is refused.
const ROOT = join(__dirname, '..', '..')
const REAL_DRAFT = join(ROOT, 'scripts', 'gmail-vazlat.py')
const REAL_SENDER = join(ROOT, 'scripts', 'gmail-kuldes.py')
describe.skipIf(!existsSync(REAL_DRAFT) || !existsSync(REAL_SENDER))('real pinned scripts', () => {
  const base = `${REAL_DRAFT} --fiok procurement --to a@b.hu --torzs /tmp/x.txt --targy`
  const dec = (cmd: string) => gateDecision('Bash', { command: cmd }, () => true, ROOT, 3, 'ops-finance')
  it('a quoted ( ) in the draft subject passes, the dangerous forms do not', () => {
    expect(dec(`${base} "Ajanlat (Q3 2026)"`).deny).toBe(false)
    expect(dec(`${base} 'Ajanlat (Q3 2026)'`).deny).toBe(false)
    expect(dec(`${base} "Ajanlat $(id)"`).deny).toBe(true)
    expect(dec(`${base} Ajanlat (Q3)`).deny).toBe(true)
  })
  it('the real sender with # before --cimzett-ledger is refused', () => {
    expect(dec(`${REAL_SENDER} --fiok szaszko --id r1 --cimzett-ledger`).deny).toBe(false)
    expect(dec(`${REAL_SENDER} --fiok szaszko --id r1 # --cimzett-ledger`).deny).toBe(true)
  })
})
