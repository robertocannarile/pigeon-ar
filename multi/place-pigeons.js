/* Pigeon AR — variante multipla: piu' piccioni nella stessa scena, uno attivo per volta. */

/**
 * Piazzamento multiplo con un solo piccione "attivo".
 *
 * Differenze rispetto a tap-place della versione singola:
 *
 * - la pressione lunga crea una nuova entita' invece di spostare sempre la stessa;
 * - il tap breve, li' inerte, qui seleziona il piccione che tocchi;
 * - xrextras-pinch-scale e xrextras-two-finger-rotate vivono solo sull'entita' attiva e
 *   si spostano su un'altra quando cambi selezione. Quei due componenti ascoltano
 *   'twofingermove' sulla scena, quindi lasciarli su tutti i piccioni li farebbe reagire
 *   tutti insieme allo stesso gesto.
 *
 * pinch-scale fotografa la scala dell'entita' al proprio init e applica min/max come
 * moltiplicatori di quella: riselezionando un piccione gia' a 50x, un max di 200 vorrebbe
 * dire 10.000x. Per questo i limiti si ricalcolano a ogni selezione in rapporto alla scala
 * corrente, cosi' restano assoluti.
 */
AFRAME.registerComponent('multi-place', {
  schema: {
    ground: {type: 'selector'},
    hint: {type: 'selector'},
    progress: {type: 'selector'},
    model: {default: '#pigeon-model'},
    fromFrame: {default: 840},      // stesso ritaglio della versione singola
    toFrame: {default: 1664},
    fps: {default: 24},
    minScale: {default: 0.5},
    maxScale: {default: 200},
    holdMs: {default: 600},
    tapMs: {default: 250},          // oltre questa durata non e' piu' un tap
    moveTolerance: {default: 20},   // px oltre i quali il gesto e' un drag
  },

  init() {
    this.raycaster = new THREE.Raycaster()
    this.ndc = new THREE.Vector2()
    this.pigeons = []
    this.active = null
    this.timer = null
    this.hintTimer = null
    this.start = null
    this.startTime = 0
    this.moved = false

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
    // Piu' di un dito significa pinch o rotazione: non e' ne' un tap ne' un piazzamento.
    if (e.touches && e.touches.length > 1) { return this.cancel() }

    const p = this.pointOf(e)
    if (!p) { return }
    this.start = p
    this.startTime = Date.now()
    this.moved = false
    this.showProgress(p)
    this.timer = setTimeout(() => this.addPigeon(this.start), this.data.holdMs)
  },

  onMove(e) {
    if (!this.timer) { return }
    if (e.touches && e.touches.length > 1) { return this.cancel() }

    const p = this.pointOf(e)
    if (!p) { return }
    if (Math.hypot(p.x - this.start.x, p.y - this.start.y) > this.data.moveTolerance) {
      this.moved = true
      this.cancel()
    }
  },

  onUp(e) {
    // timer ancora vivo = la pressione lunga non e' scattata, quindi puo' essere un tap.
    const pending = !!this.timer
    const start = this.start
    const moved = this.moved
    const duration = Date.now() - this.startTime
    this.cancel()

    if (!pending || !start || moved) { return }
    if (duration > this.data.tapMs) { return }
    // Sollevare il secondo dito di un gesto non e' un tap.
    if (e.changedTouches && e.changedTouches.length > 1) { return }

    this.selectAt(start)
  },

  cancel() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.start = null
    this.hideProgress()
  },

  /** Converte le coordinate schermo in un punto sul piano del pavimento. */
  hitGround(screen) {
    const cam = this.el.camera
    const groundObj = this.data.ground && this.data.ground.getObject3D('mesh')
    if (!cam || !groundObj) { return null }

    this.setRay(screen)
    const hits = this.raycaster.intersectObject(groundObj, false)
    return hits.length ? hits[0].point : null
  },

  setRay(screen) {
    this.ndc.set(
      (screen.x / window.innerWidth) * 2 - 1,
      -(screen.y / window.innerHeight) * 2 + 1)
    this.raycaster.setFromCamera(this.ndc, this.el.camera)
  },

  addPigeon(screen) {
    this.timer = null
    this.hideProgress()

    const point = this.hitGround(screen)
    if (!point) { return }

    const el = document.createElement('a-entity')
    el.setAttribute('gltf-model', this.data.model)
    el.setAttribute('play-clip', {
      fromFrame: this.data.fromFrame,
      toFrame: this.data.toFrame,
      fps: this.data.fps,
      loop: true,
    })
    el.setAttribute('shadow', 'cast: true; receive: false')
    // position e rotation via setAttribute: object3D non esiste ancora all'append.
    el.setAttribute('position', {x: point.x, y: point.y, z: point.z})
    el.setAttribute('rotation', {x: 0, y: this.yawToCamera(point), z: 0})

    this.el.appendChild(el)
    this.pigeons.push(el)
    this.select(el)
  },

  /** Gradi di rotazione sull'asse Y perche' il piccione guardi la camera. */
  yawToCamera(point) {
    const cam = this.el.camera
    if (!cam) { return 0 }
    return THREE.MathUtils.radToDeg(
      Math.atan2(cam.position.x - point.x, cam.position.z - point.z))
  },

  /** Tap: trova il piccione piu' vicino sotto il dito e lo rende attivo. */
  selectAt(screen) {
    if (!this.el.camera || this.pigeons.length === 0) { return }
    this.setRay(screen)

    let best = null
    let bestDist = Infinity
    this.pigeons.forEach((el) => {
      const mesh = el.getObject3D('mesh')
      if (!mesh) { return }
      const hits = this.raycaster.intersectObject(mesh, true)
      if (hits.length && hits[0].distance < bestDist) {
        bestDist = hits[0].distance
        best = el
      }
    })

    if (best) { this.select(best) }
  },

  select(el) {
    if (this.active === el) { return }

    if (this.active) {
      this.active.removeAttribute('xrextras-pinch-scale')
      this.active.removeAttribute('xrextras-two-finger-rotate')
    }
    this.active = el

    // Limiti assoluti, espressi come moltiplicatori della scala attuale: vedi il commento
    // in testa al componente.
    const scale = (el.object3D && el.object3D.scale.x) || 1
    el.setAttribute('xrextras-pinch-scale', {
      min: this.data.minScale / scale,
      max: this.data.maxScale / scale,
    })
    el.setAttribute('xrextras-two-finger-rotate', '')

    // L'ombra si adatta al piccione su cui stai lavorando.
    this.el.setAttribute('shadow-fit', 'target', el)

    const n = this.pigeons.length
    if (n === 1) {
      this.showHint('Pizzica per la scala · tocca un piccione per sceglierlo', 4000)
    } else {
      this.showHint(`Piccione ${this.pigeons.indexOf(el) + 1} di ${n}`, 1500)
    }
  },

  showHint(text, hideAfter) {
    const el = this.data.hint
    if (!el) { return }
    el.textContent = text
    el.classList.remove('hidden')
    clearTimeout(this.hintTimer)
    this.hintTimer = setTimeout(() => el.classList.add('hidden'), hideAfter)
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

  remove() {
    this.cancel()
    clearTimeout(this.hintTimer)
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
