import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

const UP = new THREE.Vector3(0, 1, 0)
const MAX_TEXTURE_SIZE = 1024
const EXTRACTION_MULTIPLIER = 1.25
const PRESENTATION_TILT_DEGREES = 18

/* ── Helpers ───────────────────────────────────────────────── */

function majorAxisFromSize(size) {
  if (size.x >= size.y && size.x >= size.z) return new THREE.Vector3(1, 0, 0)
  if (size.z >= size.x && size.z >= size.y) return new THREE.Vector3(0, 0, 1)
  return new THREE.Vector3(0, 1, 0)
}

function getObjectLocalBounds(object) {
  object.updateWorldMatrix(true, true)
  const inverseObjectWorld = object.matrixWorld.clone().invert()
  const bounds = new THREE.Box3().makeEmpty()

  object.traverse((child) => {
    if (!child.isMesh || !child.geometry) return
    child.geometry.computeBoundingBox()
    if (!child.geometry.boundingBox) return
    const childToObject = inverseObjectWorld.clone().multiply(child.matrixWorld)
    bounds.union(child.geometry.boundingBox.clone().applyMatrix4(childToObject))
  })
  return bounds
}

function getProjectedWorldExtent(object, worldAxis) {
  object.updateWorldMatrix(true, true)
  let minimum = Infinity
  let maximum = -Infinity
  const corner = new THREE.Vector3()

  object.traverse((child) => {
    if (!child.isMesh || !child.geometry) return
    child.geometry.computeBoundingBox()
    const bounds = child.geometry.boundingBox
    if (!bounds) return

    for (let xIndex = 0; xIndex < 2; xIndex += 1) {
      for (let yIndex = 0; yIndex < 2; yIndex += 1) {
        for (let zIndex = 0; zIndex < 2; zIndex += 1) {
          corner.set(
            xIndex ? bounds.max.x : bounds.min.x,
            yIndex ? bounds.max.y : bounds.min.y,
            zIndex ? bounds.max.z : bounds.min.z,
          ).applyMatrix4(child.matrixWorld)
          const projection = corner.dot(worldAxis)
          minimum = Math.min(minimum, projection)
          maximum = Math.max(maximum, projection)
        }
      }
    }
  })
  return maximum - minimum
}

/**
 * Downsample any texture whose source image exceeds MAX_TEXTURE_SIZE.
 * Prevents GPU memory exhaustion and GL_INVALID_OPERATION (1282) errors.
 */
function clampTexture(texture) {
  if (!texture || !texture.isTexture) return
  const img = texture.image
  if (!img) return

  let w = img.width || img.videoWidth || 0
  let h = img.height || img.videoHeight || 0
  if (w <= MAX_TEXTURE_SIZE && h <= MAX_TEXTURE_SIZE) return

  const scale = MAX_TEXTURE_SIZE / Math.max(w, h)
  const nw = Math.round(w * scale)
  const nh = Math.round(h * scale)

  const canvas = document.createElement('canvas')
  canvas.width = nw
  canvas.height = nh
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0, nw, nh)

  texture.image = canvas
  texture.needsUpdate = true
}

/**
 * Create a robust MeshStandardMaterial that preserves visual appearance
 * but guarantees shader compilation by using only core PBR properties.
 */
function createSafeMaterial(original) {
  const safe = new THREE.MeshStandardMaterial({
    name: (original.name || 'mat') + '_safe',
    color: original.color?.clone?.() || new THREE.Color(0x888888),
    roughness: original.roughness ?? 0.5,
    metalness: original.metalness ?? 0.0,
    side: original.side ?? THREE.FrontSide,
    transparent: original.transparent ?? false,
    opacity: original.opacity ?? 1.0,
    envMapIntensity: 0.45,
  })

  // Copy ONLY the base color map — the most critical texture for visual fidelity
  if (original.map) {
    clampTexture(original.map)
    safe.map = original.map
  }

  // Normal map adds significant perceived detail with minimal GPU cost
  if (original.normalMap) {
    clampTexture(original.normalMap)
    safe.normalMap = original.normalMap
    if (original.normalScale) safe.normalScale.copy(original.normalScale)
  }

  // Roughness/metalness maps if available (single channel, low cost)
  if (original.roughnessMap) {
    clampTexture(original.roughnessMap)
    safe.roughnessMap = original.roughnessMap
  }
  if (original.metalnessMap) {
    clampTexture(original.metalnessMap)
    safe.metalnessMap = original.metalnessMap
  }

  return safe
}

/* ── Main scene factory ────────────────────────────────────── */

