import './style.css'
import 'lenis/dist/lenis.css'
import Lenis from 'lenis'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { createWeaponScene } from './weapon-scene.js'

gsap.registerPlugin(ScrollTrigger)
// ScrollTrigger's built-in resize refresh can run while Chrome is still
// changing the layout for docked DevTools. The debounced coordinator below
// owns resize refreshes so every system settles against the same viewport.
ScrollTrigger.config({ autoRefreshEvents: 'visibilitychange,DOMContentLoaded,load' })

const MODEL_EXPECTED_BYTES = 35_070_476
const MINIMUM_LOADER_TIME = 900
const RESIZE_DEBOUNCE_MS = 180
const COMPACT_VIEWPORT_MAX_WIDTH = 900
const root = document.documentElement
const header = document.querySelector('[data-header]')
const menuToggle = document.querySelector('.menu-toggle')
const navigationLinks = document.querySelectorAll('.site-nav a')
const chapterRail = document.querySelector('[data-chapter-rail]')
const chapterLinks = [...document.querySelectorAll('[data-chapter-link]')]
const drawButton = document.querySelector('[data-draw-button]')
const returnButton = document.querySelector('[data-return-sheath]')
const beginAgainButton = document.querySelector('[data-begin-again]')
const canvas = document.querySelector('.weapon-canvas')
const loaderElement = document.querySelector('[data-loader]')
const loaderPercent = document.querySelector('[data-loader-percent]')
const loaderBar = document.querySelector('[data-loader-bar]')
const loaderBrand = document.querySelector('[data-loader-brand]')
const loaderLabel = document.querySelector('[data-loader-label]')

let heroTrigger
let activeWeapon
let activeMedia
let activeLoader
let introTimeline
let experienceStarted = false
let activeMaster
let activeChapters = []
let resizeTimer = 0
let resizeGeneration = 0
let pendingResizeAnchor
let viewportMode = getViewportMode()
let wielderController
const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)')

const lenis = new Lenis({
  autoRaf: false,
  duration: 1.2,
  easing: (value) => Math.min(1, 1.001 - 2 ** (-10 * value)),
  smoothWheel: true,
  wheelMultiplier: 0.86,
  touchMultiplier: 1.05,
})
const updateLenis = (time) => lenis.raf(time * 1000)
lenis.on('scroll', ScrollTrigger.update)
lenis.stop()
gsap.ticker.add(updateLenis)
gsap.ticker.lagSmoothing(0)

function getViewportMode() {
  return window.innerWidth > COMPACT_VIEWPORT_MAX_WIDTH ? 'desktop' : 'compact'
}

function getHeroRestingX() {
  return getViewportMode() === 'desktop' ? 1.62 : 0.45
}

function getCurrentScrollPosition() {
  const nativeScroll = Number(window.scrollY || document.scrollingElement?.scrollTop)
  if (Number.isFinite(nativeScroll)) return Math.max(0, nativeScroll)
  const lenisScroll = Number(lenis.actualScroll)
  return Number.isFinite(lenisScroll)
    ? Math.max(0, lenisScroll)
    : 0
}

function waitForStableLayout() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
}

function destroyScrollExperience() {
  activeMaster?.scrollTrigger?.kill()
  activeMaster?.kill()
  activeMaster = undefined
  activeChapters.forEach((timeline) => {
    timeline.scrollTrigger?.kill()
    timeline.kill()
  })
  activeChapters = []
  heroTrigger = undefined
  wielderController?.destroyPrefetch()
}

function rebuildScrollExperienceForViewport() {
  if (!activeWeapon) return
  destroyScrollExperience()
  activeMedia?.revert()
  activeMedia = undefined

  const activateScrollExperience = setupExperience(activeWeapon)
  if (experienceStarted) introTimeline?.progress(1)
  activateScrollExperience()
}

function getProgressAtScroll(trigger, scrollPosition) {
  const distance = trigger.end - trigger.start
  if (!Number.isFinite(distance) || distance <= 0) return 0
  return gsap.utils.clamp(0, 1, (scrollPosition - trigger.start) / distance)
}

function captureScrollAnchor() {
  const scrollPosition = getCurrentScrollPosition()
  const activeChapterId = header.dataset.chapter
  const timeline = activeChapterId === 'awaken' || activeChapterId === 'draw'
    ? activeMaster
    : activeChapters.find(({ scrollTrigger }) => scrollTrigger?.vars.id === `chapter-${activeChapterId}`)
  const trigger = timeline?.scrollTrigger
  if (!trigger) return { scrollPosition }
  return {
    scrollPosition,
    triggerId: activeChapterId === 'awaken' || activeChapterId === 'draw'
      ? 'hero'
      : trigger.vars.id,
    progress: gsap.utils.clamp(0, 1, timeline.progress()),
  }
}

function resolveScrollAnchor(anchor) {
  const timeline = anchor.triggerId === 'hero'
    ? activeMaster
    : activeChapters.find(({ scrollTrigger }) => scrollTrigger?.vars.id === anchor.triggerId)
  const trigger = timeline?.scrollTrigger
  if (trigger && Number.isFinite(anchor.progress)) {
    return trigger.start + (trigger.end - trigger.start) * anchor.progress
  }
  return anchor.scrollPosition
}

function renderTimelinesAtCurrentScroll() {
  const scrollPosition = getCurrentScrollPosition()
  const timelines = [activeMaster, ...activeChapters].filter(Boolean)
  timelines.forEach((timeline) => {
    const trigger = timeline.scrollTrigger
    if (!trigger) return
    // A refresh updates trigger measurements but may not re-render a scrubbed
    // timeline when the scroll value itself did not change. Render its current
    // progress once so DOM, 3D and chapter values share one source of truth.
    timeline.progress(getProgressAtScroll(trigger, scrollPosition), false)
  })

  const wielderTrigger = activeChapters
    .map((timeline) => timeline.scrollTrigger)
    .find((trigger) => trigger?.vars.id === 'chapter-wielder')
  if (wielderTrigger) {
    wielderController?.setProgress(getProgressAtScroll(wielderTrigger, scrollPosition))
  }

  if (heroTrigger && scrollPosition >= heroTrigger.start && scrollPosition <= heroTrigger.end) {
    setActiveChapter(getProgressAtScroll(heroTrigger, scrollPosition) < 0.1 ? 'awaken' : 'draw')
    return
  }

  const currentChapter = activeChapters
    .map((timeline) => timeline.scrollTrigger)
    .filter(Boolean)
    .filter((trigger) => scrollPosition >= trigger.start)
    .sort((a, b) => b.start - a.start)[0]

  const chapter = currentChapter?.vars.id?.replace('chapter-', '')
  if (chapter) setActiveChapter(chapter)
}

async function synchronizeResize(generation) {
  if (!activeWeapon || !experienceStarted || generation !== resizeGeneration) return

  const preservedAnchor = pendingResizeAnchor ?? captureScrollAnchor()
  const nextViewportMode = getViewportMode()
  const crossedBreakpoint = nextViewportMode !== viewportMode

  // Resize the WebGL surface immediately, then wait for CSS and DevTools to
  // finish their own layout work before recalculating scroll measurements.
  activeWeapon.resize()
  lenis.resize()
  await waitForStableLayout()
  if (generation !== resizeGeneration) return

  if (crossedBreakpoint) rebuildScrollExperienceForViewport()
  viewportMode = nextViewportMode

  activeWeapon.resize()
  lenis.resize()
  await waitForStableLayout()
  if (generation !== resizeGeneration) return

  ScrollTrigger.refresh()
  // Restore the same chapter-owned timeline position after CSS breakpoints
  // and pin spacing have changed the document's absolute coordinates.
  lenis.resize()
  const destination = resolveScrollAnchor(preservedAnchor)
  lenis.scrollTo(Math.min(destination, lenis.limit), { immediate: true, force: true })
  ScrollTrigger.update()
  renderTimelinesAtCurrentScroll()
  pendingResizeAnchor = undefined
}

function scheduleResizeSynchronization() {
  if (!activeWeapon || !experienceStarted) return
  pendingResizeAnchor ??= captureScrollAnchor()
  window.clearTimeout(resizeTimer)
  const generation = ++resizeGeneration
  resizeTimer = window.setTimeout(() => {
    resizeTimer = 0
    void synchronizeResize(generation)
  }, RESIZE_DEBOUNCE_MS)
}

