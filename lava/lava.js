/* Lava AR — il pavimento diventa lava liquida fino all'orizzonte. */

/**
 * Pavimento di lava.
 *
 * Un piano di 800 x 800 m a y = 0 (il pavimento stimato dallo SLAM) con uno shader
 * proprio, non illuminato: la lava emette luce, non la riceve, quindi niente luci in scena.
 *
 * Effetto liquido: la texture di emissione (ambientCG Lava004, CC0) viene campionata due
 * volte con scale e direzioni di scorrimento diverse, e le coordinate vengono deformate
 * dalla normal map che scorre a sua volta. Il calore risultante passa per una rampa di
 * colore (crosta nera -> rosso -> arancio -> giallo). In lontananza sfuma in un bagliore
 * uniforme che nasconde ripetizione e aliasing.
 *
 * Comparsa: quando tracking e riconoscimento sono pronti la lava si allarga a cerchio
 * dai piedi dell'utente, con un bordo incandescente, fino all'orizzonte.
 *
 * Maschera del suolo (8th Wall non da' profondita' ne' segmentazione, solo il cielo):
 *  - Il feed camera e' gia' nel canvas quando la lava viene disegnata (8th Wall lo
 *    disegna prima e A-Frame non cancella il colore). Nell'onBeforeRender della lava,
 *    quando serve un nuovo fotogramma, il framebuffer viene copiato in una texture.
 *  - Al tick successivo quella texture viene rimpicciolita su GPU, letta e mandata al
 *    worker SegFormer (seg-worker.js), che restituisce la probabilita' di "suolo" per
 *    pixel. Il worker lavora in parallelo: la lava resta a pieno frame rate.
 *  - Riproiezione: con ogni maschera si conserva la matrice view-projection della camera
 *    al momento dello scatto. Lo shader proietta il proprio punto del pavimento con
 *    quella matrice: la maschera resta ancorata al mondo anche se nel frattempo il
 *    telefono si e' girato (per le rotazioni pure la correzione e' esatta).
 *  - Due maschere (precedente e nuova) in dissolvenza, per non avere scatti.
 */
