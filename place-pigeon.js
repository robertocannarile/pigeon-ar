/* Pigeon AR — posizionamento a terra e riproduzione dell'animazione. */

/**
 * Environment map procedurale.
 *
 * I materiali PBR del glb senza environment map non hanno nulla da riflettere: le
 * superfici lisce restituiscono nero e il modello risulta spento, per quante luci
 * direzionali si aggiungano. Qui si genera al volo una equirettangolare a gradiente
 * (cielo -> orizzonte -> terra) e la si passa al PMREMGenerator, che la converte nella
 * mipmap pre-filtrata che three.js usa come illuminazione ambientale.
 *
 * RoomEnvironment non e' incluso nel bundle di A-Frame, da qui il gradiente fatto a mano:
 * nessun file esterno da scaricare e i colori restano regolabili dall'HTML.
 */
AFRAME.registerComponent('env-light', {
  schema: {
    sky: {default: '#b9cfe4'},
    horizon: {default: '#efe9dd'},
    ground: {default: '#6f6659'},
    intensity: {default: 1.0},
  },

  init() {
    const sceneEl = this.el.sceneEl || this.el
    if (sceneEl.renderer) {
      this.build()
    } else {
      sceneEl.addEventListener('renderstart', () => this.build(), {once: true})
    }
  },

  build() {
    const sceneEl = this.el.sceneEl || this.el
    const {renderer} = sceneEl
    if (!renderer) { return }

    const canvas = document.createElement('canvas')
    canvas.width = 32
    canvas.height = 128
    const ctx = canvas.getContext('2d')

    const grad = ctx.createLinearGradient(0, 0, 0, canvas.height)
    grad.addColorStop(0.00, this.data.sky)
    grad.addColorStop(0.48, this.data.horizon)
    grad.addColorStop(0.52, this.data.ground)
    grad.addColorStop(1.00, this.data.ground)
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    const texture = new THREE.CanvasTexture(canvas)
    texture.mapping = THREE.EquirectangularReflectionMapping
    texture.colorSpace = THREE.SRGBColorSpace

    const pmrem = new THREE.PMREMGenerator(renderer)
    pmrem.compileEquirectangularShader()
    const envMap = pmrem.fromEquirectangular(texture).texture

    sceneEl.object3D.environment = envMap
    sceneEl.object3D.environmentIntensity = this.data.intensity

    texture.dispose()
    pmrem.dispose()
  },
})

/**
 * Riproduce le clip di animazione contenute in un glTF.
 * Sostituisce animation-mixer di aframe-extras, che qui sarebbe l'unica dipendenza in più.
 */
AFRAME.registerComponent('play-clip', {
  schema: {
    clip: {default: ''},        // nome della clip; vuoto = la prima disponibile
    fromFrame: {default: -1},   // taglio: primo frame incluso (-1 = clip intera)
    toFrame: {default: -1},     // taglio: ultimo frame incluso
    fps: {default: 24},         // frame rate con cui e' stata autorata l'animazione
    loop: {default: true},
    timeScale: {default: 1},
  },

  init() {
    this.mixer = null
    this.el.addEventListener('model-loaded', e => this.onModelLoaded(e.detail.model))
  },

  onModelLoaded(model) {
    const clips = model.animations
    if (!clips || clips.length === 0) { return }

    let clip = this.data.clip
      ? THREE.AnimationClip.findByName(clips, this.data.clip)
      : clips[0]
    if (!clip) { return }

    // Taglio a intervallo di frame: subclip riscala i keyframe e riporta il tempo a zero,
    // cosi' il loop riparte dal primo frame del ritaglio e non dall'inizio della clip.
    const {fromFrame, toFrame, fps} = this.data
    if (fromFrame >= 0 && toFrame > fromFrame) {
      clip = THREE.AnimationUtils.subclip(clip, `${clip.name}_${fromFrame}_${toFrame}`,
        fromFrame, toFrame, fps)
    }

    this.mixer = new THREE.AnimationMixer(model)
    const action = this.mixer.clipAction(clip)
    action.setLoop(this.data.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity)
    action.clampWhenFinished = !this.data.loop
    action.play()

    // castShadow e envMapIntensity vanno impostati nodo per nodo: three.js non li eredita.
    model.traverse((node) => {
      if (!node.isMesh) { return }
      node.castShadow = true
      const materials = Array.isArray(node.material) ? node.material : [node.material]
      materials.forEach((m) => {
        if (m && 'envMapIntensity' in m) {
          m.envMapIntensity = 1.0
          m.needsUpdate = true
        }
      })
    })
  },

  tick(time, timeDelta) {
    if (this.mixer) { this.mixer.update(timeDelta / 1000) }
  },

  remove() {
    if (this.mixer) { this.mixer.stopAllAction() }
  },
})

