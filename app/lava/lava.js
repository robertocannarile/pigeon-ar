/* Lava AR — il pavimento diventa lava liquida fino all'orizzonte. */

/**
 * Pavimento di lava.
 *
 * Un piano di 800 x 800 m a y = 0 (il pavimento stimato dallo SLAM) con uno shader
 * proprio, non illuminato: la lava emette luce, non la riceve, quindi niente luci in scena.
 *
 * Effetto liquido: la texture di emissione (ambientCG Lava004, CC0) viene campionata due
 * volte con scale e direzioni di scorrimento diverse, e le coordinate vengono deformate
 * dalla normal map che scorre a sua volta. Le due correnti che si incrociano danno il
 * movimento fluido senza che si veda la ripetizione della texture.
 *
 * Le UV derivano dalla posizione nel mondo (non dalla geometria), cosi' la grana resta
 * della stessa misura ovunque. In lontananza la texture sfuma in un bagliore uniforme:
 * nasconde ripetizione e aliasing verso l'orizzonte.
 *
 * Comparsa: a tracking pronto la lava si allarga a cerchio partendo dai piedi
 * dell'utente, con un bordo incandescente, fino all'orizzonte.
 *
 * Maschera del pavimento (8th Wall non da' profondita' ne' segmentazione, solo il cielo):
 * la lava compare solo dove l'immagine della camera somiglia al pavimento.
 *  - Il feed camera e' gia' nel canvas quando la lava viene disegnata (8th Wall lo
 *    disegna prima e A-Frame non cancella il colore). Nell'onBeforeRender della lava il
 *    framebuffer viene copiato in una texture: e' l'immagine reale, allineata pixel per
 *    pixel allo schermo, che lo shader confronta con un colore di riferimento.
 *  - Il riferimento si misura leggendo 9 punti a terra tra 1,6 e 3,4 m davanti alla
 *    camera (non sotto: li' ci sono i piedi), con la mediana per ignorare un intruso.
 *    Poi si aggiorna lentamente ogni mezzo secondo, solo con i campioni che gia' gli
 *    somigliano: segue luce ed esposizione senza farsi trascinare da un oggetto.
 *  - Confronto: conta soprattutto la tinta (cromaticita'); la luminosita' e' tollerata
 *    entro un margine, cosi' le ombre restano pavimento.
 */
