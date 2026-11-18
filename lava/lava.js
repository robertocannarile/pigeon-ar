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
  },

  init() {
    this.revealStart = -1
    this.origin = new THREE.Vector2()
    this.camPos = new THREE.Vector3()

    const sceneEl = this.el.sceneEl
    if (sceneEl.renderer) {
      this.build()
    } else {
      sceneEl.addEventListener('renderstart', () => this.build(), {once: true})
    }

    // 8th Wall emette realityready quando il feed camera e il tracking sono partiti.
    // Fallback a tempo nel caso l'evento sia gia' passato o non arrivi.
    const start = () => {
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
        varying vec3 vWorld;

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
          gl_FragColor = vec4(c, alpha);
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
    this.el.sceneEl.object3D.add(this.mesh)
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