/**
 * Adatta la shadow camera della luce direzionale alla dimensione attuale del modello.
 *
 * La shadow camera di una luce direzionale e' ortografica e ha bounds fissi: tarati per un
 * piccione di 40 cm, un piccione di 40 metri finisce interamente fuori dal volume e l'ombra
 * sparisce. Qui i bounds e la distanza della luce seguono il raggio del bounding box.
 */
AFRAME.registerComponent('shadow-fit', {
  schema: {
    light: {type: 'selector'},
    target: {type: 'selector'},
    interval: {default: 250},
  },

  init() {
    this.box = new THREE.Box3()
    this.sphere = new THREE.Sphere()
    this.dir = new THREE.Vector3()
    this.lastRadius = -1
    this.sinceCheck = 0
  },

  tick(time, timeDelta) {
    // Throttle a mano: ricalcolare il bounding box a 60 fps sarebbe sprecato.
    this.sinceCheck += timeDelta
    if (this.sinceCheck < this.data.interval) { return }
    this.sinceCheck = 0

    const targetEl = this.data.target
    const lightEl = this.data.light
    if (!targetEl || !lightEl || !targetEl.getAttribute('visible')) { return }

    const model = targetEl.getObject3D('mesh')
    const light = lightEl.getObject3D('light')
    if (!model || !light || !light.shadow) { return }

    this.box.setFromObject(model)
    if (this.box.isEmpty()) { return }
    this.box.getBoundingSphere(this.sphere)

    const radius = this.sphere.radius
    // Ricalcolare la shadow camera a ogni frame costa; si aggiorna solo su variazioni reali.
    if (Math.abs(radius - this.lastRadius) < this.lastRadius * 0.05) { return }
    this.lastRadius = radius

    const extent = radius * 1.5
    const cam = light.shadow.camera
    cam.top = extent
    cam.bottom = -extent
    cam.left = -extent
    cam.right = extent
    cam.near = 0.1
    cam.far = radius * 12
    cam.updateProjectionMatrix()

    // La luce va allontanata insieme all'oggetto, mantenendo la direzione impostata
    // nell'HTML, altrimenti finisce dentro al modello.
    this.dir.copy(lightEl.object3D.position).normalize()
    lightEl.object3D.position.copy(this.dir).multiplyScalar(radius * 4)
    light.target.position.copy(this.sphere.center)
    light.target.updateMatrixWorld()
  },
})

/**
 * Pannello di taratura on-device: esposizione, intensita' delle luci e scala del modello.
 *
 * I valori giusti per la luce si trovano guardando il modello nella scena reale, non a
 * schermo. "Copia valori" restituisce la riga da incollare nell'HTML. Una volta fissati i
 * valori, questo componente e il markup #tuner si possono togliere.
 */
