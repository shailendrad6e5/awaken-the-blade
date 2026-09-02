import assert from 'node:assert/strict'
import test from 'node:test'
import { createDrawImpactGate, DRAW_IMPACT } from '../src/draw-impact.js'

const eventsFor = (values, gate = createDrawImpactGate()) => values
  .map((value) => gate.sample(value)).filter(Boolean)

test('normal and very slow draws each release once', () => {
  assert.deepEqual(eventsFor([0, 0.7, 0.9, 0.92, 0.94, 1]), ['forward'])
  assert.deepEqual(eventsFor(Array.from({ length: 10001 }, (_, i) => i / 10000)), ['forward'])
})

test('a skipped threshold still releases once', () => {
  assert.deepEqual(eventsFor([0.7, 0.98, 1]), ['forward'])
})

test('85–98% oscillation cannot repeat either impact without full re-arm', () => {
  const oscillations = Array.from({ length: 100 }, () => [0.85, 0.98]).flat()
  assert.deepEqual(eventsFor([0.7, 0.98, ...oscillations]), ['forward', 'reverse'])
})

test('reverse has its own crossing and re-arms only with the next full draw', () => {
  assert.deepEqual(eventsFor([0, 0.93, 1, 0.905, 0.899, 0.92, 0.89, 0.76, 0.98, 0.89]),
    ['forward', 'reverse', 'forward', 'reverse'])
})

test('restoring a pose never creates an impact', () => {
  const gate = createDrawImpactGate()
  gate.synchronize(1)
  assert.equal(gate.sample(1), null)
  gate.synchronize(0.7)
  assert.equal(gate.sample(0.98), 'forward')
  gate.synchronize(0.88)
  assert.equal(gate.sample(0.98), null)
})

test('Begin Again / Return reset allows the next crossing', () => {
  const gate = createDrawImpactGate()
  assert.deepEqual(eventsFor([0, 1], gate), ['forward'])
  gate.reset()
  assert.deepEqual(eventsFor([0, 0.8, 0.92], gate), ['forward'])
})

test('invalid samples do not corrupt a pending crossing', () => {
  assert.deepEqual(eventsFor([0.7, NaN, undefined, Infinity, 0.98]), ['forward'])
})

test('release profile stays inside the specified timing and hysteresis bounds', () => {
  assert.equal(DRAW_IMPACT.threshold, 0.92)
  assert.equal(DRAW_IMPACT.rearm, 0.76)
  assert.equal(DRAW_IMPACT.duration, 0.22)
  assert.equal(DRAW_IMPACT.pulseDuration, 0.12)
  assert.equal(DRAW_IMPACT.reverseStrength, 0.35)
})
