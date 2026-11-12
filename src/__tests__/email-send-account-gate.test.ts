import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, senderAccount, callerAgent, sendAccountAllowed, buildSendAccountMsg, SEND_ACCOUNTS } from '../../scripts/email-send-gate.mjs'

// LOCAL (owner decision 2026-11-12, Telegram 2555): the send right is per agent and per account.
// ops-finance: szaszko + procurement; zara: info; every other sub-agent: draft only.

// A stand-in for the pinned scripts/gmail-kuldes.py: same pin mechanism (real path + sha256), own temp file.
function fakePinnedSender() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'send-account-')))
  const script = join(dir, 'gmail-kuldes.py')
  writeFileSync(script, '#!/usr/bin/env python3\nprint("fake sender")\n')
  const sha = createHash('sha256').update(readFileSync(script)).digest('hex')
  return { dir, script, pins: new Map([[script, sha]]) }
}

const LEVEL3 = 3

describe('senderAccount: exactly one readable --fiok', () => {
  const t = (...a: string[]) => ['/x/gmail-kuldes.py', ...a]
  it('reads --fiok <name> and --fiok=<name>', () => {
    expect(senderAccount(t('--fiok', 'info', '--id', 'r1', '--cimzett-ledger'))).toBe('info')
    expect(senderAccount(t('--id', 'r1', '--fiok=szaszko', '--cimzett-ledger'))).toBe('szaszko')
  })
  it('refuses what argparse would read differently from a naive reader', () => {
    // abbreviations argparse accepts
    expect(senderAccount(t('--fio', 'info', '--id', 'r1'))).toBeNull()
    expect(senderAccount(t('--fi', 'info'))).toBeNull()
    expect(senderAccount(t('--f=info'))).toBeNull()
    // repeated: argparse takes the LAST one
    expect(senderAccount(t('--fiok', 'info', '--fiok', 'szaszko'))).toBeNull()
    expect(senderAccount(t('--fiok', 'info', '--fio', 'szaszko'))).toBeNull()
    // missing, empty, option-shaped value, after --
    expect(senderAccount(t('--id', 'r1'))).toBeNull()
    expect(senderAccount(t('--fiok'))).toBeNull()
    expect(senderAccount(t('--fiok='))).toBeNull()
    expect(senderAccount(t('--fiok', '--id'))).toBeNull()
    expect(senderAccount(t('--', '--fiok', 'info'))).toBeNull()
  })
})

describe('callerAgent: identity from transcript_path, never from cwd', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'install-')))
  for (const a of ['ops-finance', 'zara', 'coder']) mkdirSync(join(root, 'agents', a, '.claude-config', 'projects'), { recursive: true })
  const tp = (a: string) => join(root, 'agents', a, '.claude-config', 'projects', `-x-agents-${a}`, 's.jsonl')
  const opts = (env: Record<string, string> = {}) => ({ root, env })

  it('names the agent whose config dir holds the transcript', () => {
    expect(callerAgent({ transcript_path: tp('ops-finance') }, opts())).toBe('ops-finance')
    expect(callerAgent({ transcript_path: tp('zara') }, opts())).toBe('zara')
  })
  it('ignores the cwd: a coder session that cd-d into agents/ops-finance stays coder', () => {
    expect(callerAgent({ transcript_path: tp('coder'), cwd: join(root, 'agents', 'ops-finance') }, opts())).toBe('coder')
    expect(callerAgent({ cwd: join(root, 'agents', 'ops-finance') }, opts())).toBeNull()
  })
  it('is null for a transcript outside <install>/agents, a non-agent dir, or a missing path', () => {
    expect(callerAgent({ transcript_path: join(root, '.channels-config', 'projects', 'p', 's.jsonl') }, opts())).toBeNull()
    expect(callerAgent({ transcript_path: '/home/someone/.claude/projects/p/s.jsonl' }, opts())).toBeNull()
    expect(callerAgent({ transcript_path: join(root, 'agents', 'ghost', 'x.jsonl') }, opts())).toBeNull()
    expect(callerAgent({ transcript_path: join(root, 'agents', '..', 'agents', 'zara', 'x') }, opts())).toBe('zara')
    expect(callerAgent({ transcript_path: join(root, 'agents', 'zara', '..', '..', 'outside', 'x') }, opts())).toBeNull()
    expect(callerAgent({}, opts())).toBeNull()
    expect(callerAgent(null, opts())).toBeNull()
  })
  it('is null when the hook env CLAUDE_CONFIG_DIR names another agent (contradictory identity)', () => {
    const zaraCfg = join(root, 'agents', 'zara', '.claude-config')
    expect(callerAgent({ transcript_path: tp('zara') }, opts({ CLAUDE_CONFIG_DIR: zaraCfg }))).toBe('zara')
    expect(callerAgent({ transcript_path: tp('coder') }, opts({ CLAUDE_CONFIG_DIR: zaraCfg }))).toBeNull()
    expect(callerAgent({ transcript_path: tp('zara') }, opts({ CLAUDE_CONFIG_DIR: join(root, '.channels-config') }))).toBeNull()
  })
  it('accepts the install reached through a symlink', () => {
    const link = join(realpathSync(mkdtempSync(join(tmpdir(), 'link-'))), 'inst')
    symlinkSync(root, link)
    const viaLink = join(link, 'agents', 'zara', '.claude-config', 'projects', 'p', 's.jsonl')
    expect(callerAgent({ transcript_path: viaLink }, { root: link, env: {} })).toBe('zara')
    expect(callerAgent({ transcript_path: tp('zara') }, { root: link, env: {} })).toBe('zara')
  })
})