AFRAME.registerComponent('light-tuner', {
  schema: {
    sun: {type: 'selector'},
    hemi: {type: 'selector'},
    target: {type: 'selector'},
    minScale: {default: 0.5},
    maxScale: {default: 150},
    doubleTapMs: {default: 320},   // finestra entro cui due tap contano come doppio tap
    doubleTapPx: {default: 40},    // e distanza massima tra i due
  },

  init() {
    this.panel = document.querySelector('#tuner')
    this.out = document.querySelector('#tuner-out')
    if (!this.panel) { return }

    this.inputs = {}
    this.panel.querySelectorAll('input[data-key]').forEach((input) => {
      this.inputs[input.dataset.key] = input
      input.addEventListener('input', () => this.apply(input.dataset.key))
    })

    this.bindDoubleTap()
    this.panel.querySelector('[data-action="reset"]')
      .addEventListener('click', () => this.readFromScene())
    this.panel.querySelector('[data-action="copy"]')
      .addEventListener('click', () => this.copy())

    const sceneEl = this.el.sceneEl || this.el
    if (sceneEl.renderer) {
      this.readFromScene()
    } else {
      sceneEl.addEventListener('renderstart', () => this.readFromScene(), {once: true})
    }
  },

  /**
   * Doppio tap sul canvas per aprire e chiudere il pannello.
   *
   * Non collide con il piazzamento, che richiede 600 ms di pressione ferma: due tap brevi
   * non lo attivano. Il pannello e' un overlay DOM sopra al canvas, quindi toccare gli
   * slider non arriva fin qui e non lo richiude.
   */
  bindDoubleTap() {
    this.lastTap = 0
    this.lastTapPos = {x: 0, y: 0}

    const canvas = this.el.canvas || document
    this.tapSurface = canvas

    this.onTapEnd = (e) => {
      // Dita ancora sullo schermo o piu' di un tocco: e' un gesto, non un tap.
      if (e.touches && e.touches.length > 0) { return }
      if (e.changedTouches && e.changedTouches.length > 1) { return }

      const t = e.changedTouches ? e.changedTouches[0] : e
      const now = Date.now()
      const near = Math.hypot(t.clientX - this.lastTapPos.x, t.clientY - this.lastTapPos.y)

      if (now - this.lastTap < this.data.doubleTapMs && near < this.data.doubleTapPx) {
        this.panel.hidden = !this.panel.hidden
        if (!this.panel.hidden) { this.readFromScene() }
        this.lastTap = 0
        return
      }

      this.lastTap = now
      this.lastTapPos = {x: t.clientX, y: t.clientY}
    }

    canvas.addEventListener('touchend', this.onTapEnd, {passive: true})
    canvas.addEventListener('mouseup', this.onTapEnd)
  },

  /** La scala usa una curva logaritmica: 0.5x e 150x devono stare sullo stesso slider. */
  scaleFromSlider(t) {
    const {minScale, maxScale} = this.data
    return minScale * Math.pow(maxScale / minScale, t)
  },

  sliderFromScale(s) {
    const {minScale, maxScale} = this.data
    return Math.log(s / minScale) / Math.log(maxScale / minScale)
  },

  readFromScene() {
    const sceneEl = this.el.sceneEl || this.el
    const sun = this.data.sun && this.data.sun.getAttribute('light')
    const hemi = this.data.hemi && this.data.hemi.getAttribute('light')

    this.set('exposure', sceneEl.renderer ? sceneEl.renderer.toneMappingExposure : 1)
    this.set('env', sceneEl.object3D.environmentIntensity || 0)
    this.set('sun', sun ? sun.intensity : 0)
    this.set('hemi', hemi ? hemi.intensity : 0)

    const scale = this.data.target ? this.data.target.object3D.scale.x : 1
    this.inputs.scale.value = this.sliderFromScale(scale)
    this.label('scale', scale)
    this.report()
  },

  set(key, value) {
    if (!this.inputs[key]) { return }
    this.inputs[key].value = value
    this.label(key, value)
  },

  label(key, value) {
    const el = this.panel.querySelector(`[data-out="${key}"]`)
    if (!el) { return }
    el.textContent = key === 'scale' ? `${value.toFixed(1)}×` : Number(value).toFixed(2)
  },

  apply(key) {
    const sceneEl = this.el.sceneEl || this.el
    const value = parseFloat(this.inputs[key].value)

    switch (key) {
      case 'exposure':
        sceneEl.renderer.toneMappingExposure = value
        break
      case 'env':
        sceneEl.object3D.environmentIntensity = value
        break
      case 'sun':
        this.data.sun.setAttribute('light', 'intensity', value)
        break
      case 'hemi':
        this.data.hemi.setAttribute('light', 'intensity', value)
        break
      case 'scale': {
        const s = this.scaleFromSlider(value)
        this.data.target.object3D.scale.set(s, s, s)
        this.label('scale', s)
        this.report()
        return
      }
      default:
        return
    }
    this.label(key, value)
    this.report()
  },

  values() {
    const scale = this.scaleFromSlider(parseFloat(this.inputs.scale.value))
    return {
      exposure: parseFloat(this.inputs.exposure.value),
      env: parseFloat(this.inputs.env.value),
      sun: parseFloat(this.inputs.sun.value),
      hemi: parseFloat(this.inputs.hemi.value),
      scale,
    }
  },

  report() {
    if (!this.out) { return }
    const v = this.values()
    this.out.textContent =
      `exposure: ${v.exposure} | env: ${v.env} | sun: ${v.sun} | hemi: ${v.hemi} ` +
      `| scala: ${v.scale.toFixed(1)}x`
  },

  copy() {
    const text = this.out.textContent
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(
        () => { this.out.textContent = `${text}  ✓ copiato` },
        () => {})
    }
  },
})

/**
 * Pressione prolungata sul pavimento: piazza il modello nel punto tenuto premuto.
 *
 * Il tap breve e' volutamente inerte. Con il tap si spostava il piccione per sbaglio a ogni
 * tocco, e ogni spostamento riazzerava la rotazione impostata a mano. Il piazzamento e' un
 * gesto raro e deliberato, quindi va dietro a una pressione lunga.
 *
 * I touch si gestiscono direttamente invece di usare l'evento 'click' del cursor A-Frame:
 * servono la durata, lo spostamento del dito e soprattutto il conteggio delle dita, perche'
 * il primo dito di un pinch farebbe altrimenti partire un piazzamento.
 */