window.addEventListener('resize', scheduleResizeSynchronization, { passive: true })
window.visualViewport?.addEventListener('resize', scheduleResizeSynchronization, { passive: true })

async function synchronizeMotionPreference() {
  if (!activeWeapon || !experienceStarted) return
  const preservedAnchor = captureScrollAnchor()
  rebuildScrollExperienceForViewport()
  await waitForStableLayout()
  lenis.resize()
  ScrollTrigger.refresh()
  const destination = resolveScrollAnchor(preservedAnchor)
  lenis.scrollTo(Math.min(destination, lenis.limit), { immediate: true, force: true })
  ScrollTrigger.update()
  renderTimelinesAtCurrentScroll()
}

const onMotionPreferenceChange = () => { void synchronizeMotionPreference() }
motionPreference.addEventListener('change', onMotionPreferenceChange)

function createLoaderController() {
  const startedAt = performance.now()
  let actualProgress = 0.01
  let displayProgress = 0
  let previousTime = startedAt
  let frameId = 0
  let isDestroyed = false
  let isDisplayComplete = false
  let resolveDisplayComplete
  const displayComplete = new Promise((resolve) => { resolveDisplayComplete = resolve })
  const brandTween = gsap.to(loaderBrand, { letterSpacing: '0.52em', duration: 3, ease: 'sine.inOut', yoyo: true, repeat: -1 })

  const render = () => {
    const value = actualProgress < 1
      ? Math.min(99, Math.floor(displayProgress * 100))
      : Math.min(100, Math.round(displayProgress * 100))
    loaderPercent.textContent = String(value).padStart(2, '0')
    loaderBar.style.transform = `scaleX(${displayProgress})`
    loaderElement.dataset.progress = String(value)
  }

  const tick = (time) => {
    if (isDestroyed) return
    const delta = Math.min((time - previousTime) / 1000, 0.05)
    previousTime = time
    const response = actualProgress >= 1 ? 8.5 : 4.4
    displayProgress += (actualProgress - displayProgress) * (1 - Math.exp(-response * delta))
    if (actualProgress < 1) displayProgress = Math.min(displayProgress, 0.99)
    if (actualProgress >= 1 && displayProgress > 0.995) displayProgress = 1
    render()

    if (!isDisplayComplete && displayProgress === 1 && time - startedAt >= MINIMUM_LOADER_TIME) {
      isDisplayComplete = true
      resolveDisplayComplete()
    }
    frameId = requestAnimationFrame(tick)
  }
  frameId = requestAnimationFrame(tick)

  return {
    setProgress(value) {
      actualProgress = Math.max(actualProgress, Math.min(Number(value) || 0, 0.995))
    },
    setLabel(value) {
      loaderLabel.textContent = value
    },
    async exit() {
      actualProgress = 1
      await displayComplete
      await new Promise((resolve) => setTimeout(resolve, 190))
      root.classList.add('is-transitioning')
      root.classList.remove('is-loading')
      window.clearTimeout(window.__forgeLoadingFailSafe)

      await new Promise((resolve) => {
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
        gsap.timeline({ onComplete: resolve })
          .to(loaderPercent, { y: -18, autoAlpha: 0, duration: reduced ? 0.15 : 0.34, ease: 'power2.in' })
          .to(loaderLabel, { y: 8, autoAlpha: 0, duration: reduced ? 0.1 : 0.26 }, '<')
          .to(loaderBar, { scaleX: 1, duration: 0.18, ease: 'power1.out' }, 0)
          .to(loaderBrand, { letterSpacing: '0.62em', autoAlpha: 0, duration: reduced ? 0.16 : 0.42, ease: 'power2.in' }, 0.12)
          .to(loaderElement, {
            clipPath: 'inset(0 0 100% 0)',
            duration: reduced ? 0.24 : 0.72,
            ease: 'power3.inOut',
          }, reduced ? 0.18 : 0.32)
      })

      root.classList.remove('is-transitioning')
      root.classList.add('is-ready')
      loaderElement.hidden = true
      brandTween.kill()
    },
    destroy() {
      isDestroyed = true
      cancelAnimationFrame(frameId)
      brandTween.kill()
    },
  }
}

function closeMenu() {
  menuToggle.setAttribute('aria-expanded', 'false')
  header.classList.remove('menu-open')
  document.body.classList.remove('menu-visible')
}

menuToggle.addEventListener('click', () => {
  const isOpen = menuToggle.getAttribute('aria-expanded') === 'true'
  menuToggle.setAttribute('aria-expanded', String(!isOpen))
  header.classList.toggle('menu-open', !isOpen)
  document.body.classList.toggle('menu-visible', !isOpen)
})

navigationLinks.forEach((link) => link.addEventListener('click', closeMenu))
window.addEventListener('scroll', () => header.classList.toggle('is-scrolled', window.scrollY > 24), { passive: true })

function getHeroDestination(progress = 0) {
  return heroTrigger
    ? heroTrigger.start + (heroTrigger.end - heroTrigger.start) * progress
    : window.innerHeight * progress
}

function setActiveChapter(chapter) {
  if (chapter !== 'wielder') gsap.set('.weapon-stage', { autoAlpha: 1 })

  // Chapter timelines own their own content. Once the hero has been left,
  // explicitly clear its persistent layers so a resize/refresh cannot leave
  // THE BLADE REMEMBERS over a later chapter.
  if (chapter !== 'awaken' && chapter !== 'draw') {
    gsap.set([
      '.hero-eyebrow', '.hero-copy', '.hero-actions', '.title-line > span',
      '.scroll-indicator', '.hero-transition', '.blade-memory',
    ], { autoAlpha: 0 })
  }

  chapterLinks.forEach((link) => {
    const active = link.dataset.chapterLink === chapter
    link.classList.toggle('is-active', active)
    if (active) link.setAttribute('aria-current', 'step')
    else link.removeAttribute('aria-current')
  })

  const navigationGroup = {
    awaken: 'home',
    draw: 'home',
    anatomy: 'blade',
    origin: 'origin',
    inscription: 'origin',
    wielder: 'origin',
    legacy: 'legacy',
    finale: 'legacy',
  }[chapter]
  navigationLinks.forEach((link) => {
    if (link.dataset.navGroup === navigationGroup) link.setAttribute('aria-current', 'page')
    else link.removeAttribute('aria-current')
  })
  header.dataset.chapter = chapter
}

chapterRail?.addEventListener('pointermove', (event) => {
  chapterLinks.forEach((link) => {
    const center = link.getBoundingClientRect().top + link.offsetHeight / 2
    const proximity = Math.max(0, 1 - Math.abs(event.clientY - center) / 92)
    link.style.setProperty('--proximity', (proximity * proximity).toFixed(3))
  })
})
chapterRail?.addEventListener('pointerleave', () => {
  chapterLinks.forEach((link) => link.style.removeProperty('--proximity'))
})

document.querySelectorAll('a[href^="#"]:not(.skip-link)').forEach((link) => {
  link.addEventListener('click', (event) => {
    const targetId = link.getAttribute('href')
    if (!targetId || targetId === '#') return
    const target = document.querySelector(targetId)
    if (!target) return
    event.preventDefault()
    closeMenu()
    const progress = Number(link.dataset.progress)
    const chapterLandingRatio = {
      anatomy: 0.08,
      forge: 0.16,
      origin: 0.24,
      inscription: 0.22,
      wielder: 0.035,
      legacy: 0.2,
    }[target.dataset.chapter] ?? 0.1
    const chapterOffset = target.classList.contains('chapter')
      ? Math.min(720, Math.max(0, target.offsetHeight - window.innerHeight) * chapterLandingRatio)
      : 0
    const destination = targetId === '#home'
      ? 0
      : (Number.isFinite(progress) && heroTrigger
          ? getHeroDestination(progress)
          : (chapterOffset ? target.getBoundingClientRect().top + window.scrollY + chapterOffset : target))
    lenis.scrollTo(destination, { duration: 1.45, lock: false, offset: targetId === '#home' ? 0 : -1 })
  })
})

drawButton.addEventListener('click', () => {
  const destination = heroTrigger ? getHeroDestination(0.2) : window.innerHeight * 0.7
  lenis.scrollTo(destination, { duration: 1.25, lock: false })
})

returnButton?.addEventListener('click', () => {
  lenis.scrollTo(getHeroDestination(0.035), { duration: 3.2, lock: false })
})

beginAgainButton?.addEventListener('click', () => {
  lenis.scrollTo(0, { duration: 2.6, lock: false })
})