AFRAME.registerComponent('lava-floor', {
  schema: {
    emission: {default: './assets/lava_emission.jpg'},
    normal: {default: './assets/lava_normalgl.jpg'},
    tile: {default: 3.0},        // metri coperti da una ripetizione della texture
    flow: {default: 1.0},        // velocita' dello scorrimento
    glow: {default: 1.25},       // luminosita' complessiva
    size: {default: 800},        // lato del piano in metri
    delay: {default: 800},       // ms minimi tra tracking pronto e inizio della colata
    spread: {default: 0.9},      // velocita' di espansione (m/s^2 circa)
    hint: {type: 'selector'},
    mask: {default: true},       // lava solo dove il modello vede suolo
    worker: {default: './seg-worker.js?v=4'},
    segSize: {default: 384},     // lato lungo dell'immagine data al modello (multiplo di 32)
    threshold: {default: 0.5},   // probabilita' di suolo oltre cui c'e' lava
    fade: {default: 140},        // ms di dissolvenza tra una maschera e la successiva
  },

  init() {
    this.revealStart = -1
    this.origin = new THREE.Vector2()
    this.camPos = new THREE.Vector3()

    // Stato della maschera.
    this.realityOn = false
    this.segReady = false
    this.segFailed = false
    this.segBusy = false
    this.wantCopy = false
    this.haveCopy = false
    this.firstMask = false
    this.reqId = 0
    this.pending = new Map()          // id richiesta -> matrice VP allo scatto
    this.copyVP = new THREE.Matrix4()
    this.drawSize = new THREE.Vector2()
    this.stats = {device: '—', ms: 0, fps: 0, count: 0, t0: performance.now(), error: ''}

    const sceneEl = this.el.sceneEl
    if (sceneEl.renderer) {
      this.build()
    } else {
      sceneEl.addEventListener('renderstart', () => this.build(), {once: true})
    }

    if (this.data.mask) { this.startWorker() }

    // 8th Wall emette realityready quando il feed camera e il tracking sono partiti.
    const onReality = () => {
      if (this.realityOn) { return }
      this.realityOn = true
      this.realityAt = performance.now()
    }
    sceneEl.addEventListener('realityready', onReality, {once: true})
    // Fallback se l'evento e' gia' passato o non arriva.
    this.fallback = setTimeout(onReality, 9000)
  },

  // Backend in ordine di preferenza: WebGPU (veloce, modello fp32 da 15 MB) e, se manca
  // o fallisce, WASM (sempre disponibile, modello quantizzato da 4 MB). Ogni tentativo
  // in un worker nuovo: un fallimento lascia onnxruntime inutilizzabile nel worker.
  startWorker() {
    this.setHint('Carico il riconoscimento del suolo…')
    this.backends = []
    if (navigator.gpu) { this.backends.push({device: 'webgpu', dtype: 'fp32'}) }
    this.backends.push({device: 'wasm', dtype: 'q8'})
    this.nextBackend()
  },

  nextBackend(reason) {
    if (this.worker) { this.worker.terminate(); this.worker = null }
    const opt = this.backends.shift()
    if (!opt) { this.segFail(reason || 'nessun backend disponibile'); return }
    if (reason) { console.warn('[lava] backend fallito, provo', opt.device, '-', reason) }
    try {
      this.worker = new Worker(this.data.worker, {type: 'module'})
    } catch (e) {
      this.segFail(e)
      return
    }
    this.worker.onmessage = (e) => this.onWorker(e.data)
    this.worker.onerror = (e) => {
      if (this.segReady) { this.stats.error = String(e.message || e) } else { this.nextBackend(e.message || e) }
    }
    this.worker.postMessage({type: 'init', ...opt})
  },

  onWorker(msg) {
    if (msg.type === 'ready') {
      this.segReady = true
      this.stats.device = `${msg.device} ${msg.dtype}`
      this.setHint('Inquadra il pavimento e muovi piano il telefono')
    } else if (msg.type === 'mask') {
      this.applyMask(msg)
      this.segBusy = false
    } else if (msg.type === 'log') {
      console.log('[lava/seg]', msg.message)
    } else if (msg.type === 'error') {
      this.segBusy = false
      if (msg.stage === 'init') { this.nextBackend(msg.message) } else { this.stats.error = msg.message }
    }
  },

  segFail(err) {
    console.warn('[lava] riconoscimento del suolo non disponibile:', err)
    this.segFailed = true
    this.stats.error = String(err)
    this.stats.device = 'non disponibile'
    this.setHint('Inquadra il pavimento e muovi piano il telefono')
  },

  setHint(text) {
    if (this.data.hint && this.revealStart < 0) { this.data.hint.textContent = text }
  },

  build() {
    const {renderer} = this.el.sceneEl
    const loader = new THREE.TextureLoader()
    const aniso = renderer.capabilities.getMaxAnisotropy()

    const load = (url, srgb) => {
      const t = loader.load(url)
      t.wrapS = t.wrapT = THREE.RepeatWrapping
      t.anisotropy = aniso
      if (srgb) { t.colorSpace = THREE.SRGBColorSpace }
      return t
    }

    const emptyMask = () => {
      const t = new THREE.DataTexture(new Uint8Array([255]), 1, 1, THREE.RedFormat)
      t.magFilter = t.minFilter = THREE.LinearFilter
      t.needsUpdate = true
      return t
    }

    this.uniforms = {
      uEmission: {value: load(this.data.emission, true)},
      uNormal: {value: load(this.data.normal, false)},
      uTime: {value: 0},
      uTile: {value: this.data.tile},
      uGlow: {value: this.data.glow},
      uCam: {value: new THREE.Vector2()},
      uOrigin: {value: this.origin},
      uReveal: {value: 0},
      uMaskA: {value: emptyMask()},
      uMaskB: {value: emptyMask()},
      uVPA: {value: new THREE.Matrix4()},
      uVPB: {value: new THREE.Matrix4()},
      uMaskMix: {value: 1},
      uMaskOn: {value: 0},
      uThreshold: {value: this.data.threshold},
      uShowMask: {value: 0},
    }

    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */`
        varying vec3 vWorld;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform sampler2D uEmission;
        uniform sampler2D uNormal;
        uniform float uTime;
        uniform float uTile;
        uniform float uGlow;
        uniform vec2 uCam;
        uniform vec2 uOrigin;
        uniform float uReveal;
        uniform sampler2D uMaskA;
        uniform sampler2D uMaskB;
        uniform mat4 uVPA;
        uniform mat4 uVPB;
        uniform float uMaskMix;
        uniform float uMaskOn;
        uniform float uThreshold;
        uniform float uShowMask;
        varying vec3 vWorld;

        // Probabilita' di suolo per questo punto del pavimento, letta dalla maschera
        // proiettando il punto con la camera di quando la maschera e' stata scattata.
        // Fuori dall'inquadratura di allora non si sa nulla: si assume suolo.
        float groundAt(sampler2D tex, mat4 vp) {
          vec4 c = vp * vec4(vWorld, 1.0);
          if (c.w <= 0.0) return 1.0;
          vec2 uv = c.xy / c.w * 0.5 + 0.5;
          if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 1.0;
          // La maschera ha le righe dall'alto: si capovolge v.
          return texture2D(tex, vec2(uv.x, 1.0 - uv.y)).r;
        }

        void main() {
          vec2 p = vWorld.xz / uTile;
          float t = uTime;

          // Corrente lenta della normal map: deforma le coordinate delle altre due.
          vec2 n1 = texture2D(uNormal, p * 0.35 + t * vec2(0.011, 0.007)).xy * 2.0 - 1.0;
          vec2 n2 = texture2D(uNormal, p * 0.21 - t * vec2(0.006, 0.010)).yx * 2.0 - 1.0;
          vec2 warp = (n1 + n2) * 0.11;

          // Due correnti di lava che si incrociano.
          vec3 a = texture2D(uEmission, p + warp + t * vec2(0.035, 0.018)).rgb;
          vec3 b = texture2D(uEmission, p.yx * 1.31 - warp * 0.8 + t * vec2(-0.022, 0.031)).rgb;
          float la = dot(a, vec3(0.299, 0.587, 0.114));
          float lb = dot(b, vec3(0.299, 0.587, 0.114));

          // Calore: dove le due correnti sono entrambe calde nasce un fiume incandescente,
          // dove una e' fredda si forma crosta.
          float heat = sqrt(la * lb) * 1.75;

          // Variazione a grande scala (decine di metri): rompe la griglia di ripetizione.
          float big = texture2D(uNormal, p * 0.045 + t * vec2(0.002, 0.0015)).r;
          heat *= 0.45 + 1.0 * smoothstep(0.25, 0.75, big);

          // Pulsazione lenta del calore, sfasata nello spazio.
          heat *= 0.9 + 0.1 * sin(t * 1.1 + p.x * 0.9 + p.y * 0.7);

          // Rampa di temperatura: crosta quasi nera -> rosso cupo -> arancio -> giallo-bianco.
          vec3 c = vec3(0.025, 0.006, 0.004);
          c = mix(c, vec3(0.45, 0.03, 0.01), smoothstep(0.10, 0.38, heat));
          c = mix(c, vec3(1.00, 0.22, 0.02), smoothstep(0.33, 0.62, heat));
          c = mix(c, vec3(1.00, 0.62, 0.12), smoothstep(0.58, 0.85, heat));
          c = mix(c, vec3(1.00, 0.92, 0.60), smoothstep(0.82, 1.10, heat));
          c *= 0.85 + 0.3 * mix(a, b, 0.5) / max(0.2, (la + lb) * 0.5);
          c *= uGlow;

          // Lontananza: sfuma in un bagliore uniforme verso l'orizzonte.
          float d = length(vWorld.xz - uCam);
          vec3 haze = vec3(1.0, 0.36, 0.06);
          c = mix(c, haze, smoothstep(12.0, 140.0, d));

          // Comparsa a cerchio dai piedi dell'utente, con bordo incandescente.
          float r = length(vWorld.xz - uOrigin);
          float alpha = 1.0 - smoothstep(uReveal - 0.25, uReveal, r);
          float rim = smoothstep(uReveal - 0.9, uReveal - 0.15, r) * alpha;
          c += vec3(1.0, 0.65, 0.25) * rim * 1.8;

          if (alpha <= 0.001) discard;

          float m = 1.0;
          if (uMaskOn > 0.5) {
            float g = mix(groundAt(uMaskA, uVPA), groundAt(uMaskB, uVPB), uMaskMix);
            m = smoothstep(uThreshold - 0.12, uThreshold + 0.12, g);
          }

          if (uShowMask > 0.5) {
            // Debug: arancio = suolo (lava), blu = non suolo (resta reale).
            gl_FragColor = vec4(mix(vec3(0.1, 0.35, 1.0), vec3(1.0, 0.4, 0.0), m), 0.6 * alpha);
          } else {
            if (m * alpha <= 0.001) discard;
            gl_FragColor = vec4(c, alpha * m);
          }
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    })

    const geometry = new THREE.PlaneGeometry(this.data.size, this.data.size)
    geometry.rotateX(-Math.PI / 2)
    this.mesh = new THREE.Mesh(geometry, material)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 1
    this.mesh.onBeforeRender = (r, scene, camera) => this.beforeLava(r, camera)
    this.el.sceneEl.object3D.add(this.mesh)

    // Passaggio di riduzione: disegna la copia del feed in un render target piccolo.
    this.downScene = new THREE.Scene()
    this.downCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    this.downMat = new THREE.ShaderMaterial({
      uniforms: {uSrc: {value: null}},
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D uSrc;
        varying vec2 vUv;
        void main() { gl_FragColor = vec4(texture2D(uSrc, vUv).rgb, 1.0); }
      `,
    })
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.downMat)
    quad.frustumCulled = false
    this.downScene.add(quad)
  },

  /**
   * Dentro il render, un attimo prima di disegnare la lava: nel canvas c'e' ancora solo
   * il feed camera. Se e' stato chiesto un fotogramma, lo copia con la sua camera.
   */
  beforeLava(renderer, camera) {
    if (!this.wantCopy || renderer.getRenderTarget() !== null) { return }
    renderer.getDrawingBufferSize(this.drawSize)
    const w = this.drawSize.x
    const h = this.drawSize.y
    if (!this.camTex || this.camTex.image.width !== w || this.camTex.image.height !== h) {
      if (this.camTex) { this.camTex.dispose() }
      this.camTex = new THREE.FramebufferTexture(w, h)
      this.camTex.minFilter = this.camTex.magFilter = THREE.LinearFilter
    }
    renderer.copyFramebufferToTexture(this.camTex)
    this.copyVP.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    this.wantCopy = false
    this.haveCopy = true
  },

  // Fuori dal render: riduce la copia, la legge e la manda al worker.
  sendFrame() {
    const {renderer} = this.el.sceneEl
    const w = this.camTex.image.width
    const h = this.camTex.image.height
    // Lato lungo = segSize, l'altro in proporzione, entrambi multipli di 32.
    const L = this.data.segSize
    const r32 = (v) => Math.max(64, Math.round(v / 32) * 32)
    const sw = w >= h ? r32(L) : r32(L * w / h)
    const sh = w >= h ? r32(L * h / w) : r32(L)

    if (!this.downRT || this.downRT.width !== sw || this.downRT.height !== sh) {
      if (this.downRT) { this.downRT.dispose() }
      this.downRT = new THREE.WebGLRenderTarget(sw, sh, {depthBuffer: false})
    }
    this.downMat.uniforms.uSrc.value = this.camTex
    const prevRT = renderer.getRenderTarget()
    const prevTM = renderer.toneMapping
    renderer.toneMapping = THREE.NoToneMapping
    renderer.setRenderTarget(this.downRT)
    renderer.render(this.downScene, this.downCam)
    renderer.setRenderTarget(prevRT)
    renderer.toneMapping = prevTM

    const pixels = new Uint8Array(sw * sh * 4)
    renderer.readRenderTargetPixels(this.downRT, 0, 0, sw, sh, pixels)

    const id = ++this.reqId
    this.pending.set(id, this.copyVP.clone())
    this.segBusy = true
    this.worker.postMessage({type: 'run', id, w: sw, h: sh, pixels}, [pixels.buffer])
  },

  applyMask({id, mw, mh, mask, ms}) {
    const vp = this.pending.get(id)
    this.pending.delete(id)
    if (!vp || !this.uniforms) { return }

    const u = this.uniforms
    // La maschera corrente (B) diventa la precedente (A); la nuova va nella texture
    // che era A, riusata se ha la misura giusta.
    const recycled = u.uMaskA.value
    u.uMaskA.value = u.uMaskB.value
    u.uVPA.value.copy(u.uVPB.value)

    let tex = recycled
    if (!tex || tex === u.uMaskA.value || tex.image.width !== mw || tex.image.height !== mh) {
      if (tex && tex !== u.uMaskA.value) { tex.dispose() }
      tex = new THREE.DataTexture(mask, mw, mh, THREE.RedFormat)
      tex.magFilter = tex.minFilter = THREE.LinearFilter
    } else {
      tex.image.data = mask
    }
    tex.needsUpdate = true
    u.uMaskB.value = tex
    u.uVPB.value.copy(vp)

    if (!this.firstMask) {
      // Prima maschera: niente dissolvenza da quella vuota.
      this.firstMask = true
      u.uMaskA.value = tex
      u.uVPA.value.copy(vp)
    }
    this.maskAt = performance.now()
    u.uMaskMix.value = 0

    const s = this.stats
    s.ms = s.ms ? s.ms * 0.8 + ms * 0.2 : ms
    s.count++
    const now = performance.now()
    if (now - s.t0 > 1000) { s.fps = s.count * 1000 / (now - s.t0); s.count = 0; s.t0 = now }
  },

  startReveal() {
    clearTimeout(this.fallback)
    const cam = this.el.sceneEl.camera
    if (cam) {
      cam.getWorldPosition(this.camPos)
      this.origin.set(this.camPos.x, this.camPos.z)
    }
    this.revealStart = performance.now()
    if (this.data.hint) { this.data.hint.classList.add('hidden') }
    this.el.sceneEl.emit('lava-start', {origin: this.origin})
  },

  tick(time) {
    if (!this.uniforms) { return }
    const u = this.uniforms
    // Il tempo resta piccolo per non perdere precisione nello shader dopo ore.
    u.uTime.value = ((time / 1000) * this.data.flow) % 3600

    const cam = this.el.sceneEl.camera
    if (cam) {
      cam.getWorldPosition(this.camPos)
      u.uCam.value.set(this.camPos.x, this.camPos.z)
    }

    // Ciclo del riconoscimento: chiedi copia -> (render) -> invia -> attendi risposta.
    const segOn = this.data.mask && this.segReady && this.realityOn
    if (segOn && !this.segBusy) {
      if (this.haveCopy) {
        this.haveCopy = false
        this.sendFrame()
      } else {
        this.wantCopy = true
      }
    }
    u.uMaskOn.value = this.data.mask && this.firstMask ? 1 : 0
    if (this.maskAt) {
      u.uMaskMix.value = Math.min(1, (performance.now() - this.maskAt) / this.data.fade)
    }

    // La colata parte quando il tracking e' pronto e, se attivo, il primo riconoscimento
    // e' arrivato (o e' fallito, o ci mette troppo).
    if (this.revealStart < 0 && this.realityOn) {
      const since = performance.now() - this.realityAt
      const segDone = !this.data.mask || this.firstMask || this.segFailed || since > 30000
      if (since > this.data.delay && segDone) { this.startReveal() }
    }

    if (this.revealStart >= 0) {
      const s = (performance.now() - this.revealStart) / 1000
      // Parte lenta ai piedi e accelera: ~4 m a 2 s, ~25 m a 5 s, orizzonte entro ~20 s.
      const r = 0.6 + this.data.spread * Math.pow(s, 2.3)
      u.uReveal.value = Math.min(r, this.data.size)
    }
  },

  remove() {
    clearTimeout(this.fallback)
    if (this.worker) { this.worker.terminate() }
    if (this.camTex) { this.camTex.dispose() }
    if (this.downRT) { this.downRT.dispose() }
    if (this.mesh) {
      this.el.sceneEl.object3D.remove(this.mesh)
      this.mesh.geometry.dispose()
      this.mesh.material.dispose()
    }
  },
})

