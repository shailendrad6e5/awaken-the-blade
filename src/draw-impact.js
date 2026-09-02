import gsap from 'gsap'

export const DRAW_IMPACT = Object.freeze({
  threshold: 0.92, rearm: 0.76, reverseThreshold: 0.9,
  reverseStrength: 0.35, duration: 0.22, pulseDuration: 0.12,
})

// Crossing state is independent of frame rate, presentation and GSAP scrubbing.
export function createDrawImpactGate() {
  let previous = null
  let armed = true
  let reverseArmed = false
  const synchronize = (progress) => {
    previous = progress
    if (progress <= DRAW_IMPACT.rearm) {
      armed = true
      reverseArmed = false
    } else if (progress >= DRAW_IMPACT.threshold) {
      armed = false
      reverseArmed = true
    }
  }
  return {
    synchronize,
    reset() { previous = null; armed = true; reverseArmed = false },
    sample(progress) {
      if (!Number.isFinite(progress)) return null
      if (previous === null) { synchronize(progress); return null }
      const before = previous
      previous = progress
      if (progress <= DRAW_IMPACT.rearm) { armed = true; reverseArmed = false }
      if (armed && before < DRAW_IMPACT.threshold && progress >= DRAW_IMPACT.threshold) {
        armed = false
        reverseArmed = true
        return 'forward'
      }
      if (reverseArmed && before >= DRAW_IMPACT.reverseThreshold && progress < DRAW_IMPACT.reverseThreshold) {
        reverseArmed = false
        return 'reverse'
      }
      return null
    },
  }
}

export function createDrawImpact({ weapon, motionPreference, onPayoffUpdate }) {
  const hero = document.querySelector('[data-draw-impact]')
  const stage = document.querySelector('.weapon-stage')
  const targets = [hero, stage]
  const coarsePointer = window.matchMedia('(pointer: coarse)')
  const gate = createDrawImpactGate()
  const state = { x: 0, y: 0, roll: 0, light: 0, payoff: 0 }
  let timeline
  let suspended = false
  let returning = false
  let wasEligible = false
  let lastPayoff = -1

  const paint = () => {
    gsap.set(targets, {
      '--draw-impact-x': `${state.x}px`,
      '--draw-impact-y': `${state.y}px`,
      '--draw-impact-roll': `${state.roll}deg`,
    })
    stage.style.setProperty('--draw-impact-light', state.light)
    // Sub-pixel inertia, outside every chapter/inspection/extraction transform.
    weapon.impactPivot.position.set(-state.x * 0.0024, state.y * 0.0022, 0)
    weapon.impactPivot.rotation.set(0, 0, -state.roll * Math.PI / 1080)
    if (state.payoff !== lastPayoff) { lastPayoff = state.payoff; onPayoffUpdate?.() }
  }
  const neutralize = () => {
    timeline?.kill()
    timeline = undefined
    Object.assign(state, { x: 0, y: 0, roll: 0, light: 0 })
    weapon.impactPivot.scale.setScalar(1)
    hero.dataset.drawImpact = 'idle'
    paint()
  }
  const setPayoff = (value) => {
    if (state.payoff === value) return
    state.payoff = value
    paint()
  }
  const play = (direction) => {
    neutralize()
    const forward = direction === 'forward'
    const reduced = motionPreference.matches
    const strength = (forward ? 1 : DRAW_IMPACT.reverseStrength) * (coarsePointer.matches ? 0.55 : 1)
    const duration = forward ? DRAW_IMPACT.duration : DRAW_IMPACT.duration * 0.7
    if (forward) setPayoff(0)
    hero.dataset.drawImpact = direction
    timeline = gsap.timeline({
      onUpdate: paint,
      onComplete: () => {
        timeline = undefined
        Object.assign(state, { x: 0, y: 0, roll: 0, light: 0 })
        hero.dataset.drawImpact = 'idle'
        paint()
      },
    })
    if (!reduced) {
      const recoil = [
        [5, -1.8, 0.12, 0.024], [-4, 1.3, -0.09, 0.036],
        [3, -0.9, 0.065, 0.04], [-2, 0.6, -0.04, 0.04],
        [1, -0.3, 0.02, 0.04], [0, 0, 0, 0.04],
      ]
      let at = 0
      recoil.forEach(([x, y, roll, seconds]) => {
        const segmentDuration = seconds * duration / DRAW_IMPACT.duration
        timeline.to(state, {
          x: x * strength, y: y * strength, roll: roll * strength,
          duration: segmentDuration, ease: 'sine.inOut',
        }, at)
        at += segmentDuration
      })
    }
    timeline
      .to(state, { light: strength, duration: 0.025, ease: 'power2.out' }, 0)
      .to(state, { light: 0, duration: DRAW_IMPACT.pulseDuration - 0.025, ease: 'power2.in' }, 0.025)
    // Finish the payoff even if a rapid reversal interrupted its forward fade.
    // Extraction still controls whether this text is visible while sheathing.
    timeline.to(state, { payoff: 1, duration: 0.14, ease: 'power2.out' }, reduced ? DRAW_IMPACT.pulseDuration : duration)
  }

  return {
    get payoffVisibility() { return state.payoff },
    update(progress, eligible) {
      if (suspended || !Number.isFinite(progress)) return
      if (!eligible) {
        if (wasEligible) neutralize()
        wasEligible = false
        gate.synchronize(progress)
        setPayoff(progress >= DRAW_IMPACT.threshold ? 1 : 0)
        return
      }
      if (!wasEligible) {
        gate.synchronize(progress)
        setPayoff(progress >= DRAW_IMPACT.threshold ? 1 : 0)
        wasEligible = true
      }
      if (returning) {
        gate.synchronize(progress)
        if (progress > DRAW_IMPACT.rearm) return
        returning = false
      }
      if (progress <= DRAW_IMPACT.rearm) {
        if (timeline) neutralize()
        setPayoff(0)
      }
      const direction = gate.sample(progress)
      if (direction) play(direction)
    },
    resetForReturn() { neutralize(); gate.reset(); returning = true },
    suspend() { suspended = true; neutralize() },
    resume(progress) {
      gate.synchronize(progress)
      setPayoff(progress >= DRAW_IMPACT.threshold ? 1 : 0)
      suspended = false
      wasEligible = false
    },
    destroy() {
      suspended = true
      neutralize()
      targets.forEach((target) => {
        ['--draw-impact-x', '--draw-impact-y', '--draw-impact-roll', '--draw-impact-light']
          .forEach((property) => target.style.removeProperty(property))
      })
    },
  }
}
