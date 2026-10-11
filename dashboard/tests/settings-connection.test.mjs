import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

// Exercise the actual Settings handlers without a browser or a running bridge.
const source = readFileSync(new URL('../src/components/Settings.tsx', import.meta.url), 'utf8')
const ast = ts.createSourceFile('Settings.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const handlers = []
function visit(node) {
  if (ts.isFunctionDeclaration(node) && ['applyConnectionPort', 'saveAndRestart'].includes(node.name?.text)) {
    handlers.push(node.getText(ast))
  }
  ts.forEachChild(node, visit)
}
visit(ast)
assert.equal(handlers.length, 2)
const code = ts.transpileModule(handlers.join('\n'), {}).outputText
function setup(portInput = '', serverPortInput = '', ok = true, followServerPort = false, origin = 'https://pitwall.kalanur.de') {
  const calls = { updates: [], requests: [], reloads: 0, error: null, status: null, busy: false }
  const context = vm.createContext({
    portInput, serverPortInput, followServerPort, URL, setTimeout: fn => fn(),
    s: { update: value => calls.updates.push(JSON.parse(JSON.stringify(value))) },
    window: { location: { origin, href: `${origin}/?view=timing`, reload: () => calls.reloads++ } },
    bridgeHttpBase: () => 'https://pitwall.kalanur.de',
    setConnectionError: value => { calls.error = value },
    setPortStatus: value => { calls.status = value },
    setPortBusy: value => { calls.busy = value },
    fetch: async (...args) => { calls.requests.push(args); return { ok, status: 500 } },
  })
  vm.runInContext(code, context)
  return { calls, context }
}
for (const [input, expected] of [['', 0], ['443', 443], ['9000', 9000]]) {
  test(`connection port ${input || 'auto'} never restarts the bridge`, () => {
    const { calls, context } = setup(input)
    context.applyConnectionPort()
    assert.deepEqual(calls.updates, [{ wsPort: expected }])
    assert.equal(calls.reloads, 1)
    assert.equal(calls.requests.length, 0)
  })
}
test('invalid connection ports do not save or reload', () => {
  for (const input of ['0', '-1', '65536', '2.5', '9000oops']) {
    const { calls, context } = setup(input)
    context.applyConnectionPort()
    assert.ok(calls.error)
    assert.equal(calls.updates.length, 0)
    assert.equal(calls.reloads, 0)
  }
})
test('internal port change preserves public settings and page location', async () => {
  const { calls, context } = setup('443', '9001')
  await context.saveAndRestart()
  assert.equal(calls.requests[0][0], 'https://pitwall.kalanur.de/api/set-port')
  assert.equal(calls.requests[0][1].method, 'POST')
  assert.deepEqual(JSON.parse(calls.requests[0][1].body), { port: 9001 })
  assert.equal(calls.updates.length, 0)
  assert.equal(calls.reloads, 0)
  assert.match(calls.status, /upstream port/)
})
test('invalid or empty internal port never restarts the bridge', async () => {
  for (const input of ['', '443', '9000oops', '9000.5', '65536']) {
    const { calls, context } = setup('', input)
    await context.saveAndRestart()
    assert.equal(calls.requests.length, 0)
    assert.equal(calls.busy, false)
  }
})
test('failed restart allows retry and preserves connection settings', async () => {
  const { calls, context } = setup('443', '9001', false)
  await context.saveAndRestart()
  assert.equal(calls.busy, false)
  assert.match(calls.status, /HTTP 500/)
  assert.equal(calls.updates.length, 0)
  assert.equal(calls.reloads, 0)
})

test('explicit direct access redirects and preserves path and query', async () => {
  const { calls, context } = setup('443', '9001', true, true)
  await context.saveAndRestart()
  assert.equal(context.window.location.href, 'https://pitwall.kalanur.de:9001/?view=timing')
  assert.deepEqual(calls.updates, [{ wsPort: 0 }])
})
test('separate dashboard origin never redirects even with stale direct-access selection', async () => {
  const { calls, context } = setup('', '9001', true, true, 'https://dashboard.example')
  await context.saveAndRestart()
  assert.equal(context.window.location.href, 'https://dashboard.example/?view=timing')
  assert.equal(calls.updates.length, 0)
})