/**
 * Braci che salgono dalla lava attorno all'utente.
 *
 * Un unico THREE.Points con shader: ogni brace ha posizione e fase casuali in un volume
 * attorno alla camera e viene "riavvolta" nello shader quando l'utente si sposta, cosi'
 * ce ne sono sempre attorno senza ricrearle. Fusione additiva, nessuna scrittura di
 * profondita'. Appaiono solo dove la lava e' gia' arrivata.
 */
AFRAME.registerComponent('lava-embers', {
  schema: {
    count: {default: 260},
    radius: {default: 7},        // semi-lato del volume attorno alla camera (m)
    height: {default: 3.2},      // quota massima prima di spegnersi (m)
    size: {default: 0.02},       // diametro della brace (m)
  },

  init() {
    const {count, radius} = this.data
    const base = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      base[i * 3] = (Math.random() * 2 - 1) * radius
      base[i * 3 + 1] = Math.random()            // fase di salita
      base[i * 3 + 2] = (Math.random() * 2 - 1) * radius
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(base, 3))

    this.camPos = new THREE.Vector3()
    this.uniforms = {
      uTime: {value: 0},
      uCam: {value: new THREE.Vector2()},
      uRadius: {value: radius},
      uHeight: {value: this.data.height},
      uSize: {value: this.data.size},
      uScale: {value: window.innerHeight},
      uOrigin: {value: new THREE.Vector2()},
      uReveal: {value: 0},
    }

    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */`
        uniform float uTime;
        uniform vec2 uCam;
        uniform float uRadius;
        uniform float uHeight;
        uniform float uSize;
        uniform float uScale;
        uniform vec2 uOrigin;
        uniform float uReveal;
        varying float vLife;

        void main() {
          vec3 b = position;
          float speed = 0.25 + fract(b.x * 13.7 + b.z * 7.3) * 0.45;
          float life = fract(b.y + uTime * speed / uHeight);

          // Riavvolge xz attorno alla camera.
          vec2 rel = mod(b.xz - uCam + uRadius, 2.0 * uRadius) - uRadius;
          vec2 xz = uCam + rel;
          xz += vec2(sin(uTime * 0.9 + b.y * 40.0), cos(uTime * 0.7 + b.x * 3.0)) * 0.12 * life;

          vec3 w = vec3(xz.x, life * uHeight, xz.y);
          float inside = step(length(xz - uOrigin), uReveal);
          vLife = life * inside;

          vec4 mv = viewMatrix * vec4(w, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = inside * uSize * uScale / max(-mv.z, 0.2) * (1.0 - life * 0.6);
        }
      `,
      fragmentShader: /* glsl */`
        varying float vLife;
        void main() {
          vec2 q = gl_PointCoord - 0.5;
          float d = length(q);
          if (d > 0.5 || vLife <= 0.0) discard;
          float core = smoothstep(0.5, 0.0, d);
          // Nasce gialla, si raffredda in rosso e si spegne salendo.
          vec3 col = mix(vec3(1.0, 0.85, 0.4), vec3(1.0, 0.25, 0.03), vLife);
          float fade = smoothstep(0.0, 0.08, vLife) * (1.0 - smoothstep(0.55, 1.0, vLife));
          gl_FragColor = vec4(col * core * fade * 1.6, core * fade);
        }
      `,
    })

    this.points = new THREE.Points(geometry, material)
    this.points.frustumCulled = false
    this.points.renderOrder = 2
    this.el.sceneEl.object3D.add(this.points)
  },

  tick(time) {
    this.uniforms.uTime.value = (time / 1000) % 3600
    // gl_PointSize e' in pixel del drawing buffer, non CSS: serve l'altezza reale del canvas.
    const {canvas} = this.el.sceneEl
    if (canvas) { this.uniforms.uScale.value = canvas.height }
    const cam = this.el.sceneEl.camera
    if (cam) {
      cam.getWorldPosition(this.camPos)
      this.uniforms.uCam.value.set(this.camPos.x, this.camPos.z)
    }
    // Segue la comparsa del pavimento, se presente.
    const floor = this.el.components['lava-floor']
    if (floor && floor.uniforms) {
      this.uniforms.uReveal.value = floor.uniforms.uReveal.value
      this.uniforms.uOrigin.value.copy(floor.origin)
    }
  },

  remove() {
    this.el.sceneEl.object3D.remove(this.points)
    this.points.geometry.dispose()
    this.points.material.dispose()
  },
})