function createIntro(weapon) {
  const targetScale = weapon.modelPivot.scale.clone()
  const targetY = weapon.modelPivot.position.y
  const timeline = gsap.timeline({ paused: true, defaults: { ease: 'power3.out' } })
  timeline
    .fromTo(weapon.modelPivot.scale,
      { x: targetScale.x * 0.985, y: targetScale.y * 0.985, z: targetScale.z * 0.985 },
      { x: targetScale.x, y: targetScale.y, z: targetScale.z, duration: 2.45, ease: 'power1.out' }, 0.1)
    .fromTo(weapon.modelPivot.position, { y: targetY + 0.08 }, { y: targetY, duration: 2.35, ease: 'power1.out' }, 0.1)
    .to(weapon.lights.engraving, { intensity: weapon.targets.engraving * 0.56, duration: 0.9 }, 0.08)
    .to(weapon.lights.rim, { intensity: weapon.targets.rim * 0.48, duration: 1.15 }, 0.18)
    .to('.scene-curtain', { autoAlpha: 0, duration: 0.82, ease: 'power2.inOut' }, 0.26)
    .from('.brand', { y: -12, autoAlpha: 0, duration: 0.5 }, 0.38)
    .from('.site-nav a', { y: -8, autoAlpha: 0, duration: 0.44, stagger: 0.06 }, 0.5)
    .from('.nav-cta', { y: -8, autoAlpha: 0, duration: 0.44 }, 0.66)
    .to(weapon.lights.key, { intensity: weapon.targets.key * 0.72, duration: 1.4 }, 0.48)
    .to(weapon.lights.fill, { intensity: weapon.targets.fill * 0.8, duration: 1.3 }, 0.54)
    .to(weapon.lights.sheathFill, { intensity: weapon.targets.sheathFill * 0.72, duration: 1.35 }, 0.58)
    .to(weapon.lights.accent, { intensity: weapon.targets.accent * 0.42, duration: 1.2 }, 0.68)
    .to(weapon.lights.ambient, { intensity: weapon.targets.ambient * 0.72, duration: 1.2 }, 0.5)
    .to(weapon.camera.position, { z: 11.02, duration: 2.2, ease: 'power1.out' }, 0.18)
    .from('.hero-eyebrow', { y: 13, autoAlpha: 0, duration: 0.48 }, 0.9)
    .from('.title-line:first-child > span', { yPercent: 112, duration: 0.78 }, 1.04)
    .from('.title-line:last-child > span', { yPercent: 112, duration: 0.78 }, 1.24)
    .from('.hero-copy', { y: 15, autoAlpha: 0, duration: 0.56 }, 1.63)
    .from('.button-primary', { y: 12, autoAlpha: 0, duration: 0.5 }, 1.83)
    .from('.button-secondary', { y: 12, autoAlpha: 0, duration: 0.5 }, 1.95)
    .from('.scroll-indicator', { y: -7, autoAlpha: 0, duration: 0.48 }, 2.2)
  return timeline
}

function createReducedIntro(weapon) {
  const timeline = gsap.timeline({ paused: true, defaults: { ease: 'power1.out' } })
  timeline
    .to('.scene-curtain', { autoAlpha: 0, duration: 0.4 }, 0)
    .to(weapon.lights.rim, { intensity: weapon.targets.rim * 0.48, duration: 0.45 }, 0)
    .to(weapon.lights.engraving, { intensity: weapon.targets.engraving * 0.56, duration: 0.45 }, 0)
    .to(weapon.lights.key, { intensity: weapon.targets.key * 0.72, duration: 0.5 }, 0.05)
    .to(weapon.lights.fill, { intensity: weapon.targets.fill * 0.8, duration: 0.45 }, 0.05)
    .to(weapon.lights.sheathFill, { intensity: weapon.targets.sheathFill * 0.72, duration: 0.45 }, 0.05)
    .to(weapon.lights.accent, { intensity: weapon.targets.accent * 0.42, duration: 0.45 }, 0.05)
    .to(weapon.lights.ambient, { intensity: weapon.targets.ambient * 0.72, duration: 0.4 }, 0)
    .fromTo('.brand, .site-nav a, .nav-cta', { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.24, stagger: 0.025 }, 0.08)
    .fromTo('.hero-eyebrow, .title-line > span, .hero-copy, .hero-actions', { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.28, stagger: 0.035 }, 0.16)
  return timeline
}

function createMasterTimeline(weapon) {
  const baseRotation = {
    x: weapon.modelPivot.rotation.x,
    y: weapon.modelPivot.rotation.y,
    z: weapon.modelPivot.rotation.z,
  }
  const baseScale = weapon.modelPivot.scale.clone()
  const syncExtractionPresentation = () => {
    const reveal = gsap.utils.clamp(0, 1, (weapon.draw.progress - 0.82) / 0.06)
    weapon.setExtractionLighting(weapon.draw.progress)
    gsap.set('.blade-memory', { autoAlpha: reveal })
    gsap.set('.blade-memory__line', {
      clipPath: `inset(${(1 - reveal) * 105}% 0 0 0)`,
      y: 24 * (1 - reveal),
    })
    gsap.set('.blade-memory__note', { autoAlpha: reveal, y: 10 * (1 - reveal) })
  }

  const timeline = gsap.timeline({
    defaults: { ease: 'none' },
    onUpdate: syncExtractionPresentation,
    scrollTrigger: {
      id: 'weapon-cinematic',
      trigger: '.blade-sequence',
      start: 'top top',
      end: '+=6400',
      pin: '.hero',
      pinSpacing: false,
      scrub: 1.05,
      anticipatePin: 1,
      refreshPriority: 10,
      invalidateOnRefresh: true,
      onUpdate: (self) => setActiveChapter(self.progress < 0.1 ? 'awaken' : 'draw'),
      onEnterBack: (self) => setActiveChapter(self.progress < 0.1 ? 'awaken' : 'draw'),
    },
  })

  const drawSegment = (progress, duration, position, ease) => {
    timeline.to(weapon.draw, {
      progress,
      duration,
      ease,
      onUpdate: syncExtractionPresentation,
    }, position)
  }

  timeline
    .to('.scroll-indicator', { autoAlpha: 0, duration: 0.08 }, 0.08)
    .to('.hero-eyebrow', { y: -8, autoAlpha: 0, duration: 0.22, ease: 'power1.inOut' }, 0.18)
    .to('.hero-copy', { y: -12, autoAlpha: 0, duration: 0.28, ease: 'power1.inOut' }, 0.22)
    .to('.hero-actions', { y: -8, autoAlpha: 0, duration: 0.24, ease: 'power1.inOut' }, 0.28)
    .to('.title-line:first-child > span', { y: -12, autoAlpha: 0, letterSpacing: '-0.025em', duration: 0.29, ease: 'power1.inOut' }, 0.36)
    .to('.title-line:last-child > span', { y: -18, autoAlpha: 0, letterSpacing: '-0.02em', duration: 0.27, ease: 'power1.inOut' }, 0.39)
    .to('.hero-atmosphere', { opacity: 0.82, scale: 1.12, duration: 0.64, ease: 'power1.inOut' }, 0.2)
    .to(weapon.cameraMotion, { yaw: THREE_DEGREES(4.2), pitch: THREE_DEGREES(0.65), duration: 0.68, ease: 'power1.inOut' }, 0.12)
    .to(weapon.camera.position, { z: 10.62, x: 0.08, y: 0.05, duration: 0.66, ease: 'power1.inOut' }, 0.16)
    .to(weapon.modelPivot.rotation, { y: baseRotation.y + THREE_DEGREES(3.4), x: baseRotation.x + THREE_DEGREES(0.9), duration: 0.62, ease: 'power1.inOut' }, 0.18)

  drawSegment(0.18, 0.15, 0.1, 'power2.in')
  drawSegment(0.56, 0.35, 0.25, 'power1.inOut')
  drawSegment(0.78, 0.18, 0.6, 'power2.out')
  drawSegment(1, 0.08, 0.78, 'power2.inOut')

  timeline
    .to(weapon.payoff, { progress: 1, duration: 0.14, ease: 'power2.inOut' }, 0.86)
    .to(weapon.sheathMotion, { progress: 1, duration: 0.11, ease: 'power2.in' }, 0.89)
    .to(weapon.modelPivot.position, {
      x: () => (window.innerWidth > 900 ? 0.86 : 0.25),
      y: -3.68,
      duration: 0.14,
      ease: 'power2.inOut',
    }, 0.86)
    .to(weapon.modelPivot.scale, {
      x: baseScale.x * 0.89,
      y: baseScale.y * 0.89,
      z: baseScale.z * 0.89,
      duration: 0.14,
      ease: 'power2.inOut',
    }, 0.86)
    .to(weapon.modelPivot.rotation, {
      y: baseRotation.y + THREE_DEGREES(5.2),
      x: baseRotation.x + THREE_DEGREES(1.25),
      z: baseRotation.z - THREE_DEGREES(1.6),
      duration: 0.14,
      ease: 'power2.inOut',
    }, 0.86)
    .to(weapon.camera.position, { z: 10.38, x: 0.12, y: 0.12, duration: 0.13, ease: 'power1.inOut' }, 0.87)
    .to(weapon.cameraMotion, { yaw: THREE_DEGREES(3.2), pitch: THREE_DEGREES(0.35), duration: 0.13, ease: 'power1.inOut' }, 0.87)
    .to('.hero-transition', { autoAlpha: 0.62, duration: 0.08, ease: 'power2.in' }, 0.92)

  heroTrigger = timeline.scrollTrigger
  syncExtractionPresentation()
  return timeline
}