export async function createWeaponScene(canvas, { onProgress = () => {} } = {}) {
  const reportProgress = (detail) => {
    try { onProgress(detail) } catch { /* progress reporting must never block rendering */ }
  }
  /* ── Renderer ─────────────────────────────────────────── */
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    powerPreference: 'high-performance',
    failIfMajorPerformanceCaveat: false,
  })
  renderer.setClearColor(0x000000, 0)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.16

  // WebGL context loss handling
  let contextLost = false
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault()
    contextLost = true
    console.warn('[FORGE] WebGL context lost — pausing render loop')
  })
  canvas.addEventListener('webglcontextrestored', () => {
    contextLost = false
    console.info('[FORGE] WebGL context restored — resuming')
  })

  /* ── Scene & Camera ──────────────────────────────────── */
  const scene = new THREE.Scene()
  scene.fog = new THREE.FogExp2(0x070707, 0.038)

  const cameraRig = new THREE.Group()
  const chapterCameraRig = new THREE.Group()
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100)
  camera.position.set(0, 0, 11.5)
  cameraRig.add(camera)
  chapterCameraRig.add(cameraRig)
  scene.add(chapterCameraRig)

  /* ── Shared cinematic atmosphere ───────────────────── */
  const waveState = {
    opacity: 0,
    brightness: 0.7,
    amplitude: 1.7,
    speed: 0.2,
    turbulence: 0.14,
  }
  const waveUniforms = {
    uTime: { value: 0 },
    uOpacity: { value: 0 },
    uBrightness: { value: waveState.brightness },
    uAmplitude: { value: waveState.amplitude },
    uTurbulence: { value: waveState.turbulence },
    uHorizon: { value: new THREE.Color(0x070707) },
    uBody: { value: new THREE.Color(0x241812) },
    uCrest: { value: new THREE.Color(0x927b5d) },
  }
  const waveMaterial = new THREE.ShaderMaterial({
    uniforms: waveUniforms,
    transparent: true,
    // The vertex shader writes clip-space z=1 for a fullscreen background.
    // Disable depth testing so it is not rejected against the cleared depth
    // buffer, while depthWrite remains false so the weapon renders above it.
    depthTest: false,
    depthWrite: false,
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 1.0, 1.0);
      }
    `,
    fragmentShader: `
      precision mediump float;
      varying vec2 vUv;
      uniform float uTime;
      uniform float uOpacity;
      uniform float uBrightness;
      uniform float uAmplitude;
      uniform float uTurbulence;
      uniform vec3 uHorizon;
      uniform vec3 uBody;
      uniform vec3 uCrest;

      float hash(vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
      }

      void main() {
        vec2 uv = vUv;
        float time = uTime;
        float field = 0.0;
        float crest = 0.0;

        for (int layer = 0; layer < 4; layer++) {
          float index = float(layer);
          float phase = time * (0.34 + index * 0.08) + index * 1.73;
          float noise = sin((uv.x * 5.8 + uv.y * 2.2 + phase) * (1.0 + uTurbulence));
          float wave = sin(uv.x * (7.0 + index * 1.25) + phase + noise * 0.42);
          float ridge = 0.23 + index * 0.105 + wave * 0.026 * uAmplitude;
          float band = smoothstep(ridge - 0.055, ridge, uv.y) - smoothstep(ridge, ridge + 0.075, uv.y);
          field += band * (0.32 + index * 0.12);
          crest += smoothstep(ridge - 0.008, ridge, uv.y) - smoothstep(ridge, ridge + 0.014, uv.y);
        }

        float horizonFade = smoothstep(0.04, 0.72, 1.0 - uv.y);
        float glow = smoothstep(0.0, 1.7, field) * horizonFade;
        vec3 color = mix(uHorizon, uBody, glow * uBrightness);
        color = mix(color, uCrest, clamp(crest * 0.22 * uBrightness, 0.0, 0.62));
        float grain = (hash(gl_FragCoord.xy + time) - 0.5) * 0.025;
        color += grain;
        float alpha = uOpacity * clamp(glow * 0.72 + crest * 0.1, 0.0, 0.68);
        gl_FragColor = vec4(color, alpha);
      }
    `,
  })
  const waveMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), waveMaterial)
  waveMesh.name = 'ForgeGradientWaves'
  waveMesh.frustumCulled = false
  waveMesh.renderOrder = -100
  waveMesh.visible = false
  scene.add(waveMesh)

  const emberCount = 38
  const emberPositions = new Float32Array(emberCount * 3)
  const emberSeeds = new Float32Array(emberCount)
  for (let index = 0; index < emberCount; index += 1) {
    const seed = (index * 0.61803398875) % 1
    emberPositions[index * 3] = (seed - 0.5) * 11
    emberPositions[index * 3 + 1] = ((index * 0.371) % 1) * 7 - 3.5
    emberPositions[index * 3 + 2] = ((index * 0.217) % 1) * 3 - 1
    emberSeeds[index] = seed
  }
  const emberGeometry = new THREE.BufferGeometry()
  emberGeometry.setAttribute('position', new THREE.BufferAttribute(emberPositions, 3))
  emberGeometry.setAttribute('aSeed', new THREE.BufferAttribute(emberSeeds, 1))
  const emberUniforms = {
    uTime: { value: 0 },
    uOpacity: { value: 0 },
    uPixelRatio: { value: Math.min(window.devicePixelRatio, 1.5) },
  }
  const emberMaterial = new THREE.ShaderMaterial({
    uniforms: emberUniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: `
      attribute float aSeed;
      uniform float uTime;
      uniform float uPixelRatio;
      varying float vFade;
      void main() {
        vec3 animated = position;
        animated.y += mod(uTime * (0.09 + aSeed * 0.16) + aSeed * 6.0, 7.0) - 3.5;
        animated.x += sin(uTime * 0.24 + aSeed * 18.0) * 0.14;
        vec4 mvPosition = modelViewMatrix * vec4(animated, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        gl_PointSize = (1.2 + aSeed * 2.1) * uPixelRatio * (9.0 / max(2.0, -mvPosition.z));
        vFade = 0.28 + aSeed * 0.54;
      }
    `,
    fragmentShader: `
      precision mediump float;
      uniform float uOpacity;
      varying float vFade;
      void main() {
        float distanceFromCenter = distance(gl_PointCoord, vec2(0.5));
        float alpha = smoothstep(0.5, 0.08, distanceFromCenter) * uOpacity * vFade;
        gl_FragColor = vec4(vec3(0.57, 0.34, 0.19), alpha);
      }
    `,
  })
  const embers = new THREE.Points(emberGeometry, emberMaterial)
  embers.name = 'ForgeEmbers'
  embers.position.z = 1.2
  embers.visible = false
  scene.add(embers)
  const emberState = { opacity: 0 }

  /* ── Environment (minimal) ───────────────────────────── */
  // Skip PMREMGenerator entirely — it was contributing to GPU pressure.
  // We'll rely on direct lights only for illumination.
  // scene.environment is left null intentionally.

  /* ── Lighting ────────────────────────────────────────── */
  const lightTarget = new THREE.Object3D()
  lightTarget.position.set(1.55, 0.05, 0)
  scene.add(lightTarget)

  // All lights start at 0 intensity — the intro animation ramps them up
  const key = new THREE.SpotLight(0xdce3e8, 0, 32, Math.PI / 5.2, 0.8, 1.35)
  key.position.set(4.4, 6.8, 7.6)
  key.target = lightTarget
  scene.add(key)

  const rim = new THREE.DirectionalLight(0xb9c8d1, 0)
  rim.position.set(-4.6, 4.2, -5.5)
  rim.target = lightTarget
  scene.add(rim)

  const fill = new THREE.DirectionalLight(0x87949d, 0)
  fill.position.set(-1.8, 2.2, 5.8)
  fill.target = lightTarget
  scene.add(fill)

  const engraving = new THREE.SpotLight(0xc7d2d9, 0, 28, Math.PI / 7, 0.72, 1.25)
  engraving.position.set(-3.2, 4.8, 6.4)
  engraving.target = lightTarget
  scene.add(engraving)

  const accent = new THREE.PointLight(0x927b5d, 0, 14, 1.7)
  accent.position.set(1.4, 2.15, 4.4)
  scene.add(accent)

  const sheathFill = new THREE.SpotLight(0x7f8b94, 0, 24, Math.PI / 4.2, 0.92, 1.6)
  sheathFill.position.set(3.8, -3.2, 6.2)
  sheathFill.target = lightTarget
  scene.add(sheathFill)

  const sweepTarget = new THREE.Object3D()
  sweepTarget.position.set(1.45, -0.8, 0)
  scene.add(sweepTarget)
  const bladeSweep = new THREE.SpotLight(0xe7edf0, 0, 24, Math.PI / 14, 0.36, 1.15)
  bladeSweep.position.set(-3.4, 1.2, 6.8)
  bladeSweep.target = sweepTarget
  scene.add(bladeSweep)

  const ambient = new THREE.HemisphereLight(0x7d8992, 0x030303, 0)
  scene.add(ambient)

  const lightTargets = {
    key: 430,
    rim: 8.2,
    fill: 3.1,
    engraving: 190,
    accent: 88,
    sheathFill: 92,
    bladeSweep: 265,
    ambient: 0.4,
  }

  /* ── Load GLB ────────────────────────────────────────── */
  const loadingManager = new THREE.LoadingManager()
  loadingManager.onError = (url) => console.error(`[FORGE] Failed to load required asset: ${url}`)
  const loader = new GLTFLoader(loadingManager)
  const gltf = await loader.loadAsync('/models/weapon.glb', (event) => {
    const total = Number(event.total) || 0
    const loaded = Number(event.loaded) || 0
    const ratio = total > 0 ? loaded / total : null
    reportProgress({ loaded, total, ratio })
  })
  reportProgress({ loaded: 1, total: 1, ratio: 1 })

  const hierarchy = []
  let meshCount = 0
  const materialNames = new Set()

  // CRITICAL: Replace ALL materials with safe versions BEFORE any rendering.
  // The original materials from the GLB cause shader compilation failures
  // (MI_Tape_3, MI_Katana_Scabbard_2) that crash the WebGL context.
  gltf.scene.traverse((object) => {
    hierarchy.push({
      name: object.name || '(unnamed)',
      type: object.type,
      parent: object.parent?.name || null,
    })
    if (!object.isMesh) return
    meshCount += 1
    object.castShadow = false
    object.receiveShadow = false
    object.frustumCulled = false

    const materials = Array.isArray(object.material)
      ? object.material
      : [object.material]

    const safeMaterials = materials.map((mat) => {
      if (!mat) return mat
      materialNames.add(mat.name || '(unnamed)')
      const safe = createSafeMaterial(mat)
      return safe
    })

    object.material = safeMaterials.length === 1 ? safeMaterials[0] : safeMaterials
  })

  /* ── Find Sword & Sheath ─────────────────────────────── */
  let sword = gltf.scene.getObjectByName('Sword')
  let sheath = gltf.scene.getObjectByName('Sheath')

  // Robust fallback: search case-insensitively and by partial match
  if (!sword || !sheath) {
    console.info('[FORGE] Exact name match failed, searching hierarchy...')
    gltf.scene.traverse((obj) => {
      const n = (obj.name || '').toLowerCase()
      if (!sword && (n === 'sword' || n.includes('sword') || n.includes('katana_blade'))) {
        sword = obj
        console.info(`[FORGE] Found sword as: "${obj.name}" (type: ${obj.type})`)
      }
      if (!sheath && (n === 'sheath' || n.includes('sheath') || n.includes('scabbard') || n.includes('saya'))) {
        sheath = obj
        console.info(`[FORGE] Found sheath as: "${obj.name}" (type: ${obj.type})`)
      }
    })
  }

  if (!meshCount || !sword || !sheath) {
    console.error('[FORGE] GLB hierarchy:', hierarchy)
    throw new Error(`GLB needs renderable meshes and independent Sword/Sheath nodes. Found: meshes=${meshCount}, sword=${!!sword}, sheath=${!!sheath}`)
  }

  if (sword.parent !== sheath.parent) {
    throw new Error('Sword and Sheath must share a parent so the presentation rig can preserve their exported transforms.')
  }

  /* ── Physical presentation rig ───────────────────────── */
  gltf.scene.updateMatrixWorld(true)

  // The two meshes were authored in one curved coordinate system, but the
  // exported sibling groups carry different transforms. Keep those exported
  // transforms untouched and reconcile them on presentation wrappers instead.
  sword.updateMatrix()
  sheath.updateMatrix()
  const swordExportedMatrix = sword.matrix.clone()
  const sheathExportedMatrix = sheath.matrix.clone()
  const swordStart = sword.position.clone()
  const swordStartQuaternion = sword.quaternion.clone()
  const swordStartScale = sword.scale.clone()
  const sheathStart = sheath.position.clone()
  const sourceParent = sword.parent

  const weaponRig = new THREE.Group()
  const sheathMatchPivot = new THREE.Group()
  const swordMatchPivot = new THREE.Group()
  const sheathRig = new THREE.Group()
  const swordRig = new THREE.Group()
  weaponRig.name = 'WeaponPresentationRig'
  sheathMatchPivot.name = 'SheathChapterMatchPivot'
  swordMatchPivot.name = 'SwordChapterMatchPivot'
  sheathRig.name = 'SheathPresentationRig'
  swordRig.name = 'SwordPresentationRig'
  sourceParent.add(weaponRig)
  weaponRig.add(sheathMatchPivot, swordMatchPivot)
  sheathMatchPivot.add(sheathRig)
  swordMatchPivot.add(swordRig)
  sheathRig.add(sheath)
  swordRig.add(sword)

  // M(swordRig) * M(exported Sword) = M(exported Sheath). This makes every
  // point on the blade use the Sheath's real 3D frame, including its curved
  // centerline, rather than merely matching the two objects in screen space.
  const swordRigCorrectionMatrix = sheathExportedMatrix.clone().multiply(swordExportedMatrix.clone().invert())
  swordRigCorrectionMatrix.decompose(swordRig.position, swordRig.quaternion, swordRig.scale)
  const swordRigAlignedPosition = swordRig.position.clone()
  const swordRigAlignedQuaternion = swordRig.quaternion.clone()
  const swordRigAlignedScale = swordRig.scale.clone()
  const sheathRigStart = sheathRig.position.clone()

  weaponRig.updateMatrixWorld(true)

  /* ── Geometry analysis ───────────────────────────────── */
  const sheathLocalBounds = getObjectLocalBounds(sheath)
  const sheathLocalSize = sheathLocalBounds.getSize(new THREE.Vector3())
  const sheathLocalAxis = majorAxisFromSize(sheathLocalSize)
  const extractionWorldAxis = sheathLocalAxis.clone().transformDirection(sheath.matrixWorld)
  const swordCenter = new THREE.Box3().setFromObject(sword).getCenter(new THREE.Vector3())
  const sheathCenter = new THREE.Box3().setFromObject(sheath).getCenter(new THREE.Vector3())
  if (swordCenter.clone().sub(sheathCenter).dot(extractionWorldAxis) < 0) extractionWorldAxis.negate()

  const parentLocalOrigin = sourceParent.worldToLocal(sheathCenter.clone())
  const parentLocalAxisPoint = sourceParent.worldToLocal(sheathCenter.clone().add(extractionWorldAxis))
  const extractionVector = parentLocalAxisPoint.sub(parentLocalOrigin)

  const sourceBounds = new THREE.Box3().setFromObject(gltf.scene)
  const sourceSize = sourceBounds.getSize(new THREE.Vector3())
  const sourceCenter = sourceBounds.getCenter(new THREE.Vector3())
  const longestDimension = Math.max(sourceSize.x, sourceSize.y, sourceSize.z)
  const sheathLengthWorld = getProjectedWorldExtent(sheath, extractionWorldAxis)
  const drawDistance = sheathLengthWorld * 1.06 * EXTRACTION_MULTIPLIER

  const extractionDirectionLocal = extractionVector.clone().normalize()
  const correctionParallel = extractionDirectionLocal.clone().multiplyScalar(swordRigAlignedPosition.dot(extractionDirectionLocal))
  const correctionPerpendicular = swordRigAlignedPosition.clone().sub(correctionParallel)
  const centerlineDirectionError = sheathLocalAxis.clone()
    .transformDirection(sheath.matrixWorld)
    .angleTo(sheathLocalAxis.clone().transformDirection(sword.matrixWorld))

  // One-time independent-transform proof: move Sword by a full draw, assert that
  // Sword travels and Sheath does not, then restore the aligned rig transforms.
  const swordWorldBefore = sword.getWorldPosition(new THREE.Vector3())
  const sheathWorldBefore = sheath.getWorldPosition(new THREE.Vector3())
  swordRig.position.copy(swordRigAlignedPosition).addScaledVector(extractionVector, drawDistance)
  weaponRig.updateMatrixWorld(true)
  const swordDiagnosticDistance = sword.getWorldPosition(new THREE.Vector3()).distanceTo(swordWorldBefore)
  const sheathDiagnosticDistance = sheath.getWorldPosition(new THREE.Vector3()).distanceTo(sheathWorldBefore)
  swordRig.position.copy(swordRigAlignedPosition)
  swordRig.quaternion.copy(swordRigAlignedQuaternion)
  swordRig.scale.copy(swordRigAlignedScale)
  gltf.scene.updateMatrixWorld(true)
  if (swordDiagnosticDistance < sheathLengthWorld * 0.9 || sheathDiagnosticDistance > 0.0001) {
    throw new Error('Sword/Sheath independent transform diagnostic failed.')
  }

  /* ── Position model ──────────────────────────────────── */
  gltf.scene.position.sub(sourceCenter)
  const modelPivot = new THREE.Group()
  modelPivot.add(gltf.scene)
  modelPivot.quaternion.setFromUnitVectors(extractionWorldAxis, UP)
  const presentationTilt = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 0, 1),
    THREE.MathUtils.degToRad(PRESENTATION_TILT_DEGREES),
  )
  modelPivot.quaternion.premultiply(presentationTilt)
  const normalizedScale = 4.72 / longestDimension
  modelPivot.scale.setScalar(normalizedScale)
  modelPivot.position.set(1.62, -1.35, 0)
  const restingTransform = {
    rotation: modelPivot.rotation.clone(),
    scale: modelPivot.scale.clone(),
  }
  // The hero timeline retains sole ownership of modelPivot. All chapters after
  // the draw animate this outer wrapper so the proven Sword/Sheath rig and its
  // extraction transforms remain untouched.
  const chapterPivot = new THREE.Group()
  chapterPivot.name = 'ChapterPresentationPivot'
  chapterPivot.add(modelPivot)
  // Inspection is isolated above every production presentation/extraction
  // transform. These wrappers stay at identity outside inspection, so the
  // authored GLB nodes and the proven Sword/Sheath rig are never rewritten.
  const inspectionPlacement = new THREE.Group()
  const inspectionOrbit = new THREE.Group()
  const inspectionOffset = new THREE.Group()
  inspectionPlacement.name = 'InspectionPlacement'
  inspectionOrbit.name = 'InspectionOrbit'
  inspectionOffset.name = 'InspectionCenterOffset'
  inspectionOffset.add(chapterPivot)
  inspectionOrbit.add(inspectionOffset)
  inspectionPlacement.add(inspectionOrbit)
  scene.add(inspectionPlacement)
  modelPivot.updateMatrixWorld(true)

  const parentWorldOrigin = sourceParent.localToWorld(new THREE.Vector3())
  const payoffLeftVector = sourceParent.worldToLocal(parentWorldOrigin.clone().add(new THREE.Vector3(-1, 0, 0)))
  const parentLocalOriginAfterPresentation = sourceParent.worldToLocal(parentWorldOrigin.clone())
  payoffLeftVector.sub(parentLocalOriginAfterPresentation)
  const payoffRoll = new THREE.Quaternion().setFromAxisAngle(sheathLocalAxis, THREE.MathUtils.degToRad(-5))
  const swordRigPayoffQuaternion = swordRigAlignedQuaternion.clone().multiply(payoffRoll)

  /* ── Prove the extracted Sword creates real screen movement ── */
  const diagnosticWidth = Math.max(canvas.clientWidth, 1)
  const diagnosticHeight = Math.max(canvas.clientHeight, 1)
  renderer.setSize(diagnosticWidth, diagnosticHeight, false)
  camera.aspect = diagnosticWidth / diagnosticHeight
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld(true)

  const projectCenterToScreen = (object) => {
    const projected = new THREE.Box3().setFromObject(object).getCenter(new THREE.Vector3()).project(camera)
    return new THREE.Vector2(
      (projected.x * 0.5 + 0.5) * diagnosticWidth,
      (-projected.y * 0.5 + 0.5) * diagnosticHeight,
    )
  }

  const swordScreenBefore = projectCenterToScreen(sword)
  const sheathScreenBefore = projectCenterToScreen(sheath)
  swordRig.position.copy(swordRigAlignedPosition).addScaledVector(extractionVector, drawDistance)
  modelPivot.updateMatrixWorld(true)
  const swordScreenAfter = projectCenterToScreen(sword)
  const sheathScreenAfter = projectCenterToScreen(sheath)
  const swordScreenDiagnosticDistance = swordScreenAfter.distanceTo(swordScreenBefore)
  const sheathScreenDiagnosticDistance = sheathScreenAfter.distanceTo(sheathScreenBefore)
  swordRig.position.copy(swordRigAlignedPosition)
  swordRig.quaternion.copy(swordRigAlignedQuaternion)
  swordRig.scale.copy(swordRigAlignedScale)
  modelPivot.updateMatrixWorld(true)
  if (swordScreenDiagnosticDistance < Math.min(160, diagnosticHeight * 0.22) || sheathScreenDiagnosticDistance > 0.5) {
    throw new Error('Sword extraction failed the screen-space movement diagnostic.')
  }

  /* ── Verify rendering works ──────────────────────────── */
  const gl = renderer.getContext()
  // Clear any stale GL errors
  while (gl.getError() !== gl.NO_ERROR) { /* drain */ }

  // Test render
  renderer.render(scene, camera)
  const glErr = gl.getError()
  if (glErr !== gl.NO_ERROR) {
    console.warn(`[FORGE] GL error ${glErr} after test render — but continuing with safe materials`)
    while (gl.getError() !== gl.NO_ERROR) { /* drain remaining */ }
  }

  /* ── Store info ──────────────────────────────────────── */
  const initialSwordBounds = new THREE.Box3().setFromObject(sword)
  const initialSheathBounds = new THREE.Box3().setFromObject(sheath)
  canvas.dataset.weaponInfo = JSON.stringify({
    meshes: meshCount,
    materials: [...materialNames],
    swordNode: sword.name,
    sheathNode: sheath.name,
    dimensions: sourceSize.toArray(),
    extractionAxisWorld: extractionWorldAxis.toArray(),
    extractionVectorLocal: extractionVector.toArray(),
    extractionDistanceWorld: drawDistance,
    extractionMultiplier: EXTRACTION_MULTIPLIER,
    alignmentReference: sheath.name,
    swordRigCorrectionLocal: swordRigAlignedPosition.toArray(),
    swordRigCorrectionQuaternion: swordRigAlignedQuaternion.toArray(),
    swordRigCorrectionScale: swordRigAlignedScale.toArray(),
    swordRigParallelCorrectionLocal: correctionParallel.toArray(),
    swordRigPerpendicularCorrectionLocal: correctionPerpendicular.toArray(),
    centerlineDirectionErrorDegrees: THREE.MathUtils.radToDeg(centerlineDirectionError),
    swordDiagnosticDistance,
    sheathDiagnosticDistance,
    swordScreenDiagnosticDistance,
    sheathScreenDiagnosticDistance,
    swordStartPosition: swordStart.toArray(),
    sheathStartPosition: sheathStart.toArray(),
    swordBounds: [initialSwordBounds.min.toArray(), initialSwordBounds.max.toArray()],
    sheathBounds: [initialSheathBounds.min.toArray(), initialSheathBounds.max.toArray()],
  })

  /* ── Animation state ─────────────────────────────────── */
  const draw = { progress: 0 }
  const sheathMotion = { progress: 0 }
  const payoff = { progress: 0 }
  // Temporary, outer-only composition used for the AI-to-real match frame.
  // The physical Sword/Sheath rigs beneath these pivots remain untouched.
  const chapterMatch = { progress: 0, gap: 0.9 }
  const cameraMotion = { yaw: 0, pitch: 0 }

  const inspectionBounds = new THREE.Box3()
  const inspectionSecondaryBounds = new THREE.Box3()
  const inspectionAnchorCenter = new THREE.Vector3()
  const inspectionTargetCenter = new THREE.Vector3()
  const inspectionCameraPosition = new THREE.Vector3()
  const inspectionCameraForward = new THREE.Vector3()
  const inspectionCameraUp = new THREE.Vector3()
  const inspectionCameraQuaternion = new THREE.Quaternion()
  let inspectionAnchorDepth = 10
  const inspection = {
    active: false,
    blend: 0,
    currentYaw: 0,
    currentPitch: 0,
    currentZoom: 1,
    targetYaw: 0,
    targetPitch: 0,
    targetZoom: 1,
    baseZoom: 1,
    defaultRoll: THREE.MathUtils.degToRad(84),
    limits: {
      yaw: THREE.MathUtils.degToRad(55),
      pitch: THREE.MathUtils.degToRad(18),
      zoomMin: 0.88,
      zoomMax: 1.1,
    },
    refreshFrame(remeasure = this.active) {
      if (remeasure) {
        // A breakpoint change can rebuild the story's responsive camera frame.
        // Measure from identity wrappers so inspection never feeds its own
        // temporary rotation or scale back into the production composition.
        inspectionPlacement.position.set(0, 0, 0)
        inspectionOrbit.position.set(0, 0, 0)
        inspectionOrbit.rotation.set(0, 0, 0)
        inspectionOrbit.scale.setScalar(1)
        inspectionOffset.position.set(0, 0, 0)
        cameraRig.rotation.set(cameraMotion.pitch, cameraMotion.yaw, 0)
        scene.updateMatrixWorld(true)
        inspectionBounds.setFromObject(sword)
        inspectionSecondaryBounds.setFromObject(sheath)
        inspectionBounds.union(inspectionSecondaryBounds).getCenter(inspectionAnchorCenter)
        camera.getWorldPosition(inspectionCameraPosition)
        camera.getWorldQuaternion(inspectionCameraQuaternion)
        inspectionCameraForward.set(0, 0, -1).applyQuaternion(inspectionCameraQuaternion)
        inspectionAnchorDepth = Math.max(
          4,
          inspectionAnchorCenter.clone().sub(inspectionCameraPosition).dot(inspectionCameraForward),
        )
      }

      camera.getWorldPosition(inspectionCameraPosition)
      camera.getWorldQuaternion(inspectionCameraQuaternion)
      inspectionCameraForward.set(0, 0, -1).applyQuaternion(inspectionCameraQuaternion)
      inspectionCameraUp.set(0, 1, 0).applyQuaternion(inspectionCameraQuaternion)
      inspectionTargetCenter.copy(inspectionCameraPosition)
        .addScaledVector(inspectionCameraForward, inspectionAnchorDepth)
        .addScaledVector(inspectionCameraUp, canvas.clientWidth < 720 ? 0 : -0.08)

      const aspect = Math.max(canvas.clientWidth, 1) / Math.max(canvas.clientHeight, 1)
      // The fully drawn Sword is considerably wider than the in-story frame.
      // Keep the complete artifact inside the viewport at every breakpoint;
      // user zoom is then applied inside the bounded range below.
      this.baseZoom = Math.min(0.78, aspect * 0.44)
    },
    begin() {
      this.active = true
      this.blend = 0
      this.currentYaw = 0
      this.currentPitch = 0
      this.currentZoom = 1
      this.targetYaw = 0
      this.targetPitch = 0
      this.targetZoom = 1
      this.refreshFrame(true)
    },
    setRotation(yaw, pitch) {
      this.targetYaw = THREE.MathUtils.clamp(yaw, -this.limits.yaw, this.limits.yaw)
      this.targetPitch = THREE.MathUtils.clamp(pitch, -this.limits.pitch, this.limits.pitch)
    },
    adjustZoom(delta) {
      this.targetZoom = THREE.MathUtils.clamp(
        this.targetZoom + delta,
        this.limits.zoomMin,
        this.limits.zoomMax,
      )
    },
    resetView() {
      this.targetYaw = 0
      this.targetPitch = 0
      this.targetZoom = 1
    },
    finish() {
      this.active = false
      this.blend = 0
      this.currentYaw = 0
      this.currentPitch = 0
      this.currentZoom = 1
      this.targetYaw = 0
      this.targetPitch = 0
      this.targetZoom = 1
      inspectionPlacement.position.set(0, 0, 0)
      inspectionOrbit.position.set(0, 0, 0)
      inspectionOrbit.rotation.set(0, 0, 0)
      inspectionOrbit.scale.setScalar(1)
      inspectionOffset.position.set(0, 0, 0)
    },
  }

  const smoothstep = (start, end, value) => {
    const normalized = THREE.MathUtils.clamp((value - start) / (end - start), 0, 1)
    return normalized * normalized * (3 - 2 * normalized)
  }

  const setExtractionLighting = (progress) => {
    const value = THREE.MathUtils.clamp(progress, 0, 1)
    const firstLight = smoothstep(0.12, 0.28, value)
    const edgeRead = smoothstep(0.34, 0.72, value)
    const heroLight = smoothstep(0.7, 1, value)
    const sweepPhase = THREE.MathUtils.clamp((value - 0.86) / 0.12, 0, 1)
    const sweep = Math.sin(sweepPhase * Math.PI)

    key.intensity = lightTargets.key * (0.72 + firstLight * 0.12 + heroLight * 0.26)
    rim.intensity = lightTargets.rim * (0.48 + edgeRead * 0.28 + heroLight * 0.36)
    fill.intensity = lightTargets.fill * (0.8 + edgeRead * 0.2)
    engraving.intensity = lightTargets.engraving * (0.56 + edgeRead * 0.24 + heroLight * 0.3)
    accent.intensity = lightTargets.accent * (0.42 + firstLight * 0.16 + heroLight * 0.1)
    sheathFill.intensity = lightTargets.sheathFill * (0.72 - heroLight * 0.2)
    ambient.intensity = lightTargets.ambient * (0.72 + edgeRead * 0.28)
    bladeSweep.intensity = lightTargets.bladeSweep * (sweep + heroLight * 0.16)
    sweepTarget.position.y = THREE.MathUtils.lerp(-1.4, 2.9, sweepPhase)
  }

  /* ── Pointer parallax ────────────────────────────────── */
  const pointerTarget = { x: 0, y: 0 }
  const pointerCurrent = { x: 0, y: 0 }
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  const onPointerMove = (event) => {
    if (inspection.active || inspection.blend > 0.0001) return
    if (window.innerWidth < 900 || reducedMotion.matches) return
    pointerTarget.x = (event.clientX / window.innerWidth - 0.5) * 2
    pointerTarget.y = (event.clientY / window.innerHeight - 0.5) * 2
  }
  window.addEventListener('pointermove', onPointerMove, { passive: true })

  /* ── Render loop ─────────────────────────────────────── */
  let frameId = 0
  let previousTime = performance.now()
  let previousStateLabel = ''
  const swordWorldPosition = new THREE.Vector3()
  const sheathWorldPosition = new THREE.Vector3()
  const matchSwordCenterWorld = new THREE.Vector3()
  const matchSheathCenterWorld = new THREE.Vector3()
  const matchSwordCenterLocal = new THREE.Vector3()
  const matchSheathCenterLocal = new THREE.Vector3()
  const matchScreenDownWorld = new THREE.Vector3()
  const matchScreenDownLocal = new THREE.Vector3()
  const matchWorldScale = new THREE.Vector3()
  const matchCameraQuaternion = new THREE.Quaternion()
  const matchInverseWorld = new THREE.Matrix4()
  const matchTarget = new THREE.Vector3()
  const matchSwordBounds = new THREE.Box3()
  const matchSheathBounds = new THREE.Box3()

  const render = (time) => {
    frameId = requestAnimationFrame(render)
    if (contextLost) return

    const delta = Math.min((time - previousTime) / 1000, 0.05)
    previousTime = time

    const inspectionEngaged = inspection.active || inspection.blend > 0.0001

    const inspectionResponse = reducedMotion.matches ? 18 : 9.5
    const inspectionDamping = 1 - Math.exp(-inspectionResponse * delta)
    inspection.currentYaw += (inspection.targetYaw - inspection.currentYaw) * inspectionDamping
    inspection.currentPitch += (inspection.targetPitch - inspection.currentPitch) * inspectionDamping
    inspection.currentZoom += (inspection.targetZoom - inspection.currentZoom) * inspectionDamping

    const inspectionBlend = THREE.MathUtils.clamp(inspection.blend, 0, 1)
    inspectionPlacement.position.copy(inspectionTargetCenter).multiplyScalar(inspectionBlend)
    inspectionOffset.position.copy(inspectionAnchorCenter).multiplyScalar(-inspectionBlend)
    inspectionOrbit.rotation.order = 'YXZ'
    inspectionOrbit.rotation.set(
      inspection.currentPitch * inspectionBlend,
      inspection.currentYaw * inspectionBlend,
      inspection.defaultRoll * inspectionBlend,
    )
    const inspectionScale = THREE.MathUtils.lerp(
      1,
      inspection.baseZoom * inspection.currentZoom,
      inspectionBlend,
    )
    inspectionOrbit.scale.setScalar(inspectionScale)

    // Pointer damping
    // Keep the pre-inspection parallax sample intact. Its contribution fades
    // out/in with the wrapper blend, then ordinary pointer damping resumes.
    if (!inspectionEngaged) {
      pointerCurrent.x += (pointerTarget.x - pointerCurrent.x) * Math.min(delta * 3.2, 1)
      pointerCurrent.y += (pointerTarget.y - pointerCurrent.y) * Math.min(delta * 3.2, 1)
    }
    const pointerWeight = 1 - inspectionBlend
    cameraRig.rotation.y = cameraMotion.yaw + THREE.MathUtils.degToRad(pointerCurrent.x * 1.35 * pointerWeight)
    cameraRig.rotation.x = cameraMotion.pitch + THREE.MathUtils.degToRad(pointerCurrent.y * 0.7 * pointerWeight)
    if (!inspectionEngaged) key.position.x = 4.4 + pointerCurrent.x * 0.2

    // Forge atmosphere shares this renderer and therefore cannot drift out of
    // sync with the chapter timelines. Decorative motion is greatly reduced
    // when the operating system asks for reduced motion.
    const decorativeMotion = reducedMotion.matches ? 0.08 : 1
    waveMesh.visible = waveState.opacity > 0.001
    embers.visible = !reducedMotion.matches && emberState.opacity > 0.001
    if (waveMesh.visible) waveUniforms.uTime.value += delta * waveState.speed * decorativeMotion
    if (embers.visible) emberUniforms.uTime.value += delta * decorativeMotion
    waveUniforms.uOpacity.value = waveState.opacity
    waveUniforms.uBrightness.value = waveState.brightness
    waveUniforms.uAmplitude.value = waveState.amplitude
    waveUniforms.uTurbulence.value = waveState.turbulence
    emberUniforms.uOpacity.value = reducedMotion.matches ? 0 : emberState.opacity

    // Exact non-accumulating extraction on the aligned presentation rig. The
    // original Sword transform remains identical to the GLB export.
    const resolvedDrawProgress = draw.progress < 0.0001 ? 0 : (draw.progress > 0.9999 ? 1 : draw.progress)
    const resolvedPayoffProgress = payoff.progress < 0.0001 ? 0 : (payoff.progress > 0.9999 ? 1 : payoff.progress)
    const resolvedSheathProgress = sheathMotion.progress < 0.0001 ? 0 : (sheathMotion.progress > 0.9999 ? 1 : sheathMotion.progress)
    swordRig.position.copy(swordRigAlignedPosition).addScaledVector(extractionVector, drawDistance * resolvedDrawProgress)
    // Once fully clear, use the multiplier's spare travel to settle the Sword
    // closer to the mouth for the payoff without ever reinserting the blade.
    swordRig.position.addScaledVector(extractionVector, -drawDistance * 0.2 * resolvedPayoffProgress)
    swordRig.position.addScaledVector(payoffLeftVector, 0.38 * resolvedPayoffProgress)
    swordRig.quaternion.slerpQuaternions(swordRigAlignedQuaternion, swordRigPayoffQuaternion, resolvedPayoffProgress)
    swordRig.scale.copy(swordRigAlignedScale)
    // Sheath drifts slightly during final phase
    sheathRig.position.copy(sheathRigStart).addScaledVector(extractionVector, -drawDistance * 0.055 * resolvedSheathProgress)
    sheathRig.position.z = sheathRigStart.z - longestDimension * 0.035 * resolvedSheathProgress

    // Recompose the fully extracted pair only during the short memory-match
    // state. Both match pivots are reset before measurement, so this remains
    // deterministic in either scroll direction and never feeds back into the
    // extraction or authored GLB transforms.
    const matchProgress = THREE.MathUtils.clamp(chapterMatch.progress, 0, 1)
    sheathMatchPivot.position.set(0, 0, 0)
    swordMatchPivot.position.set(0, 0, 0)
    if (matchProgress > 0.0001) {
      scene.updateMatrixWorld(true)
      matchSwordBounds.setFromObject(sword).getCenter(matchSwordCenterWorld)
      matchSheathBounds.setFromObject(sheath).getCenter(matchSheathCenterWorld)
      matchSwordCenterLocal.copy(matchSwordCenterWorld)
      matchSheathCenterLocal.copy(matchSheathCenterWorld)
      weaponRig.worldToLocal(matchSwordCenterLocal)
      weaponRig.worldToLocal(matchSheathCenterLocal)

      camera.getWorldQuaternion(matchCameraQuaternion)
      matchScreenDownWorld.set(0, -1, 0).applyQuaternion(matchCameraQuaternion)
      matchInverseWorld.copy(weaponRig.matrixWorld).invert()
      matchScreenDownLocal.copy(matchScreenDownWorld).transformDirection(matchInverseWorld)
      weaponRig.getWorldScale(matchWorldScale)
      const averageWorldScale = Math.max(0.0001, (matchWorldScale.x + matchWorldScale.y + matchWorldScale.z) / 3)

      matchTarget.copy(matchSwordCenterLocal)
        .sub(matchSheathCenterLocal)
        .addScaledVector(matchScreenDownLocal, chapterMatch.gap / averageWorldScale)
      sheathMatchPivot.position.copy(matchTarget).multiplyScalar(matchProgress)
    }

    const progressLabel = draw.progress.toFixed(4)
    const sheathProgressLabel = sheathMotion.progress.toFixed(4)
    const stateLabel = `${progressLabel}:${sheathProgressLabel}`
    if (previousStateLabel !== stateLabel) {
      previousStateLabel = stateLabel
      canvas.dataset.extractionProgress = progressLabel
      canvas.dataset.sheathMotionProgress = sheathProgressLabel
      canvas.dataset.swordLocalPosition = JSON.stringify(swordRig.position.toArray())
      canvas.dataset.sheathLocalPosition = JSON.stringify(sheathRig.position.toArray())
      canvas.dataset.swordWorldPosition = JSON.stringify(sword.getWorldPosition(swordWorldPosition).toArray())
      canvas.dataset.sheathWorldPosition = JSON.stringify(sheath.getWorldPosition(sheathWorldPosition).toArray())
    }
    canvas.dataset.inspectionActive = String(inspection.active)
    canvas.dataset.inspectionBlend = inspectionBlend.toFixed(4)
    canvas.dataset.inspectionYaw = inspection.currentYaw.toFixed(4)
    canvas.dataset.inspectionPitch = inspection.currentPitch.toFixed(4)
    canvas.dataset.inspectionZoom = inspection.currentZoom.toFixed(4)
    canvas.dataset.inspectionBaseZoom = inspection.baseZoom.toFixed(4)

    renderer.render(scene, camera)
  }

  /* ── Resize handling ─────────────────────────────────── */
  const resizeRenderer = () => {
    const width = Math.max(canvas.clientWidth, 1)
    const height = Math.max(canvas.clientHeight, 1)
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5)
    renderer.setPixelRatio(pixelRatio)
    renderer.setSize(width, height, false)
    emberUniforms.uPixelRatio.value = pixelRatio
    camera.aspect = width / height
    camera.updateProjectionMatrix()
  }
  const resizeObserver = new ResizeObserver(resizeRenderer)
  resizeObserver.observe(canvas)
  resizeRenderer()
  frameId = requestAnimationFrame(render)

  /* ── Public API ──────────────────────────────────────── */
  return {
    renderer,
    scene,
    camera,
    cameraRig,
    chapterCameraRig,
    modelPivot,
    restingTransform,
    chapterPivot,
    waveState,
    emberState,
    draw,
    sheathMotion,
    payoff,
    chapterMatch,
    cameraMotion,
    inspection,
    setExtractionLighting,
    resize: resizeRenderer,
    lights: { key, rim, fill, engraving, accent, sheathFill, bladeSweep, ambient },
    targets: lightTargets,
    model: {
      sword,
      sheath,
      weaponRig,
      swordMatchPivot,
      sheathMatchPivot,
      swordRig,
      sheathRig,
      inspectionPlacement,
      inspectionOrbit,
      inspectionOffset,
      meshCount,
      hierarchy,
      dimensions: sourceSize.toArray(),
      extractionAxisWorld: extractionWorldAxis.toArray(),
      extractionVectorLocal: extractionVector.toArray(),
      extractionDistanceWorld: drawDistance,
      swordRigCorrectionLocal: swordRigAlignedPosition.toArray(),
      swordRigPerpendicularCorrectionLocal: correctionPerpendicular.toArray(),
      centerlineDirectionErrorDegrees: THREE.MathUtils.radToDeg(centerlineDirectionError),
      screenMovementProof: {
        sword: swordScreenDiagnosticDistance,
        sheath: sheathScreenDiagnosticDistance,
      },
      swordOriginal: {
        position: swordStart.toArray(),
        quaternion: swordStartQuaternion.toArray(),
        scale: swordStartScale.toArray(),
      },
    },
    dispose() {
      cancelAnimationFrame(frameId)
      resizeObserver.disconnect()
      window.removeEventListener('pointermove', onPointerMove)
      scene.traverse((object) => {
        object.geometry?.dispose?.()
        const materials = object.material
          ? (Array.isArray(object.material) ? object.material : [object.material])
          : []
        materials.forEach((mat) => {
          for (const value of Object.values(mat)) {
            value?.isTexture && value.dispose()
          }
          mat.dispose?.()
        })
      })
      renderer.renderLists.dispose()
      renderer.dispose()
      renderer.forceContextLoss()
    },
  }
}