/**
 * Pannello di taratura, aperto con doppio tap. Temporaneo: a valori trovati si fissano
 * come attributi di lava-floor e si toglie (componente + #tuner).
 */
AFRAME.registerComponent('lava-tuner', {
  schema: {panel: {type: 'selector'}},

  init() {
    const panel = this.data.panel
    if (!panel) { return }
    this.floor = () => this.el.components['lava-floor']
    this.out = panel.querySelector('#tuner-out')

    let lastTap = 0
    window.addEventListener('touchend', (e) => {
      if (panel.contains(e.target) || e.touches.length) { return }
      const now = performance.now()
      if (now - lastTap < 320) { panel.hidden = !panel.hidden; lastTap = 0 } else { lastTap = now }
    })
    window.addEventListener('dblclick', () => { panel.hidden = !panel.hidden })

    panel.querySelectorAll('input[type=range]').forEach((input) => {
      const key = input.dataset.key
      const label = panel.querySelector(`[data-out="${key}"]`)
      const apply = () => {
        const f = this.floor()
        if (!f || !f.uniforms) { return }
        const val = parseFloat(input.value)
        if (key === 'threshold') { f.uniforms.uThreshold.value = val }
        if (key === 'glow') { f.uniforms.uGlow.value = val }
        label.textContent = val.toFixed(2)
      }
      input.addEventListener('input', apply)
      this.el.sceneEl.addEventListener('renderstart', () => setTimeout(apply, 0), {once: true})
    })

    panel.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const f = this.floor()
        if (!f || !f.uniforms) { return }
        const a = btn.dataset.action
        if (a === 'mask') {
          f.data.mask = !f.data.mask
          btn.textContent = f.data.mask ? 'Maschera: on' : 'Maschera: off'
        }
        if (a === 'show') {
          const on = f.uniforms.uShowMask.value < 0.5
          f.uniforms.uShowMask.value = on ? 1 : 0
          btn.textContent = on ? 'Vedi lava' : 'Vedi maschera'
        }
      })
    })
  },

  tick(time) {
    const panel = this.data.panel
    if (!panel || panel.hidden || time - (this.lastUi || 0) < 250) { return }
    this.lastUi = time
    const f = this.floor()
    if (!f || !f.uniforms) { return }
    const s = f.stats
    this.out.textContent =
      `modello: ${s.device}\n` +
      `analisi: ${s.ms ? s.ms.toFixed(0) : '—'} ms · ${s.fps.toFixed(1)} al secondo\n` +
      `threshold: ${f.uniforms.uThreshold.value.toFixed(2)}; glow: ${f.uniforms.uGlow.value.toFixed(2)}` +
      (s.error ? `\nerrore: ${s.error.slice(0, 120)}` : '')
  },
})