function THREE_DEGREES(value) {
  return value * (Math.PI / 180)
}

// Adapted from the scroll-world scrub-engine's useful pieces: nearby lazy
// loading and seek coalescing. ScrollTrigger owns progress so Lenis remains
// this experience's only scroll source.
function createWielderController() {
  const section = document.querySelector('.chapter--wielder')
  const stage = document.querySelector('.wielder-stage')
  const dissolve = document.querySelector('.wielder-dissolve')
  const clips = [...document.querySelectorAll('[data-wielder-clip]')].map((element) => ({
    element,
    video: element.querySelector('video'),
    loading: false,
    metadataReady: false,
    dataReady: false,
    drawable: false,
    desiredProgress: 0,
    shouldSeek: false,
    objectUrl: '',
    abortController: undefined,
    paintFrame: 0,
  }))
  const copies = [...document.querySelectorAll('[data-wielder-copy]')]
  const weights = [1, 1, 1, 1, 1, 1, 0.42]
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0)
  let prefetchTrigger
  let latestProgress = 0
  let seekFrame = 0
  let disposed = false

  const resolveSegment = (progress) => {
    const scaled = gsap.utils.clamp(0, 0.999999, progress) * totalWeight
    let offset = 0
    for (let index = 0; index < weights.length; index += 1) {
      const end = offset + weights[index]
      if (scaled < end) return { index, local: (scaled - offset) / weights[index] }
      offset = end
    }
    return { index: weights.length - 1, local: 1 }
  }

  const revealPaintedFrame = (clip) => {
    if (clip.drawable || !clip.dataReady) return
    clip.drawable = true
    clip.element.classList.add('is-ready')
    clip.video.removeAttribute('poster')
  }

  const schedulePaintReveal = (clip) => {
    if (clip.drawable || clip.paintFrame) return
    const reveal = () => {
      clip.paintFrame = requestAnimationFrame(() => {
        clip.paintFrame = 0
        revealPaintedFrame(clip)
      })
    }
    if (typeof clip.video.requestVideoFrameCallback === 'function') {
      clip.video.requestVideoFrameCallback(reveal)
      window.setTimeout(() => { if (!clip.drawable) reveal() }, 180)
    } else {
      reveal()
    }
  }

  const load = async (index) => {
    const clip = clips[index]
    if (!clip || clip.metadataReady || clip.loading || disposed) return
    clip.loading = true
    const { video } = clip
    clip.abortController = new AbortController()

    video.addEventListener('loadedmetadata', () => {
      clip.metadataReady = Number.isFinite(video.duration) && video.duration > 0
      clip.loading = false
    }, { once: true })
    video.addEventListener('loadeddata', () => {
      clip.dataReady = true
      video.pause()
      if (clip.shouldSeek && Math.abs(video.currentTime) < 0.018 && clip.desiredProgress < 0.002) {
        schedulePaintReveal(clip)
      }
    }, { once: true })
    video.addEventListener('seeked', () => schedulePaintReveal(clip))
    video.addEventListener('error', () => {
      clip.loading = false
      clip.element.classList.add('has-error')
    }, { once: true })

    try {
      const response = await fetch(video.dataset.src, {
        cache: 'force-cache',
        signal: clip.abortController.signal,
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const blob = await response.blob()
      if (!blob.type.startsWith('video/')) throw new Error(`Unexpected MIME type: ${blob.type || 'unknown'}`)
      clip.objectUrl = URL.createObjectURL(blob)
      video.preload = 'auto'
      video.src = clip.objectUrl
      video.load()
    } catch (error) {
      clip.loading = false
      if (error.name !== 'AbortError') {
        clip.element.classList.add('has-error')
        console.error(`[WIELDER] Unable to load ${video.dataset.src}`, error)
      }
    }
  }

  const pumpSeeks = () => {
    if (disposed) return
    clips.forEach((clip) => {
      const { video } = clip
      if (!clip.shouldSeek || !clip.metadataReady || video.seeking || !Number.isFinite(video.duration)) return
      const maximum = Math.max(0, video.duration - (1 / 24))
      const target = gsap.utils.clamp(0, maximum, clip.desiredProgress * video.duration)
      if (Math.abs(video.currentTime - target) <= 0.018) {
        if (clip.dataReady) schedulePaintReveal(clip)
        return
      }
      try { video.currentTime = target } catch { /* metadata can briefly invalidate during source attach */ }
    })
    seekFrame = requestAnimationFrame(pumpSeeks)
  }

  const updateCopies = (segment) => {
    const ranges = [
      [0, 0.05, 0.4], [0, 0.48, 0.86], [1, 0.2, 0.8], [2, 0.2, 0.8],
      [3, 0.2, 0.8], [4, 0.2, 0.8], [5, 0.26, 0.84],
    ]
    copies.forEach((copy, copyIndex) => {
      const [clipIndex, start, end] = ranges[copyIndex]
      const local = segment.index === clipIndex ? segment.local : -1
      const fade = 0.12
      const opacity = local < start || local > end
        ? 0
        : Math.min(1, (local - start) / fade, (end - local) / fade)
      copy.style.opacity = opacity.toFixed(3)
      copy.style.transform = `translateY(${((0.5 - Math.max(0, local)) * 18).toFixed(1)}px)`
    })
  }

  const setProgress = (progress) => {
    latestProgress = gsap.utils.clamp(0, 1, progress)
    const segment = resolveSegment(latestProgress)
    const seamOverlap = 0.08
    const memoryOverlap = 0.26
    const smoothstep = (value) => {
      const t = gsap.utils.clamp(0, 1, value)
      return t * t * (3 - 2 * t)
    }
    const scrollPosition = getCurrentScrollPosition()
    const withinLoadRange = scrollPosition > section.offsetTop - window.innerHeight * 2.2
      && scrollPosition < section.offsetTop + section.offsetHeight + window.innerHeight

    clips.forEach((clip, index) => {
      let opacity = index === segment.index ? 1 : 0
      if (segment.index > 0 && segment.index < 6 && segment.local < seamOverlap) {
        const incoming = smoothstep(segment.local / seamOverlap)
        if (index === segment.index) opacity = incoming
        if (index === segment.index - 1) opacity = 1 - incoming
      }
      if (segment.index === 6 && segment.local < memoryOverlap) {
        const incoming = smoothstep(segment.local / memoryOverlap)
        if (index === 6) opacity = incoming
        if (index === 5) opacity = 1 - incoming
      }
      clip.element.style.opacity = opacity.toFixed(3)
      clip.shouldSeek = opacity > 0.001 || Math.abs(index - segment.index) <= 1
      clip.desiredProgress = index === segment.index ? segment.local : (index < segment.index ? 0.999 : 0)
      if (withinLoadRange && clip.shouldSeek) {
        void load(index)
      }
    })

    updateCopies(segment)
    let blackout = 0
    let handoff = 0
    let stageOpacity = 1
    if (segment.index === 0 && segment.local < 0.14) {
      blackout = smoothstep((0.14 - segment.local) / 0.14) * 0.9
    }
    if (segment.index === 5 && segment.local > 0.86) {
      blackout = gsap.utils.clamp(0, 0.94, (segment.local - 0.86) / 0.14 * 0.94)
    }
    if (segment.index === 6) {
      const tailEntry = smoothstep(segment.local / memoryOverlap)
      handoff = smoothstep((segment.local - 0.77) / 0.22)
      const entryBlack = (1 - tailEntry) * 0.94
      const handoffBlack = Math.sin(handoff * Math.PI) * 0.48
      blackout = Math.max(entryBlack, handoffBlack)
      stageOpacity = 1 - handoff
    }
    stage.style.opacity = stageOpacity.toFixed(3)
    stage.style.visibility = stageOpacity <= 0.001 ? 'hidden' : 'visible'
    dissolve.style.opacity = blackout.toFixed(3)
    // Timelines are also rendered at progress 0 during refreshes. Only alter
    // the persistent WebGL stage while this chapter actually owns the viewport.
    const ownsViewport = scrollPosition >= section.offsetTop
      && scrollPosition <= section.offsetTop + section.offsetHeight - window.innerHeight + 1
    if (ownsViewport) gsap.set('.weapon-stage', { autoAlpha: handoff })
  }

  const onMotionChange = () => setProgress(latestProgress)
  motionPreference.addEventListener('change', onMotionChange)
  seekFrame = requestAnimationFrame(pumpSeeks)

  return {
    section,
    setProgress,
    installPrefetch() {
      prefetchTrigger?.kill()
      prefetchTrigger = ScrollTrigger.create({
        trigger: section,
        start: 'top bottom+=120%',
        once: true,
        onEnter: () => { void load(0); void load(1) },
      })
    },
    destroyPrefetch() {
      prefetchTrigger?.kill()
      prefetchTrigger = undefined
    },
    refresh() {
      setProgress(latestProgress)
    },
    dispose() {
      disposed = true
      prefetchTrigger?.kill()
      cancelAnimationFrame(seekFrame)
      motionPreference.removeEventListener('change', onMotionChange)
      clips.forEach((clip) => {
        clip.abortController?.abort()
        if (clip.paintFrame) cancelAnimationFrame(clip.paintFrame)
        clip.video.pause()
        clip.video.removeAttribute('src')
        clip.video.load()
        if (clip.objectUrl) URL.revokeObjectURL(clip.objectUrl)
      })
    },
  }
}

function createChapterExperience(weapon) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const motion = reduced ? 0.32 : 1
  const chapterTimelines = []
  wielderController ??= createWielderController()
  wielderController.installPrefetch()

  const createTimeline = (selector, chapter, previous) => {
    const section = document.querySelector(selector)
    const timeline = gsap.timeline({
      defaults: { ease: 'none' },
      scrollTrigger: {
        id: `chapter-${chapter}`,
        trigger: section,
        start: () => section.offsetTop,
        end: () => section.offsetTop + section.offsetHeight - window.innerHeight,
        scrub: reduced ? 0.18 : 1.05,
        invalidateOnRefresh: true,
        onEnter: () => setActiveChapter(chapter),
        onEnterBack: () => setActiveChapter(chapter),
        onLeaveBack: () => setActiveChapter(previous),
      },
    })
    chapterTimelines.push(timeline)
    return timeline
  }

  // One deterministic initial state for all chapter-owned DOM and 3D values.
  gsap.set([
    '.anatomy-intro', '.anatomy-stage', '.forge-body', '.forge-caption',
    '.origin-heading', '.origin-copy p', '.inscription-heading', '.archive-specs',
    '.legacy-frame > .archive-label', '.legacy-frame h2 > *', '.legacy-copy p',
    '.finale-inner > *',
  ], { autoAlpha: 0 })
  gsap.set('.masked-heading span', { clipPath: 'inset(100% 0 0)', '--mask-shift': '0%' })
  gsap.set('.inscription-words span', { autoAlpha: 0, clipPath: 'inset(100% 0 0)' })
  gsap.set('.inscription-heading, .inscription-words, .archive-specs', { filter: 'blur(0px)' })
  gsap.set('.annotation-line i, .origin-rule, .inscription-rule, .legacy-rule', { scaleX: 0, scaleY: 0 })
  weapon.chapterPivot.position.set(0, 0, 0)
  weapon.chapterPivot.rotation.set(0, 0, 0)
  weapon.chapterPivot.scale.setScalar(1)
  weapon.chapterCameraRig.position.set(0, 0, 0)
  weapon.chapterCameraRig.rotation.set(0, 0, 0)
  weapon.chapterMatch.progress = 0
  Object.assign(weapon.waveState, { opacity: 0, brightness: 0.7, amplitude: 1.7, speed: 0.2, turbulence: 0.14 })
  weapon.emberState.opacity = 0

  const anatomy = createTimeline('.chapter--anatomy', 'anatomy', 'draw')
  anatomy
    .to('.blade-memory', { autoAlpha: 0, y: -18, duration: 0.045, ease: 'power2.in' }, 0)
    .to('.blade-memory__line', { clipPath: 'inset(100% 0 0 0)', y: -24, duration: 0.045, ease: 'power2.in' }, 0)
    .to('.anatomy-intro', { autoAlpha: 1, y: 0, duration: 0.075, ease: 'power2.out' }, 0.105)
    .fromTo('.anatomy-intro', { y: 26 }, { y: 0, duration: 0.075, ease: 'power2.out' }, 0.105)
    .to('.anatomy-intro', { autoAlpha: 0, y: -22, duration: 0.07, ease: 'power1.in' }, 0.19)
    .to(weapon.chapterPivot.position, { x: 0.34 * motion, y: 0.8 * motion, duration: 0.28, ease: 'power2.inOut' }, 0.05)
    .to(weapon.chapterPivot.scale, { x: 1.48, y: 1.48, z: 1.48, duration: 0.28, ease: 'power2.inOut' }, 0.05)
    .to(weapon.chapterPivot.rotation, { y: THREE_DEGREES(-2.4 * motion), z: THREE_DEGREES(1.2 * motion), duration: 0.28, ease: 'power2.inOut' }, 0.05)
    .to(weapon.chapterCameraRig.position, { x: -0.12 * motion, y: -0.26 * motion, z: -1.72, duration: 0.28, ease: 'power2.inOut' }, 0.05)
    .to(weapon.chapterCameraRig.rotation, { y: THREE_DEGREES(1.8 * motion), x: THREE_DEGREES(-0.65 * motion), duration: 0.28 }, 0.05)
    .to(weapon.lights.key.color, { r: 0.78, g: 0.84, b: 0.9, duration: 0.28 }, 0.05)
    .to(weapon.lights.bladeSweep, { intensity: weapon.targets.bladeSweep * 0.58, duration: 0.28 }, 0.05)
    .to('.anatomy-stage--edge', { autoAlpha: 1, y: 0, duration: 0.07, ease: 'power2.out' }, 0.17)
    .fromTo('.anatomy-stage--edge', { y: 28 }, { y: 0, duration: 0.07, ease: 'power2.out' }, 0.17)
    .to('.anatomy-stage--edge .annotation-line i', { scaleX: 1, scaleY: 1, duration: 0.09, ease: 'power1.out' }, 0.2)
    .to('.anatomy-stage--edge', { autoAlpha: 0, y: -16, duration: 0.06 }, 0.32)
    .to(weapon.chapterPivot.position, { x: -0.72 * motion, y: -0.34 * motion, duration: 0.3, ease: 'power2.inOut' }, 0.31)
    .to(weapon.chapterPivot.scale, { x: 1.58, y: 1.58, z: 1.58, duration: 0.3, ease: 'power2.inOut' }, 0.31)
    .to(weapon.chapterPivot.rotation, { y: THREE_DEGREES(2.7 * motion), z: THREE_DEGREES(-0.8 * motion), duration: 0.3, ease: 'power2.inOut' }, 0.31)
    .to(weapon.chapterCameraRig.position, { x: 0.22 * motion, y: 0.42 * motion, z: -2.12, duration: 0.3, ease: 'power2.inOut' }, 0.31)
    .to(weapon.lights.key.color, { r: 0.84, g: 0.77, b: 0.68, duration: 0.3 }, 0.31)
    .to(weapon.lights.accent, { intensity: weapon.targets.accent * 0.88, duration: 0.3 }, 0.31)
    .to('.anatomy-stage--guard', { autoAlpha: 1, y: 0, duration: 0.07, ease: 'power2.out' }, 0.39)
    .fromTo('.anatomy-stage--guard', { y: 24 }, { y: 0, duration: 0.07, ease: 'power2.out' }, 0.39)
    .to('.anatomy-stage--guard .annotation-line i', { scaleX: 1, scaleY: 1, duration: 0.09 }, 0.42)
    .to('.anatomy-stage--guard', { autoAlpha: 0, y: -14, duration: 0.06 }, 0.58)
    .to(weapon.chapterPivot.position, { x: 0.58 * motion, y: -1.1 * motion, duration: 0.28, ease: 'power2.inOut' }, 0.57)
    .to(weapon.chapterPivot.scale, { x: 1.52, y: 1.52, z: 1.52, duration: 0.28, ease: 'power2.inOut' }, 0.57)
    .to(weapon.chapterPivot.rotation, { y: THREE_DEGREES(4.2 * motion), z: THREE_DEGREES(0.6 * motion), duration: 0.28, ease: 'power2.inOut' }, 0.57)
    .to(weapon.chapterCameraRig.position, { x: -0.08 * motion, y: 0.62 * motion, z: -1.9, duration: 0.28, ease: 'power2.inOut' }, 0.57)
    .to(weapon.lights.key.color, { r: 0.8, g: 0.85, b: 0.9, duration: 0.28 }, 0.57)
    .to(weapon.lights.engraving, { intensity: weapon.targets.engraving * 1.16, duration: 0.28 }, 0.57)
    .to('.anatomy-stage--grip', { autoAlpha: 1, y: 0, duration: 0.07, ease: 'power2.out' }, 0.64)
    .fromTo('.anatomy-stage--grip', { y: 25 }, { y: 0, duration: 0.07, ease: 'power2.out' }, 0.64)
    .to('.anatomy-stage--grip .annotation-line i', { scaleX: 1, scaleY: 1, duration: 0.09 }, 0.68)
    .to('.anatomy-stage--grip', { autoAlpha: 0, y: -16, duration: 0.07 }, 0.84)
    .to(weapon.chapterPivot.position, { x: 0.25 * motion, y: -0.25 * motion, duration: 0.16, ease: 'power2.inOut' }, 0.84)
    .to(weapon.chapterPivot.scale, { x: 0.98, y: 0.98, z: 0.98, duration: 0.16, ease: 'power2.inOut' }, 0.84)
    .to(weapon.chapterPivot.rotation, { x: 0, y: 0, z: 0, duration: 0.16, ease: 'power2.inOut' }, 0.84)
    .to(weapon.chapterCameraRig.position, { x: 0, y: 0, z: 0, duration: 0.16, ease: 'power2.inOut' }, 0.84)
    .to(weapon.chapterCameraRig.rotation, { x: 0, y: 0, z: 0, duration: 0.16 }, 0.84)
    .to(weapon.lights.key.color, { r: 0.86, g: 0.89, b: 0.91, duration: 0.16 }, 0.84)
    .to(weapon.lights.accent, { intensity: weapon.targets.accent * 0.52, duration: 0.16 }, 0.84)
    .to(weapon.lights.rim, { intensity: weapon.targets.rim * 1.08, duration: 0.62 }, 0.18)
    .to(weapon.lights.engraving, { intensity: weapon.targets.engraving * 1.02, duration: 0.62 }, 0.18)

  const forge = createTimeline('.chapter--forge', 'forge', 'anatomy')
  forge
    .to(weapon.chapterPivot.position, { x: 0.92 * motion, y: -0.55 * motion, duration: 0.54, ease: 'power1.inOut' }, 0)
    .to(weapon.chapterPivot.scale, { x: 1.08, y: 1.08, z: 1.08, duration: 0.54, ease: 'power1.inOut' }, 0)
    .to(weapon.chapterPivot.rotation, { y: THREE_DEGREES(-3.2 * motion), z: THREE_DEGREES(1.4 * motion), duration: 0.54, ease: 'power1.inOut' }, 0)
    .to(weapon.chapterCameraRig.position, { x: -0.08 * motion, y: -0.08 * motion, z: -0.72, duration: 0.54, ease: 'power1.inOut' }, 0)
    .to(weapon.chapterCameraRig.rotation, { y: THREE_DEGREES(-2.5 * motion), x: THREE_DEGREES(0.5 * motion), duration: 0.54 }, 0)
    .to(weapon.waveState, { opacity: 0.78, brightness: 0.88, amplitude: 2.42, turbulence: 0.2, duration: 0.22, ease: 'power2.out' }, 0.03)
    .to(weapon.emberState, { opacity: reduced ? 0 : 0.64, duration: 0.18, ease: 'power2.out' }, 0.08)
    .to('.masked-heading span', { clipPath: 'inset(0% 0 0)', duration: 0.16, stagger: 0.06, ease: 'power3.out' }, 0.08)
    .to('.masked-heading span', { '--mask-shift': '100%', duration: 0.65, ease: 'sine.inOut' }, 0.12)
    .to('.forge-body', { autoAlpha: 1, y: 0, duration: 0.13, ease: 'power2.out' }, 0.26)
    .fromTo('.forge-body', { y: 24 }, { y: 0, duration: 0.13, ease: 'power2.out' }, 0.26)
    .to('.forge-caption', { autoAlpha: 1, duration: 0.12 }, 0.31)
    .to(weapon.lights.key.color, { r: 0.82, g: 0.68, b: 0.55, duration: 0.3 }, 0.06)
    .to(weapon.lights.accent, { intensity: weapon.targets.accent * 1.34, duration: 0.34 }, 0.07)
    .to(weapon.lights.key, { intensity: weapon.targets.key * 1.13, duration: 0.34 }, 0.07)
    .to(weapon.chapterPivot.rotation, { y: THREE_DEGREES(2.2 * motion), z: THREE_DEGREES(-1.1 * motion), duration: 0.42, ease: 'sine.inOut' }, 0.5)
    .to(weapon.waveState, { opacity: 0.08, brightness: 0.7, duration: 0.2, ease: 'power2.in' }, 0.8)
    .to(weapon.emberState, { opacity: 0, duration: 0.18, ease: 'power2.in' }, 0.78)
    .to('.forge-body, .forge-caption', { autoAlpha: 0, y: -12, duration: 0.12 }, 0.82)
    .to('.masked-heading span', { autoAlpha: 0, duration: 0.12 }, 0.86)

  const origin = createTimeline('.chapter--origin', 'origin', 'forge')
  origin
    .to(weapon.waveState, { opacity: 0, duration: 0.12 }, 0)
    .to(weapon.chapterPivot.position, { x: 1.48 * motion, y: -0.18 * motion, duration: 0.7, ease: 'power1.inOut' }, 0)
    .to(weapon.chapterPivot.scale, { x: 0.86, y: 0.86, z: 0.86, duration: 0.7, ease: 'power1.inOut' }, 0)
    .to(weapon.chapterPivot.rotation, { y: THREE_DEGREES(4.8 * motion), z: THREE_DEGREES(-2.1 * motion), duration: 0.7, ease: 'power1.inOut' }, 0)
    .to(weapon.chapterCameraRig.position, { x: -0.24 * motion, y: 0.08 * motion, z: 0.72, duration: 0.7, ease: 'power1.inOut' }, 0)
    .to(weapon.chapterCameraRig.rotation, { y: THREE_DEGREES(2.8 * motion), x: THREE_DEGREES(-0.7 * motion), duration: 0.7 }, 0)
    .to(weapon.lights.key.color, { r: 0.82, g: 0.86, b: 0.89, duration: 0.24 }, 0)
    .to(weapon.lights.accent, { intensity: weapon.targets.accent * 0.58, duration: 0.28 }, 0)
    .to('.origin-heading', { autoAlpha: 1, y: 0, duration: 0.16, ease: 'power2.out' }, 0.06)
    .fromTo('.origin-heading', { y: 30 }, { y: 0, duration: 0.16, ease: 'power2.out' }, 0.06)
    .to('.origin-rule--vertical', { scaleY: 1, scaleX: 1, duration: 0.34, ease: 'power1.out' }, 0.14)
    .to('.origin-rule--horizontal', { scaleX: 1, scaleY: 1, duration: 0.34, ease: 'power1.out' }, 0.28)
    .to('.origin-copy p', { autoAlpha: 1, y: 0, duration: 0.12, stagger: 0.08, ease: 'power2.out' }, 0.42)
    .fromTo('.origin-copy p', { y: 18 }, { y: 0, duration: 0.12, stagger: 0.08, ease: 'power2.out' }, 0.42)

  const inscription = createTimeline('.chapter--inscription', 'inscription', 'origin')
  inscription
    .to(weapon.chapterPivot.position, { x: 1.05 * motion, y: -1.18 * motion, duration: 0.72, ease: 'power2.inOut' }, 0)
    .to(weapon.chapterPivot.scale, { x: 1.24, y: 1.24, z: 1.24, duration: 0.72, ease: 'power2.inOut' }, 0)
    .to(weapon.chapterPivot.rotation, { y: THREE_DEGREES(-2.4 * motion), z: THREE_DEGREES(3.2 * motion), duration: 0.72, ease: 'power2.inOut' }, 0)
    .to(weapon.chapterCameraRig.position, { x: 0.16 * motion, y: 0.16 * motion, z: -1.62, duration: 0.72, ease: 'power2.inOut' }, 0)
    .to(weapon.chapterCameraRig.rotation, { y: THREE_DEGREES(-3.4 * motion), x: THREE_DEGREES(0.9 * motion), duration: 0.72 }, 0)
    .to('.inscription-heading', { autoAlpha: 1, y: 0, duration: 0.14, ease: 'power2.out' }, 0.06)
    .fromTo('.inscription-heading', { y: 24 }, { y: 0, duration: 0.14, ease: 'power2.out' }, 0.06)
    .to('.inscription-rule', { scaleY: 1, scaleX: 1, duration: 0.35, ease: 'power1.out' }, 0.12)
    .to('.inscription-words span:nth-child(1)', { autoAlpha: 1, clipPath: 'inset(0% 0 0)', duration: 0.12, ease: 'power3.out' }, 0.22)
    .to('.inscription-words span:nth-child(2)', { autoAlpha: 1, clipPath: 'inset(0% 0 0)', duration: 0.12, ease: 'power3.out' }, 0.5)
    .to('.inscription-words span:nth-child(3)', { autoAlpha: 1, clipPath: 'inset(0% 0 0)', duration: 0.14, ease: 'power3.out' }, 0.64)
    .to(weapon.chapterCameraRig.rotation, { z: THREE_DEGREES(1.1 * motion), duration: 0.12 }, 0.22)
    .to(weapon.chapterCameraRig.rotation, { z: THREE_DEGREES(-1.1 * motion), duration: 0.12 }, 0.5)
    .to(weapon.chapterCameraRig.rotation, { z: 0, duration: 0.14 }, 0.64)
    .to('.archive-specs', { autoAlpha: 1, duration: 0.12 }, 0.67)
    .to(weapon.lights.engraving, { intensity: weapon.targets.engraving * 1.25, duration: 0.42 }, 0.16)
    .to(weapon.lights.bladeSweep, { intensity: weapon.targets.bladeSweep * 0.34, duration: 0.4 }, 0.24)
    .to('.inscription-heading, .inscription-words, .archive-specs', {
      autoAlpha: 0,
      y: -20,
      filter: 'blur(4px)',
      duration: 0.1,
      ease: 'power2.in',
    }, 0.88)
    .to('.inscription-rule', { autoAlpha: 0, duration: 0.08 }, 0.9)
    .to('.weapon-stage', { autoAlpha: 0, duration: 0.1, ease: 'power2.in' }, 0.9)

  const wielderProgress = { value: 0 }
  const wielderMatch = {
    x: 0.18,
    y: 1.68,
    scale: 1.45,
    rotationY: THREE_DEGREES(1.75),
    rotationZ: THREE_DEGREES(82),
    cameraX: -0.03,
    cameraY: 0.02,
    cameraZ: -0.96,
    cameraRotationY: THREE_DEGREES(1.85),
    cameraRotationX: THREE_DEGREES(-0.16),
  }
  const wielder = createTimeline('.chapter--wielder', 'wielder', 'inscription')
  wielder
    .to(wielderProgress, {
      value: 1,
      duration: 1,
      onUpdate: () => wielderController.setProgress(wielderProgress.value),
    }, 0)
    // Presentation-only handoff: the extraction rig itself is never touched.
    .to(weapon.chapterPivot.position, { x: wielderMatch.x, y: wielderMatch.y, duration: 0.015 }, 0.97)
    .to(weapon.chapterPivot.scale, { x: wielderMatch.scale, y: wielderMatch.scale, z: wielderMatch.scale, duration: 0.015 }, 0.97)
    .to(weapon.chapterPivot.rotation, { y: wielderMatch.rotationY, z: wielderMatch.rotationZ, duration: 0.015 }, 0.97)
    .to(weapon.chapterCameraRig.position, { x: wielderMatch.cameraX, y: wielderMatch.cameraY, z: wielderMatch.cameraZ, duration: 0.015 }, 0.97)
    .to(weapon.chapterCameraRig.rotation, { y: wielderMatch.cameraRotationY, x: wielderMatch.cameraRotationX, duration: 0.015 }, 0.97)
    .to(weapon.chapterMatch, { progress: 1, duration: 0.015 }, 0.97)
    .to(weapon.lights.key.color, { r: 0.68, g: 0.76, b: 0.86, duration: 0.015 }, 0.97)
    .to(weapon.lights.rim, { intensity: weapon.targets.rim * 1.28, duration: 0.015 }, 0.97)
    .to(weapon.lights.key, { intensity: weapon.targets.key * 1.05, duration: 0.015 }, 0.97)
    .to(weapon.lights.accent, { intensity: weapon.targets.accent * 0.72, duration: 0.015 }, 0.97)
    .to(weapon.lights.sheathFill, { intensity: weapon.targets.sheathFill * 0.24, duration: 0.015 }, 0.97)

  const legacy = createTimeline('.chapter--legacy', 'legacy', 'wielder')
  legacy
    .fromTo(weapon.chapterMatch,
      { progress: 1 },
      { progress: 0, duration: 0.34, ease: 'power1.inOut', immediateRender: false }, 0)
    .fromTo(weapon.lights.sheathFill,
      { intensity: weapon.targets.sheathFill * 0.24 },
      { intensity: weapon.targets.sheathFill * 0.52, duration: 0.34, ease: 'power1.inOut', immediateRender: false }, 0)
    .fromTo(weapon.chapterPivot.position,
      { x: wielderMatch.x, y: wielderMatch.y },
      { x: 0.54 * motion, y: -0.7 * motion, duration: 0.76, ease: 'power1.inOut', immediateRender: false }, 0)
    .fromTo(weapon.chapterPivot.scale,
      { x: wielderMatch.scale, y: wielderMatch.scale, z: wielderMatch.scale },
      { x: 1.28, y: 1.28, z: 1.28, duration: 0.76, ease: 'power1.inOut', immediateRender: false }, 0)
    .fromTo(weapon.chapterPivot.rotation,
      { y: wielderMatch.rotationY, z: wielderMatch.rotationZ },
      { y: THREE_DEGREES(5.5 * motion), z: THREE_DEGREES(-1.8 * motion), duration: 0.76, ease: 'power1.inOut', immediateRender: false }, 0)
    .fromTo(weapon.chapterCameraRig.position,
      { x: wielderMatch.cameraX, y: wielderMatch.cameraY, z: wielderMatch.cameraZ },
      { x: -0.1 * motion, y: 0.06 * motion, z: -0.96, duration: 0.76, ease: 'power1.inOut', immediateRender: false }, 0)
    .fromTo(weapon.chapterCameraRig.rotation,
      { y: wielderMatch.cameraRotationY, x: wielderMatch.cameraRotationX },
      { y: THREE_DEGREES(5.8 * motion), x: THREE_DEGREES(-0.5 * motion), duration: 0.76, ease: 'sine.inOut', immediateRender: false }, 0)
    .to('.legacy-frame > .archive-label', { autoAlpha: 1, duration: 0.1 }, 0.05)
    .to('.legacy-frame h2 span', { autoAlpha: 1, y: 0, duration: 0.12, stagger: 0.08, ease: 'power2.out' }, 0.12)
    .fromTo('.legacy-frame h2 span', { y: 30 }, { y: 0, duration: 0.12, stagger: 0.08, ease: 'power2.out' }, 0.12)
    .to('.legacy-frame h2 em', { autoAlpha: 1, y: 0, duration: 0.16, stagger: 0.12, ease: 'power2.out' }, 0.46)
    .fromTo('.legacy-frame h2 em', { y: 34 }, { y: 0, duration: 0.16, stagger: 0.12, ease: 'power2.out' }, 0.46)
    .to('.legacy-rule', { scaleX: 1, scaleY: 1, duration: 0.34, ease: 'power1.out' }, 0.5)
    .to('.legacy-copy p', { autoAlpha: 1, duration: 0.1, stagger: 0.07 }, 0.58)
    .to(weapon.lights.rim, { intensity: weapon.targets.rim * 1.28, duration: 0.5 }, 0.18)
    .to(weapon.lights.key.color, { r: 0.86, g: 0.89, b: 0.91, duration: 0.4 }, 0.12)
    .to(weapon.lights.key, { intensity: weapon.targets.key * 1.05, duration: 0.5 }, 0.18)
    .to(weapon.lights.accent, { intensity: weapon.targets.accent * 0.72, duration: 0.45 }, 0.18)
    .to('.legacy-frame > .archive-label, .legacy-frame h2 > *, .legacy-copy p', {
      autoAlpha: 0,
      y: -18,
      duration: 0.1,
      ease: 'power2.in',
    }, 0.84)
    .to('.legacy-rule', { autoAlpha: 0, duration: 0.08, ease: 'power1.in' }, 0.86)

  const finaleSection = document.querySelector('.finale')
  const finale = gsap.timeline({
    defaults: { ease: 'none' },
    scrollTrigger: {
      id: 'chapter-finale',
      trigger: finaleSection,
      start: () => finaleSection.offsetTop - window.innerHeight * 0.82,
      end: () => finaleSection.offsetTop + finaleSection.offsetHeight - window.innerHeight,
      scrub: reduced ? 0.18 : 0.9,
      onEnter: () => setActiveChapter('finale'),
      onEnterBack: () => setActiveChapter('finale'),
      onLeaveBack: () => setActiveChapter('legacy'),
    },
  })
  finale
    .to(weapon.chapterPivot.position, { x: 0.82 * motion, y: -0.72 * motion, duration: 1, ease: 'power1.inOut' }, 0)
    .to(weapon.chapterPivot.scale, { x: 1.08, y: 1.08, z: 1.08, duration: 1, ease: 'power1.inOut' }, 0)
    .to(weapon.chapterCameraRig.position, { x: 0, y: 0, z: -0.36, duration: 1, ease: 'power1.inOut' }, 0)
    .to(weapon.chapterCameraRig.rotation, { x: 0, y: 0, z: 0, duration: 1 }, 0)
    .to('.finale-inner > *', { autoAlpha: 1, y: 0, duration: 0.28, stagger: 0.08, ease: 'power2.out' }, 0.12)
    .fromTo('.finale-inner > *', { y: 28 }, { y: 0, duration: 0.28, stagger: 0.08, ease: 'power2.out' }, 0.12)
  chapterTimelines.push(finale)

  return chapterTimelines
}

