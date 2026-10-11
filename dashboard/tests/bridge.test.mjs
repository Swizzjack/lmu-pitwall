import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

const source = readFileSync(new URL('../src/utils/bridge.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
})

const cases = [
  ['HTTPS proxy', 'https://pitwall.kalanur.de', '', 0, 'pitwall.kalanur.de'],
  ['HTTP default port', 'http://pitwall.kalanur.de', '', 0, 'pitwall.kalanur.de'],
  ['direct bridge', 'http://localhost:9000', '', 0, 'localhost:9000'],
  ['custom proxy port', 'https://pitwall.kalanur.de:8443', '', 0, 'pitwall.kalanur.de:8443'],
  ['explicit host and port', 'http://localhost:5173', '  bridge.local  ', 9000, 'bridge.local:9000'],
  ['explicit secure target', 'https://pitwall.kalanur.de', 'bridge.example', 8443, 'bridge.example:8443'],
  ['explicit port only', 'https://pitwall.kalanur.de', '', 8443, 'pitwall.kalanur.de:8443'],
  ['explicit host only', 'https://pitwall.kalanur.de', 'bridge.example', 0, 'bridge.example'],
  ['host with inherited port', 'http://localhost:9000', 'bridge.local', 0, 'bridge.local:9000'],
  ['whitespace auto host', 'https://pitwall.kalanur.de', '  ', 0, 'pitwall.kalanur.de'],
  ['IPv6 auto', 'http://[::1]:9000', '', 0, '[::1]:9000'],
  ['IPv6 explicit', 'https://pitwall.kalanur.de', '[::1]', 9443, '[::1]:9443'],
]

for (const [name, origin, wsHost, wsPort, authority] of cases) {
  test(name, () => {
    const location = new URL(origin)
    const exports = {}
    vm.runInNewContext(outputText, {
      exports,
      window: { location },
      require(id) {
        assert.equal(id, '../stores/settingsStore')
        return { useSettingsStore: { getState: () => ({ wsHost, wsPort }) } }
      },
    })
    const secure = location.protocol === 'https:'
    assert.equal(exports.bridgeWsUrl(), `${secure ? 'wss' : 'ws'}://${authority}`)
    assert.equal(exports.bridgeHttpBase(), `${secure ? 'https' : 'http'}://${authority}`)
  })
}
