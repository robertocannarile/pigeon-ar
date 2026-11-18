/* Lava AR — riconoscimento del suolo con SegFormer, in un Web Worker.
 *
 * Modello: SegFormer-B0 addestrato su ADE20K (150 categorie), versione ONNX di Xenova.
 * Per ogni pixel restituisce la probabilita' che sia "suolo" (pavimento, strada,
 * marciapiede, erba, terra, ...), sommando le probabilita' di quelle categorie.
 *
 * Messaggi:
 *   -> {type: 'init', device, dtype}
 *   <- {type: 'ready', device, dtype} | {type: 'error', message}
 *   -> {type: 'run', id, w, h, pixels}   pixels: RGBA Uint8, righe dal basso (readPixels)
 *   <- {type: 'mask', id, mw, mh, mask, ms}  mask: Uint8 0..255, righe dall'alto
 */
import {AutoModel, Tensor, env} from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js'

env.allowLocalModels = false
// Senza cross-origin isolation (GitHub Pages non la consente) i thread WASM non ci sono;
// lasciarli in automatico dentro un worker fa fallire la creazione della sessione.
env.backends.onnx.wasm.numThreads = 1

const MODEL = 'Xenova/segformer-b0-finetuned-ade-512-512'

// Categorie ADE20K considerate suolo calpestabile.
const GROUND = [
  3,   // floor
  6,   // road
  9,   // grass
  11,  // sidewalk
  13,  // earth
  28,  // rug
  29,  // field
  46,  // sand
  52,  // path
  54,  // runway
  91,  // dirt track
  94,  // land
]
const isGround = new Uint8Array(150)
GROUND.forEach((i) => { isGround[i] = 1 })

const MEAN = [0.485, 0.456, 0.406]
const STD = [0.229, 0.224, 0.225]

let model = null

// Un solo tentativo per worker: un backend che fallisce (per esempio WebGPU fp16) lascia
// onnxruntime in uno stato che fa fallire anche i tentativi successivi nello stesso
// worker. La scelta del backend e i ripieghi li gestisce il thread principale, che in
// caso di errore chiude il worker e ne apre uno nuovo con il backend successivo.
async function load({device, dtype}) {
  if (device === 'webgpu') {
    const adapter = self.navigator && navigator.gpu && await navigator.gpu.requestAdapter()
    if (!adapter) { throw new Error('WebGPU non disponibile') }
  }
  model = await AutoModel.from_pretrained(MODEL, {device, dtype})
  // Prova a vuoto: alcuni backend falliscono solo alla prima esecuzione.
  await model({pixel_values: new Tensor('float32', new Float32Array(3 * 128 * 128), [1, 3, 128, 128])})
}

async function run({id, w, h, pixels}) {
  const t0 = performance.now()
  const n = w * h
  const data = new Float32Array(3 * n)
  // Da RGBA righe-dal-basso a NCHW righe-dall'alto, normalizzato come in addestramento.
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * w * 4
    const dst = y * w
    for (let x = 0; x < w; x++) {
      const s = src + x * 4
      const d = dst + x
      data[d] = (pixels[s] / 255 - MEAN[0]) / STD[0]
      data[n + d] = (pixels[s + 1] / 255 - MEAN[1]) / STD[1]
      data[2 * n + d] = (pixels[s + 2] / 255 - MEAN[2]) / STD[2]
    }
  }

  const out = await model({pixel_values: new Tensor('float32', data, [1, 3, h, w])})
  const logits = out.logits
  const [, classes, mh, mw] = logits.dims
  const L = logits.data
  const plane = mh * mw
  const mask = new Uint8Array(plane)

  // Probabilita' di suolo = somma softmax delle categorie suolo.
  for (let p = 0; p < plane; p++) {
    let max = -Infinity
    for (let c = 0; c < classes; c++) {
      const v = L[c * plane + p]
      if (v > max) { max = v }
    }
    let total = 0
    let ground = 0
    for (let c = 0; c < classes; c++) {
      const e = Math.exp(L[c * plane + p] - max)
      total += e
      if (isGround[c]) { ground += e }
    }
    mask[p] = Math.round((ground / total) * 255)
  }

  self.postMessage({type: 'mask', id, mw, mh, mask, ms: performance.now() - t0}, [mask.buffer])
}

self.onmessage = async (e) => {
  const msg = e.data
  try {
    if (msg.type === 'init') {
      await load(msg)
      self.postMessage({type: 'ready', device: msg.device, dtype: msg.dtype})
    } else if (msg.type === 'run' && model) {
      await run(msg)
    }
  } catch (err) {
    self.postMessage({type: 'error', id: msg.id, stage: msg.type, message: String(err && err.message || err)})
  }
}