describe('sendAccountAllowed: the owner table', () => {
  it('matches the 2026-11-12 decision exactly', () => {
    expect(SEND_ACCOUNTS).toEqual({ 'ops-finance': ['procurement', 'szaszko'], zara: ['info'] })
    expect(sendAccountAllowed('ops-finance', 'szaszko')).toBe(true)
    expect(sendAccountAllowed('ops-finance', 'procurement')).toBe(true)
    expect(sendAccountAllowed('ops-finance', 'info')).toBe(false)
    expect(sendAccountAllowed('zara', 'info')).toBe(true)
    expect(sendAccountAllowed('zara', 'szaszko')).toBe(false)
    for (const a of ['coder', 'iris', 'uj-ugynok', null, '', 'constructor', '__proto__']) {
      for (const f of ['info', 'procurement', 'szaszko']) expect(sendAccountAllowed(a, f), `${a}/${f}`).toBe(false)
    }
  })
})

describe('gateDecision: the pinned sender at level 3 goes only from a held account', () => {
  const { dir, script, pins } = fakePinnedSender()
  const run = (args: string) => `${script} ${args}`
  const decide = (cmd: string, caller: string | null, level = LEVEL3) =>
    gateDecision('Bash', { command: cmd }, null, dir, level, caller, pins)

  it('lets ops-finance send from szaszko and procurement, zara from info', () => {
    expect(decide(run('--fiok szaszko --id r1 --cimzett-ledger'), 'ops-finance').deny).toBe(false)
    expect(decide(run('--fiok procurement --id r1 --cimzett-ledger --proba'), 'ops-finance').deny).toBe(false)
    expect(decide(run('--fiok=info --id r1 --cimzett-ledger'), 'zara').deny).toBe(false)
  })
  it('refuses another account, another agent, an unknown caller and an unreadable --fiok', () => {
    const cases: Array<[string, string | null, string | null]> = [
      [run('--fiok info --id r1 --cimzett-ledger'), 'ops-finance', 'info'],
      [run('--fiok szaszko --id r1 --cimzett-ledger'), 'zara', 'szaszko'],
      [run('--fiok info --id r1 --cimzett-ledger'), 'coder', 'info'],
      [run('--fiok procurement --id r1 --cimzett-ledger'), 'iris', 'procurement'],
      [run('--fiok info --id r1 --cimzett-ledger'), null, 'info'],
      [run('--fio info --id r1 --cimzett-ledger'), 'zara', null],
      [run('--fiok info --fiok szaszko --id r1 --cimzett-ledger'), 'zara', null],
    ]
    for (const [cmd, caller, account] of cases) {
      const v = decide(cmd, caller)
      expect(v.deny, cmd).toBe(true)
      expect(v.kind, cmd).toBe('send-account')
      expect(v.account, cmd).toBe(account)
      expect(v.agent, cmd).toBe(caller)
    }
  })
  it('the account opening is never reached below level 3, without --cimzett-ledger, or in a compound command', () => {
    // (the fake script carries no send code, so what refuses these in a real install is the earlier send
    // detection; the real-sender block below measures that. Here: the new allow does not fire.)
    expect(decide(run('--fiok szaszko --id r1 --cimzett-ledger'), 'ops-finance', 2).kind).toBeUndefined()
    expect(decide(run('--fiok szaszko --id r1'), 'ops-finance').kind).toBeUndefined()
    expect(decide(`${run('--fiok szaszko --id r1 --cimzett-ledger')}; true`, 'ops-finance').kind).toBeUndefined()
  })
  it('refuses a send from a script that is not the pinned one, even for an allowed caller', () => {
    const other = join(dir, 'other-kuldes.py')
    writeFileSync(other, 'print(1)\n')
    const v = gateDecision('Bash', { command: `${other} --fiok info --id r1 --cimzett-ledger --to a@b.hu` }, null, dir, LEVEL3, 'zara', pins)
    expect(v.deny).toBe(true)
  })
})