function setupExperience(weapon) {
  const restingRotation = weapon.restingTransform.rotation.clone()
  const restingScale = weapon.restingTransform.scale.clone()
  const resetCinematicState = () => {
    gsap.set([
      '.hero-content', '.hero-eyebrow', '.hero-copy', '.hero-actions', '.title-line > span',
      '.scroll-indicator', '.hero-atmosphere', '.hero-transition', '.blade-memory',
      '.blade-memory__line', '.blade-memory__note', '.weapon-stage',
    ], { clearProps: 'all' })
    weapon.draw.progress = 0
    weapon.sheathMotion.progress = 0
    weapon.payoff.progress = 0
    weapon.cameraMotion.yaw = 0
    weapon.cameraMotion.pitch = 0
    weapon.camera.position.set(0, 0, 11.5)
    weapon.modelPivot.position.set(getHeroRestingX(), -1.35, 0)
    weapon.modelPivot.rotation.copy(restingRotation)
    weapon.modelPivot.scale.copy(restingScale)
  }

  const media = gsap.matchMedia()
  activeMedia = media
  media.add('(prefers-reduced-motion: no-preference)', () => {
    resetCinematicState()
    Object.values(weapon.lights).forEach((light) => { light.intensity = 0 })
    introTimeline = createIntro(weapon)
    if (experienceStarted) introTimeline.progress(1)
    return () => { introTimeline.kill() }
  })

  media.add('(prefers-reduced-motion: reduce)', () => {
    resetCinematicState()
    gsap.set('.blade-memory', { autoAlpha: 0 })
    Object.values(weapon.lights).forEach((light) => { light.intensity = 0 })
    weapon.camera.position.set(0, 0, 10.82)
    introTimeline = createReducedIntro(weapon)
    if (experienceStarted) introTimeline.progress(1)
    return () => { introTimeline.kill() }
  })

  return () => {
    activeMaster = createMasterTimeline(weapon)
    activeChapters = createChapterExperience(weapon)
  }
}