AFRAME.registerComponent('tap-place', {
  schema: {
    target: {type: 'selector'},
    ground: {type: 'selector'},
    hint: {type: 'selector'},
    progress: {type: 'selector'},
    holdMs: {default: 600},
    moveTolerance: {default: 20},   // px oltre i quali il gesto e' un drag, non una pressione
  },

  init() {
    this.raycaster = new THREE.Raycaster()
    this.ndc = new THREE.Vector2()
    this.placed = false
    this.timer = null
    this.start = null

    this.onDown = this.onDown.bind(this)
    this.onMove = this.onMove.bind(this)
    this.onUp = this.onUp.bind(this)

    const canvas = this.el.canvas || document
    this.surface = canvas
    canvas.addEventListener('touchstart', this.onDown, {passive: true})
    canvas.addEventListener('touchmove', this.onMove, {passive: true})
    canvas.addEventListener('touchend', this.onUp, {passive: true})
    canvas.addEventListener('touchcancel', this.onUp, {passive: true})
    // Fallback da desktop, comodo per provare la scena senza telefono.
    canvas.addEventListener('mousedown', this.onDown)
    canvas.addEventListener('mousemove', this.onMove)
    canvas.addEventListener('mouseup', this.onUp)
  },

  pointOf(e) {
    const t = e.touches && e.touches.length ? e.touches[0] : e
    return t.clientX === undefined ? null : {x: t.clientX, y: t.clientY}
  },

  onDown(e) {
    // Piu' di un dito significa pinch o rotazione: non e' un piazzamento.
    if (e.touches && e.touches.length > 1) { return this.cancel() }

    const p = this.pointOf(e)
    if (!p) { return }
    this.start = p
    this.showProgress(p)
    this.timer = setTimeout(() => this.place(this.start), this.data.holdMs)
  },

  onMove(e) {
    if (!this.timer) { return }
    if (e.touches && e.touches.length > 1) { return this.cancel() }

    const p = this.pointOf(e)
    if (!p) { return }
    const dist = Math.hypot(p.x - this.start.x, p.y - this.start.y)
    if (dist > this.data.moveTolerance) { this.cancel() }
  },

  onUp() {
    this.cancel()
  },

  cancel() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.hideProgress()
  },

  /** Converte le coordinate schermo in un punto sul piano del pavimento. */
  hitGround(screen) {
    const cam = this.el.camera
    const groundObj = this.data.ground && this.data.ground.getObject3D('mesh')
    if (!cam || !groundObj) { return null }

    this.ndc.set(
      (screen.x / window.innerWidth) * 2 - 1,
      -(screen.y / window.innerHeight) * 2 + 1)
    this.raycaster.setFromCamera(this.ndc, cam)
    const hits = this.raycaster.intersectObject(groundObj, false)
    return hits.length ? hits[0].point : null
  },

  place(screen) {
    this.timer = null
    this.hideProgress()

    const point = this.hitGround(screen)
    if (!point) { return }

    const target = this.data.target
    target.object3D.position.copy(point)

    // L'orientamento verso la camera si applica solo al primo piazzamento: dopo, la
    // rotazione e' una scelta dell'utente e gli spostamenti non devono cancellarla.
    if (!this.placed) { this.faceCamera(target) }
    target.setAttribute('visible', true)

    if (!this.placed) {
      this.placed = true
      if (this.data.hint) {
        this.data.hint.textContent = 'Pizzica per la scala · due dita per ruotare'
        setTimeout(() => this.data.hint.classList.add('hidden'), 3500)
      }
    }
  },

  showProgress(p) {
    const el = this.data.progress
    if (!el) { return }
    el.style.left = `${p.x}px`
    el.style.top = `${p.y}px`
    el.style.transitionDuration = `${this.data.holdMs}ms`
    el.hidden = false
    // Un frame di ritardo, altrimenti il browser accorpa i due stati e la transizione salta.
    requestAnimationFrame(() => el.classList.add('active'))
  },

  hideProgress() {
    const el = this.data.progress
    if (!el) { return }
    el.classList.remove('active')
    el.hidden = true
  },

  faceCamera(target) {
    const cam = this.el.camera
    if (!cam) { return }
    const dx = cam.position.x - target.object3D.position.x
    const dz = cam.position.z - target.object3D.position.z
    target.object3D.rotation.set(0, Math.atan2(dx, dz), 0)
  },

  remove() {
    this.cancel()
    const c = this.surface
    c.removeEventListener('touchstart', this.onDown)
    c.removeEventListener('touchmove', this.onMove)
    c.removeEventListener('touchend', this.onUp)
    c.removeEventListener('touchcancel', this.onUp)
    c.removeEventListener('mousedown', this.onDown)
    c.removeEventListener('mousemove', this.onMove)
    c.removeEventListener('mouseup', this.onUp)
  },
})