describe('gateDecision: MCP sends name no account, so they are refused at level 3 too', () => {
  const ok = () => true
  it('send_email with ledgered recipients is refused for every caller', () => {
    for (const caller of ['ops-finance', 'zara', 'coder', null]) {
      const v = gateDecision('mcp__gmail__send_email', { to: ['a@b.hu'], subject: 's', body: 'b' }, ok, '/tmp', LEVEL3, caller)
      expect(v.deny, String(caller)).toBe(true)
      expect(v.kind).toBe('send_email') // the thread-reply narrowing keeps its kind
    }
  })
  it('manage_email send is refused, its draft stays open', () => {
    const send = gateDecision('mcp__ws__manage_email', { operation: 'send', to: 'a@b.hu', subject: 's', body: 'b' }, ok, '/tmp', LEVEL3, 'zara')
    expect(send).toMatchObject({ deny: true, kind: 'draft-required' })
    const draft = gateDecision('mcp__ws__manage_email', { operation: 'send', draft: true, to: 'a@b.hu', subject: 's', body: 'b' }, ok, '/tmp', LEVEL3, 'coder')
    expect(draft.deny).toBe(false)
  })
})

describe('buildSendAccountMsg', () => {
  it('names the caller, the account, the table and the way on', () => {
    const m = buildSendAccountMsg('Marveen', 'coder', 'info')
    expect(m).toContain('ugynok: coder')
    expect(m).toContain('fiok: info')
    expect(m).toContain('ops-finance: procurement, szaszko')
    expect(m).toContain('zara: info')
    expect(m).toContain('DRAFT_ID')
    expect(m).toContain('Marveennek')
    expect(buildSendAccountMsg('Marveen', null, null)).toContain('nem azonosithato')
  })
})

// End to end through the real hook entrypoint, with the real pinned gmail-kuldes.py when this checkout has it
// (it is an install-local file, absent upstream). The identity comes from the payload's transcript_path.
const GATE = resolve(__dirname, '../../scripts/email-send-gate.mjs')
const ROOT = resolve(__dirname, '../..')
const REAL_SENDER = join(ROOT, 'scripts', 'gmail-kuldes.py')
const hasLevel3 = (() => {
  try {
    const cfg = JSON.parse(readFileSync(join(ROOT, 'store', 'autonomy-config.json'), 'utf-8'))
    const c = cfg.categories.find((x: { key: string }) => x.key === 'email_send')
    return Math.min(c.level, c.maxLevel ?? 3) >= 3
  } catch { return false }
})()

describe.skipIf(!existsSync(REAL_SENDER) || !hasLevel3)('hook entrypoint (install-local sender, level 3)', () => {
  const hook = (agent: string, fiok: string) => {
    const payload = {
      tool_name: 'Bash',
      tool_input: { command: `${REAL_SENDER} --fiok ${fiok} --id r0 --cimzett-ledger --proba` },
      cwd: join(ROOT, 'agents', 'ops-finance'),
      transcript_path: join(ROOT, 'agents', agent, '.claude-config', 'projects', `-x-agents-${agent}`, 's.jsonl'),
    }
    const env = { ...process.env, CLAUDE_CONFIG_DIR: join(ROOT, 'agents', agent, '.claude-config') }
    const r = spawnSync(process.execPath, [GATE], { input: JSON.stringify(payload), encoding: 'utf-8', env })
    return `${r.stdout}${r.stderr}`
  }
  it('allows ops-finance/szaszko and zara/info, denies coder/info even from ops-finance\'s cwd', () => {
    expect(hook('ops-finance', 'szaszko')).not.toContain('"permissionDecision":"deny"')
    expect(hook('zara', 'info')).not.toContain('"permissionDecision":"deny"')
    const coder = hook('coder', 'info')
    expect(coder).toContain('deny')
    expect(coder).toContain('ugynok: coder')
    expect(hook('zara', 'procurement')).toContain('fiok: procurement')
  })
  it('with the real sender, an allowed caller is still refused below level 3, without the ledger flag, compound', () => {
    const cmd = (a: string) => `${REAL_SENDER} --fiok szaszko --id r1 ${a}`
    const d = (c: string, level: number) => gateDecision('Bash', { command: c }, null, ROOT, level, 'ops-finance')
    expect(d(cmd('--cimzett-ledger'), 3).deny).toBe(false)
    expect(d(cmd('--cimzett-ledger'), 2).deny).toBe(true)
    expect(d(cmd(''), 3).deny).toBe(true)
    expect(d(`${cmd('--cimzett-ledger')}; true`, 3).deny).toBe(true)
  })
})