function showStaticChapters() {
  gsap.set([
    '.anatomy-intro', '.forge-body', '.origin-heading', '.origin-copy p',
    '.inscription-heading', '.inscription-words span', '.legacy-frame > .archive-label',
    '.legacy-frame h2 > *', '.legacy-copy p', '.finale-inner > *', '.wielder-copy',
  ], { autoAlpha: 1, y: 0, clipPath: 'none' })
  gsap.set('.wielder-stage', { autoAlpha: 1 })
  gsap.set('.wielder-clip:first-child', { autoAlpha: 1 })
  gsap.set('.masked-heading span', { clipPath: 'none' })
  gsap.set('.annotation-line i, .origin-rule, .inscription-rule, .legacy-rule', { scaleX: 1, scaleY: 1 })
}

async function boot() {
  window.clearTimeout(window.__forgeLoadingFailSafe)
  const loading = createLoaderController()
  activeLoader = loading
  let glbProgress = 0
  let fontsReady = document.fonts?.status === 'loaded' ? 1 : 0
  const updateLoadingProgress = () => loading.setProgress(0.02 + glbProgress * 0.91 + fontsReady * 0.04)
  const fontPromise = document.fonts?.ready
    ? document.fonts.ready.catch(() => null).then(() => { fontsReady = 1; updateLoadingProgress() })
    : Promise.resolve().then(() => { fontsReady = 1; updateLoadingProgress() })

  try {
    const weapon = await createWeaponScene(canvas, {
      onProgress: ({ loaded, ratio }) => {
        const measuredRatio = ratio ?? Math.min(0.96, loaded / MODEL_EXPECTED_BYTES)
        glbProgress = Math.max(glbProgress, Math.min(1, measuredRatio || 0))
        updateLoadingProgress()
      },
    })
    activeWeapon = weapon
    document.body.classList.add('webgl-ready')
    loading.setProgress(0.98)
    await fontPromise
    const activateScrollExperience = setupExperience(weapon)
    // Browsers restore the previous scroll position during a reload. If that
    // position is not the hero, the opening intro must not replay on top of the
    // scroll-driven state while ScrollTrigger is being rebuilt.
    const restoredScrollY = Math.max(window.scrollY, document.scrollingElement?.scrollTop || 0)
    const resumeFromScroll = restoredScrollY > 24 || window.location.hash.length > 1
    if (resumeFromScroll) introTimeline?.progress(1)
    // Create the triggers while the loader still masks the page so there is no
    // visible frame where a restored scroll position has no state owner. The
    // actual measurements are intentionally deferred until after loader exit.
    activateScrollExperience()
    loading.setProgress(0.995)
    await loading.exit()
    experienceStarted = true
    // Start Lenis only after the scene is ready, then refresh once the loader
    // has stopped affecting visibility/layout.
    lenis.start()
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    lenis.resize()
    ScrollTrigger.refresh(true)
    ScrollTrigger.update()
    renderTimelinesAtCurrentScroll()
    viewportMode = getViewportMode()
    if (!resumeFromScroll) introTimeline?.play(0)
  } catch (error) {
    console.error('[FORGE] Unable to initialize weapon scene', error)
    document.body.classList.add('model-failed')
    loading.setLabel('Steel rests in shadow')
    await fontPromise
    loading.setProgress(0.995)
    await loading.exit()
    gsap.to('.scene-curtain', { autoAlpha: 0, duration: 0.8 })
    showStaticChapters()
    lenis.start()
  }
}

boot()

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    window.clearTimeout(resizeTimer)
    window.removeEventListener('resize', scheduleResizeSynchronization)
    window.visualViewport?.removeEventListener('resize', scheduleResizeSynchronization)
    motionPreference.removeEventListener('change', onMotionPreferenceChange)
    activeLoader?.destroy()
    activeMedia?.revert()
    wielderController?.dispose()
    activeWeapon?.dispose()
    destroyScrollExperience()
    gsap.ticker.remove(updateLenis)
    lenis.destroy()
  })
}
