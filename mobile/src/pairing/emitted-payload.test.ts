// The one link `.prd/12` Q4 left open: the desktop's emitter and the phone's parser were only ever
// compared *by reading*. This runs the parser against a payload `herdr pair --json` actually
// printed, captured at `src/cli/pair.rs` HEAD.
//
// The key body — and only the key body — is replaced in the fixture: it is a real OpenSSH private
// key, generated for nothing and authorized nowhere, and a repo that carries one teaches the next
// person that carrying one is fine. Everything the contract turns on (field set, `v`, `port`
// defaulting, `issuedAt` in **milliseconds**, the armor around the key) is the emitter's own bytes.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parsePairingCode, remoteConfigFromPairing } from './pairing-payload'

const EMITTED = readFileSync(
  new URL('./__fixtures__/herdr-pair-emitted.json', import.meta.url),
  'utf8'
)

describe('herdr pair 방출본 ↔ 폰 파서 (조건 5 종단 계약)', () => {
  it('실제로 방출된 페이로드를 파서가 받아들인다', () => {
    const parsed = parsePairingCode(EMITTED)
    if (!parsed.ok) {
      throw new Error(parsed.reason)
    }
    expect(parsed.payload.v).toBe(1)
    expect(parsed.payload.host).toBe('lab.example')
    expect(parsed.payload.user).toBe('z')
    // `--host/--user`만 준 실행이라 포트는 에미터가 22를 실어 보낸다.
    expect(parsed.payload.port).toBe(22)
    expect(parsed.payload.key).toContain('BEGIN OPENSSH PRIVATE KEY')
  })

  it('`issuedAt`이 초가 아니라 밀리초다 — 이걸 틀리면 폰이 55년 된 코드로 읽는다', () => {
    const parsed = parsePairingCode(EMITTED)
    expect(parsed.ok && String(parsed.payload.issuedAt).length).toBe(13)
  })

  it('방출본이 키스토어에 저장 가능한 config가 된다 — 파싱 성공과 저장 성공은 다른 일이다', () => {
    const parsed = parsePairingCode(EMITTED)
    if (!parsed.ok) {
      throw new Error(parsed.reason)
    }
    const config = remoteConfigFromPairing(parsed.payload)
    // `remote-store.ts`의 id 제약. 여기서 걸리면 스캔은 완벽하고 저장에서 죽는다.
    expect(config.id).toMatch(/^[A-Za-z0-9._-]{1,64}$/)
    expect(config.host).toBe('lab.example')
    expect(config.privateKey).not.toBe('')
  })
})
