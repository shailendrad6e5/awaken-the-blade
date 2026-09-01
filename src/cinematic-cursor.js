import gsap from 'gsap'

let activeController = null

// Visual enhancement only: no pointer capture, wheel listener, scroll control,
// or Three.js mutation. Inspection/chapter ownership stays with main.js.
export function createCinematicCursor() {
  activeController?.destroy()
  const root = document.documentElement
  const cursor = document.querySelector('[data-forged-cursor]')
  const reticle = cursor?.querySelector('.forged-cursor__reticle')
  const header = document.querySelector('[data-header]')
  if (!cursor || !reticle || !header) return { destroy() {} }

  const capability = window.matchMedia('(pointer: fine) and (hover: hover)')
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  const interactiveSelector = 'a[href], button:not(:disabled), [role="button"], [role="link"]'
  const nativeSelector = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [data-cursor="native"]'
  const magnets = [...document.querySelectorAll('[data-magnetic]')].map((element) => ({
    element, x: 0, y: 0, rect: null,
  }))
  const magnetMap = new Map(magnets.map((record) => [record.element, record]))
  const MAGNET_LIMIT = 3
  const RING_LAG_LIMIT = 7
  let x = 0
  let y = 0
  let ringX = 0
  let ringY = 0
  let viewportWidth = window.innerWidth
  let viewportHeight = window.innerHeight
  let hovered = null
  let activeMagnet = null
  let inside = false
  let hasPosition = false
  let keyboardMode = false
  let selecting = false
  let environmentDirty = true
  let geometryDirty = true
  let lastMovement = 0
  let clickStarted = -Infinity
  let visible = false
  let ticking = false
  let destroyed = false
  let currentState = 'hidden'
  let currentVariant = ''
  let idle = false
  let pulsing = false

  const setState = (state, variant = '') => {
    if (currentState !== state) {
      currentState = state
      cursor.dataset.state = state
    }
    if (currentVariant !== variant) {
      currentVariant = variant
      cursor.dataset.variant = variant
    }
  }

  const hide = () => {
    visible = false
    root.classList.remove('has-forged-cursor')
    setState('hidden')
  }

  const updateTarget = (event) => {
    if (event.pointerType === 'touch') {
      inside = false
      hasPosition = false
      return
    }
    if (!capability.matches) return
    x = event.clientX
    y = event.clientY
    inside = x >= 0 && y >= 0 && x < viewportWidth && y < viewportHeight
    hasPosition = true
    keyboardMode = false
    hovered = event.target instanceof Element ? event.target : null
    lastMovement = performance.now()
  }

  const onPointerOut = (event) => {
    if (event.relatedTarget === null) inside = false
  }
  const onPointerDown = (event) => {
    updateTarget(event)
    if (event.button === 0 && event.pointerType !== 'touch') clickStarted = performance.now()
  }
  const onBlur = () => { inside = false }
  const onKeyDown = (event) => {
    if (event.key === 'Tab') keyboardMode = true
  }
  const onSelectionChange = () => {
    const selection = document.getSelection()
    selecting = Boolean(selection && !selection.isCollapsed)
  }
  const onEnvironmentChange = () => {
    environmentDirty = true
    geometryDirty = true
  }
  const onResize = () => {
    viewportWidth = window.innerWidth
    viewportHeight = window.innerHeight
    onEnvironmentChange()
  }

  const renderMagnets = (delta, enabled, interactive, dragging) => {
    const candidate = enabled && !dragging && !reducedMotion.matches
      ? magnetMap.get(interactive?.closest('[data-magnetic]')) ?? null
      : null
    if (candidate !== activeMagnet) {
      activeMagnet = candidate
      geometryDirty = true
    }
    // The stationary button is measured only on entry/scroll/resize, never
    // for each pointer move. Only its non-interactive children translate.
    if (activeMagnet && geometryDirty) activeMagnet.rect = activeMagnet.element.getBoundingClientRect()
    geometryDirty = false
    const response = reducedMotion.matches ? 1 : 1 - Math.exp(-16 * delta)
    for (const record of magnets) {
      let targetX = 0
      let targetY = 0
      if (record === activeMagnet && record.rect) {
        const { left, top, width, height } = record.rect
        const normalizedX = (x - left - width / 2) / Math.max(1, width / 2)
        const normalizedY = (y - top - height / 2) / Math.max(1, height / 2)
        const magnitude = Math.max(1, Math.hypot(normalizedX, normalizedY))
        targetX = normalizedX / magnitude * MAGNET_LIMIT
        targetY = normalizedY / magnitude * MAGNET_LIMIT
      }
      const nextX = record.x + (targetX - record.x) * response
      const nextY = record.y + (targetY - record.y) * response
      if (Math.abs(nextX - record.x) + Math.abs(nextY - record.y) < 0.001) continue
      record.x = Math.abs(nextX) < 0.005 ? 0 : nextX
      record.y = Math.abs(nextY) < 0.005 ? 0 : nextY
      record.element.style.setProperty('--magnetic-x', `${record.x.toFixed(3)}px`)
      record.element.style.setProperty('--magnetic-y', `${record.y.toFixed(3)}px`)
    }
  }

  const render = (_time, deltaMilliseconds) => {
    if (destroyed) return
    const delta = Math.min(deltaMilliseconds / 1000 || 1 / 60, 0.05)
    const ready = !root.classList.contains('is-loading') && !root.classList.contains('is-transitioning')
    const enabled = ready && capability.matches && inside && hasPosition && !keyboardMode && !selecting && !document.hidden
    if (environmentDirty && enabled) {
      hovered = document.elementFromPoint(x, y)
      environmentDirty = false
    }
    const nativeTarget = hovered?.closest(nativeSelector)
    const interactive = hovered?.closest(interactiveSelector)
    const dragging = document.body.classList.contains('inspection-dragging')
    const shouldShow = enabled && !nativeTarget
    renderMagnets(delta, shouldShow, interactive, dragging)
    if (!shouldShow) {
      if (visible || currentState !== 'hidden') hide()
      return
    }

    if (!visible || reducedMotion.matches) {
      ringX = x
      ringY = y
    } else {
      const response = 1 - Math.exp(-30 * delta)
      ringX += (x - ringX) * response
      ringY += (y - ringY) * response
      const distance = Math.hypot(ringX - x, ringY - y)
      if (distance > RING_LAG_LIMIT) {
        ringX = x + (ringX - x) / distance * RING_LAG_LIMIT
        ringY = y + (ringY - y) / distance * RING_LAG_LIMIT
      }
    }

    const inspection = document.body.classList.contains('inspection-active')
    const chapter = header.dataset.chapter
    const artifactArea = (chapter === 'awaken' || chapter === 'draw')
      && x > viewportWidth * 0.56 && y > viewportHeight * 0.16 && y < viewportHeight * 0.9
    if (dragging) setState('inspectionDragging')
    else if (interactive) {
      const variant = interactive.hasAttribute('data-chapter-link') ? 'rail' : interactive.dataset.cursor ?? ''
      setState('interactive', variant)
    } else if (inspection) setState('inspection')
    else if (chapter === 'wielder') setState('cinematic')
    else if (artifactArea) setState('blade')
    else setState('default')

    const now = performance.now()
    const nextIdle = now - lastMovement > 2000 && !dragging
    if (nextIdle !== idle) {
      idle = nextIdle
      cursor.dataset.idle = String(idle)
    }
    const clickAge = now - clickStarted
    const nextPulsing = clickAge >= 0 && clickAge < 220 && !dragging
    if (nextPulsing !== pulsing) {
      pulsing = nextPulsing
      cursor.dataset.pulse = String(pulsing)
    }
    let pressure = 1
    if (pulsing) {
      const compression = reducedMotion.matches ? 0.04 : 0.16
      const expansion = reducedMotion.matches ? 0 : 0.035
      if (clickAge < 70) pressure = 1 - compression * clickAge / 70
      else if (clickAge < 140) pressure = 1 - compression + (compression + expansion) * (clickAge - 70) / 70
      else pressure = 1 + expansion * (1 - (clickAge - 140) / 80)
    }
    cursor.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)`
    reticle.style.transform = `translate3d(${(ringX - x).toFixed(2)}px, ${(ringY - y).toFixed(2)}px, 0)`
    cursor.style.setProperty('--cursor-pressure', pressure.toFixed(4))
    // Native hiding is opt-in only after the initialized cursor has a valid
    // position and its first visual frame has been written successfully.
    if (!visible) {
      visible = true
      root.classList.add('has-forged-cursor')
    }
  }

  const syncCapability = () => {
    if (capability.matches && !ticking) {
      gsap.ticker.add(render)
      ticking = true
    } else if (!capability.matches && ticking) {
      gsap.ticker.remove(render)
      ticking = false
      hide()
      inside = false
      activeMagnet = null
      for (const record of magnets) {
        record.x = record.y = 0
        record.element.style.removeProperty('--magnetic-x')
        record.element.style.removeProperty('--magnetic-y')
      }
    }
    onEnvironmentChange()
  }
  const observer = new MutationObserver(onEnvironmentChange)
  observer.observe(root, { attributes: true, attributeFilter: ['class'] })
  observer.observe(document.body, { attributes: true, attributeFilter: ['class'] })
  observer.observe(header, { attributes: true, attributeFilter: ['data-chapter'] })
  document.addEventListener('pointermove', updateTarget, { passive: true })
  document.addEventListener('pointerover', updateTarget, { passive: true })
  document.addEventListener('pointerout', onPointerOut, { passive: true })
  document.addEventListener('pointerdown', onPointerDown, { passive: true })
  document.addEventListener('keydown', onKeyDown)
  document.addEventListener('selectionchange', onSelectionChange)
  document.addEventListener('visibilitychange', onEnvironmentChange)
  window.addEventListener('blur', onBlur)
  window.addEventListener('contextmenu', onBlur)
  window.addEventListener('scroll', onEnvironmentChange, { passive: true })
  window.addEventListener('resize', onResize, { passive: true })
  capability.addEventListener('change', syncCapability)
  reducedMotion.addEventListener('change', onEnvironmentChange)
  syncCapability()

  const controller = {
    destroy() {
      if (destroyed) return
      destroyed = true
      gsap.ticker.remove(render)
      observer.disconnect()
      hide()
      document.removeEventListener('pointermove', updateTarget)
      document.removeEventListener('pointerover', updateTarget)
      document.removeEventListener('pointerout', onPointerOut)
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('selectionchange', onSelectionChange)
      document.removeEventListener('visibilitychange', onEnvironmentChange)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('contextmenu', onBlur)
      window.removeEventListener('scroll', onEnvironmentChange)
      window.removeEventListener('resize', onResize)
      capability.removeEventListener('change', syncCapability)
      reducedMotion.removeEventListener('change', onEnvironmentChange)
      for (const { element } of magnets) {
        element.style.removeProperty('--magnetic-x')
        element.style.removeProperty('--magnetic-y')
      }
      cursor.removeAttribute('style')
      reticle.removeAttribute('style')
      delete cursor.dataset.idle
      delete cursor.dataset.pulse
      delete cursor.dataset.variant
      if (activeController === controller) activeController = null
    },
  }
  activeController = controller
  return controller
}

if (import.meta.hot) import.meta.hot.dispose(() => activeController?.destroy())