AFRAME.registerComponent('lava-floor', {
  schema: {
    emission: {default: './assets/lava_emission.jpg'},
    normal: {default: './assets/lava_normalgl.jpg'},
    tile: {default: 3.0},        // metri coperti da una ripetizione della texture
    flow: {default: 1.0},        // velocita' dello scorrimento
    glow: {default: 1.25},       // luminosita' complessiva
    size: {default: 800},        // lato del piano in metri
    delay: {default: 1200},      // ms tra tracking pronto e inizio della colata
    spread: {default: 0.9},      // velocita' di espansione (m/s^2 circa)
    hint: {type: 'selector'},
    mask: {default: true},       // lava solo dove l'immagine somiglia al pavimento
    thresh: {default: 0.05},     // distanza di tinta oltre cui un pixel non e' pavimento
    lumTol: {default: 1.3},      // stop di luminosita' tollerati (ombre) prima di penalizzare
    sampleMs: {default: 500},    // intervallo di aggiornamento del riferimento
  },

  init() {
    this.revealStart = -1
    this.origin = new THREE.Vector2()
    this.camPos = new THREE.Vector3()

    // Stato della maschera.
    this.ref = null                       // colore del pavimento [r,g,b] 0..1
    this.realityOn = false
    this.lastSample = 0
    this.samplesOk = 0
    this.drawSize = new THREE.Vector2()
    this.pix = new Uint8Array(5 * 5 * 4)
    this.tmp = {
      p: new THREE.Vector3(), d: new THREE.Vector3(), up: new THREE.Vector3(),
      q: new THREE.Quaternion(), v: new THREE.Vector3(),
    }

    const sceneEl = this.el.sceneEl
    if (sceneEl.renderer) {
      this.build()
    } else {
      sceneEl.addEventListener('renderstart', () => this.build(), {once: true})
    }

    // 8th Wall emette realityready quando il feed camera e il tracking sono partiti.
    // Fallback a tempo nel caso l'evento sia gia' passato o non arrivi.
    const start = () => {
      this.realityOn = true
      if (this.revealStart >= 0 || this.startTimer) { return }
      this.startTimer = setTimeout(() => this.startReveal(), this.data.delay)
    }
    sceneEl.addEventListener('realityready', start, {once: true})
    this.fallback = setTimeout(start, 9000)
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

    this.uniforms = {
      uEmission: {value: load(this.data.emission, true)},
      uNormal: {value: load(this.data.normal, false)},
      uTime: {value: 0},
      uTile: {value: this.data.tile},
      uGlow: {value: this.data.glow},
      uCam: {value: new THREE.Vector2()},
      uOrigin: {value: this.origin},
      uReveal: {value: 0},
      uCamTex: {value: null},
      uRes: {value: new THREE.Vector2(1, 1)},
      uRef: {value: new THREE.Vector3(0.5, 0.5, 0.5)},
      uMaskOn: {value: 0},
      uThresh: {value: this.data.thresh},
      uLumTol: {value: this.data.lumTol},
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
        uniform sampler2D uCamTex;
        uniform vec2 uRes;
        uniform vec3 uRef;
        uniform float uMaskOn;
        uniform float uThresh;
        uniform float uLumTol;
        uniform float uShowMask;
        varying vec3 vWorld;

        const vec3 LUMA = vec3(0.299, 0.587, 0.114);

        // Quanto il pixel reale sotto questo frammento somiglia al pavimento (1 = pavimento).
        float floorMatch() {
          vec2 uv = gl_FragCoord.xy / uRes;
          vec2 o = 2.5 / uRes;
          // Media a croce: smorza il rumore del sensore.
          vec3 s = texture2D(uCamTex, uv).rgb * 0.4
                 + (texture2D(uCamTex, uv + vec2(o.x, 0.0)).rgb
                  + texture2D(uCamTex, uv - vec2(o.x, 0.0)).rgb
                  + texture2D(uCamTex, uv + vec2(0.0, o.y)).rgb
                  + texture2D(uCamTex, uv - vec2(0.0, o.y)).rgb) * 0.15;
          vec3 cs = s / (s.r + s.g + s.b + 0.03);
          vec3 cr = uRef / (uRef.r + uRef.g + uRef.b + 0.03);
          float dC = length(cs - cr);
          float dL = max(abs(log2((dot(s, LUMA) + 0.02) / (dot(uRef, LUMA) + 0.02))) - uLumTol, 0.0);
          float diff = dC + dL * 0.15;
          return 1.0 - smoothstep(uThresh, uThresh * 1.8, diff);
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
          // dove una e' fredda si forma crosta. Il prodotto tiene il contrasto che la media
          // appiattirebbe.
          float heat = sqrt(la * lb) * 1.75;

          // Variazione a grande scala (decine di metri): zone di crosta e zone piu' vive.
          // Rompe la griglia di ripetizione della texture.
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
          // Un po' della grana originale della texture sopra la rampa.
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

          float m = uMaskOn > 0.5 ? floorMatch() : 1.0;
          if (uShowMask > 0.5) {
            // Debug: arancio = pavimento (lava), blu = oggetto (resta reale).
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
  },

  /**
   * Chiamato dentro il render, un attimo prima di disegnare la lava: nel canvas c'e'
   * ancora solo il feed camera. Lo copia nella texture della maschera e, ogni tanto,
   * legge i punti di riferimento del pavimento.
   */
  beforeLava(renderer, camera) {
    if (!this.data.mask || !this.realityOn || renderer.getRenderTarget() !== null) {
      this.uniforms.uMaskOn.value = 0
      return
    }
    renderer.getDrawingBufferSize(this.drawSize)
    const w = this.drawSize.x
    const h = this.drawSize.y
    if (!this.camTex || this.camTex.image.width !== w || this.camTex.image.height !== h) {
      if (this.camTex) { this.camTex.dispose() }
      this.camTex = new THREE.FramebufferTexture(w, h)
      this.uniforms.uCamTex.value = this.camTex
    }
    renderer.copyFramebufferToTexture(this.camTex)
    this.uniforms.uRes.value.set(w, h)

    const now = performance.now()
    const every = this.ref ? this.data.sampleMs : 150
    if (now - this.lastSample > every) {
      this.lastSample = now
      this.sampleFloor(renderer, camera, w, h)
    }
    this.uniforms.uMaskOn.value = this.ref ? 1 : 0
  },

  sampleFloor(renderer, camera, w, h) {
    const {p, d, up, q, v} = this.tmp
    camera.getWorldPosition(p)
    camera.getWorldDirection(d)
    camera.getWorldQuaternion(q)
    up.set(0, 1, 0).applyQuaternion(q)
    // Direzione "avanti" sul pavimento: funziona sia guardando dritto sia verso il basso.
    let fx = d.x + up.x
    let fz = d.z + up.z
    const len = Math.hypot(fx, fz)
    if (len < 1e-3) { return }
    fx /= len
    fz /= len

    const gl = renderer.getContext()
    const samples = []
    for (const dist of [1.6, 2.4, 3.4]) {
      for (const lat of [-0.7, 0, 0.7]) {
        v.set(p.x + fx * dist - fz * lat, 0, p.z + fz * dist + fx * lat).project(camera)
        if (Math.abs(v.x) > 0.92 || Math.abs(v.y) > 0.92 || v.z > 1) { continue }
        const x = Math.round((v.x * 0.5 + 0.5) * w) - 2
        const y = Math.round((v.y * 0.5 + 0.5) * h) - 2
        gl.readPixels(x, y, 5, 5, gl.RGBA, gl.UNSIGNED_BYTE, this.pix)
        let r = 0, g = 0, b = 0
        for (let i = 0; i < 100; i += 4) { r += this.pix[i]; g += this.pix[i + 1]; b += this.pix[i + 2] }
        samples.push([r / 6375, g / 6375, b / 6375])   // 25 pixel * 255
      }
    }

    if (!this.ref) {
      // Primo riferimento: mediana per canale, serve almeno mezzo campione buono.
      if (samples.length < 5) { this.samplesOk = samples.length; return }
      const med = (k) => samples.map((s) => s[k]).sort((a, b) => a - b)[samples.length >> 1]
      this.ref = [med(0), med(1), med(2)]
      this.samplesOk = samples.length
    } else {
      const ok = samples.filter((s) => this.colorDiff(s, this.ref) < this.uniforms.uThresh.value * 1.3)
      this.samplesOk = ok.length
      if (ok.length >= 3) {
        for (let k = 0; k < 3; k++) {
          const mean = ok.reduce((acc, s) => acc + s[k], 0) / ok.length
          this.ref[k] = this.ref[k] * 0.8 + mean * 0.2
        }
      }
    }
    this.uniforms.uRef.value.set(this.ref[0], this.ref[1], this.ref[2])
  },

  // Stessa metrica dello shader (floorMatch), lato CPU.
  colorDiff(s, ref) {
    const sum = (c) => c[0] + c[1] + c[2] + 0.03
    const luma = (c) => c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114 + 0.02
    const ss = sum(s)
    const sr = sum(ref)
    const dC = Math.hypot(s[0] / ss - ref[0] / sr, s[1] / ss - ref[1] / sr, s[2] / ss - ref[2] / sr)
    const dL = Math.max(Math.abs(Math.log2(luma(s) / luma(ref))) - this.uniforms.uLumTol.value, 0)
    return dC + dL * 0.15
  },

  // Dimentica il riferimento: verra' rimisurato dai prossimi fotogrammi.
  resample() {
    this.ref = null
    this.lastSample = 0
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
    // Il tempo resta piccolo per non perdere precisione nello shader dopo ore.
    this.uniforms.uTime.value = ((time / 1000) * this.data.flow) % 3600

    const cam = this.el.sceneEl.camera
    if (cam) {
      cam.getWorldPosition(this.camPos)
      this.uniforms.uCam.value.set(this.camPos.x, this.camPos.z)
    }

    if (this.revealStart >= 0) {
      const s = (performance.now() - this.revealStart) / 1000
      // Parte lenta ai piedi e accelera: ~4 m a 2 s, ~25 m a 5 s, orizzonte entro ~20 s.
      const r = 0.6 + this.data.spread * Math.pow(s, 2.3)
      this.uniforms.uReveal.value = Math.min(r, this.data.size)
    }
  },

  remove() {
    clearTimeout(this.fallback)
    clearTimeout(this.startTimer)
    if (this.camTex) { this.camTex.dispose() }
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
 * Pannello di taratura della maschera, aperto con doppio tap. Temporaneo: a valori
 * trovati si fissano come attributi di lava-floor e si toglie (componente + #tuner).
 */
AFRAME.registerComponent('lava-tuner', {
  schema: {panel: {type: 'selector'}},

  init() {
    const panel = this.data.panel
    if (!panel) { return }
    this.floor = () => this.el.components['lava-floor']
    this.out = panel.querySelector('#tuner-out')
    this.swatch = panel.querySelector('#tuner-swatch')

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
        if (key === 'thresh') { f.uniforms.uThresh.value = val }
        if (key === 'lumTol') { f.uniforms.uLumTol.value = val }
        if (key === 'glow') { f.uniforms.uGlow.value = val }
        label.textContent = val.toFixed(key === 'thresh' ? 3 : 2)
      }
      input.addEventListener('input', apply)
      this.el.sceneEl.addEventListener('renderstart', () => setTimeout(apply, 0), {once: true})
    })

    panel.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const f = this.floor()
        if (!f || !f.uniforms) { return }
        const a = btn.dataset.action
        if (a === 'resample') { f.resample() }
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
    const u = f.uniforms
    const ref = f.ref
    if (this.swatch) {
      this.swatch.style.background = ref
        ? `rgb(${ref.map((c) => Math.round(c * 255)).join(',')})` : 'transparent'
    }
    this.out.textContent =
      `pavimento: ${ref ? 'misurato' : 'in misura…'} · campioni buoni ${f.samplesOk}/9\n` +
      `thresh: ${u.uThresh.value.toFixed(3)}; lumTol: ${u.uLumTol.value.toFixed(2)}; ` +
      `glow: ${u.uGlow.value.toFixed(2)}`
  },
})
