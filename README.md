# Pigeon AR

**Un piccione → https://robertocannarile.github.io/pigeon-ar/**
**Più piccioni → https://robertocannarile.github.io/pigeon-ar/multi/**
**Pavimento di lava → https://robertocannarile.github.io/pigeon-ar/lava/** (non ancora pubblicata)

Esperienza di realtà aumentata da browser: tieni premuto sul pavimento e appare un piccione
a scala reale che cammina in loop.

Costruita con il motore **8th Wall** (open source dal 28/02/2026, `8thwall.org`) + **A-Frame**.
Nessun account, nessuna App Key, nessun abbonamento.

## Struttura

```
Pigeon/
├─ Model/pigeon.glb        # sorgente originale
├─ README.md
└─ app/                    # <- questa cartella è il sito da pubblicare
   ├─ index.html           # versione a un piccione
   ├─ place-pigeon.js      # env-light, play-clip, shadow-fit, light-tuner, tap-place
   ├─ assets/pigeon.glb
   └─ multi/               # versione a più piccioni, stesso glb
      ├─ index.html
      └─ place-pigeons.js  # solo multi-place; il resto lo riusa da ../place-pigeon.js
   └─ lava/                # variante senza piccione: tutto il pavimento è lava
      ├─ index.html
      ├─ lava.js           # lava-floor (shader + maschera), lava-embers, lava-tuner
      ├─ seg-worker.js     # SegFormer in Web Worker: probabilità di suolo per pixel
      └─ assets/           # ambientCG Lava004 (CC0): emission + normal, 1K
```

## Come funziona

1. Apri il link → il browser chiede fotocamera e sensori di movimento
2. Muovi il telefono qualche secondo → lo SLAM aggancia il piano del pavimento
3. **Tieni premuto 600 ms** sul pavimento: un cerchio si stringe sotto il dito, poi il
   piccione appare lì con la sua ombra. Il tap breve è volutamente inerte
4. **Pinch** = scala (fino a 200×) · **due dita che ruotano** = rotazione
5. **Doppio tap** = pannello di taratura della luce (temporaneo, vedi `HANDOFF.md`)

L'orientamento verso la camera si applica solo al primo piazzamento: dopo, spostare il
piccione non cancella la rotazione impostata a mano.

### Versione a più piccioni (`/multi/`)

Stessi gesti, ma la pressione prolungata **aggiunge** un piccione invece di spostare quello
che c'è. Il nuovo diventa l'attivo; **tap breve su un piccione** lo rende attivo a sua volta,
e l'hint in basso mostra quale. Pinch e rotazione agiscono solo sull'attivo: i componenti
`xrextras-pinch-scale` e `xrextras-two-finger-rotate` ascoltano `twofingermove` sulla scena,
quindi lasciarli su tutti li farebbe reagire tutti insieme, e vivono solo sull'attivo.

`pinch-scale` fotografa la scala dell'entità al proprio init e tratta `min`/`max` come
moltiplicatori di quella: perché i limiti restino assoluti, `multi-place` li ricalcola a ogni
selezione in rapporto alla scala corrente.

Non c'è modo di togliere un piccione: per ripulire si ricarica la pagina. `shadow-fit` segue
l'attivo, quindi con un gigante in scena l'ombra di un piccolo molto lontano può uscire dai
bounds della shadow camera.

### Variante lava (`/lava/`)

Nessun piccione e nessun gesto. A tracking pronto la lava si allarga a cerchio dai piedi
dell'utente fino all'orizzonte (~20 s), con braci che salgono attorno.

Il pavimento è un piano di 800 m con shader non illuminato: la texture di emissione di
ambientCG `Lava004` è campionata due volte con scorrimenti incrociati e deformata dalla
normal map, per l'effetto liquido. Il calore passa poi per una rampa di colore (crosta
nera → rosso → arancio → giallo) e sfuma in un bagliore uniforme verso l'orizzonte.
Parametri regolabili come attributi di `lava-floor` in `index.html`: `tile`, `flow`,
`glow`, `spread`.

**Maschera del suolo (AI).** 8th Wall non dà profondità né segmentazione (solo il cielo),
quindi la lava compare solo dove un modello di segmentazione vede *suolo*: SegFormer-B0
ADE20K (`Xenova/segformer-b0-finetuned-ade-512-512`) via transformers.js 3.8.1, in un Web
Worker (`seg-worker.js`). Categorie suolo: floor, road, grass, sidewalk, earth, rug, field,
sand, path, runway, dirt track, land. Persone, auto, mobili, muri restano reali.

- Il fotogramma si prende dal canvas (che contiene già il feed camera) un attimo prima
  di disegnare la lava, ridotto a lato lungo 384 px su GPU e mandato al worker.
- Riproiezione: ogni maschera porta con sé la camera dello scatto, e lo shader proietta
  il punto del pavimento con quella. La maschera resta ferma sul mondo mentre il
  telefono gira, anche se il modello va a pochi fotogrammi al secondo.
- Backend: WebGPU fp32 (15 MB), altrimenti WASM q8 (4 MB). Ogni tentativo in un worker
  nuovo: la variante fp16 su WebGPU fallisce e lascia onnxruntime rotto nel worker.
- La colata parte quando arriva la prima maschera.

Doppio tap = pannello (soglia suolo, luminosità, vedi maschera, on/off, backend e
velocità del modello) — temporaneo, da togliere a valori fissati.

Il modello è 0,42 × 0,21 × 0,22 m, cioè la taglia di un piccione vero. Scala 1:1.

## Test in locale

La fotocamera richiede **HTTPS** (o `localhost`): da telefono serve un tunnel.

```bash
cd app
npx --yes serve -p 3000
# in un altro terminale
npx --yes cloudflared tunnel --url http://localhost:3000
```

Apri sul telefono l'URL `https://...trycloudflare.com` che stampa.

Nota: `serve` fa clean-URL, `/index.html` redirige a `/index`. Provando con `curl` serve
`-L`, altrimenti sembra che il file sia vuoto.

## Pubblicazione

Già pubblicato su GitHub Pages: **https://robertocannarile.github.io/pigeon-ar/**

Il sito è il contenuto di `app/`, servito dal branch `gh-pages`. Per pubblicare le modifiche:

```bash
git add -A && git commit -m "..."
git push
git subtree push --prefix app origin gh-pages
```

Il primo push aggiorna il repo, il secondo il sito. Se `subtree push` viene rifiutato perché
la storia è divergente, rifare con
`git push origin $(git subtree split --prefix app main):gh-pages --force`.

## Requisiti dispositivo

- iOS 14.3+ (Safari, Chrome, Firefox) · Android 8+ (Chrome, Samsung Internet)
- HTTPS obbligatorio
- Primo caricamento ~8 MB (il `.glb`). Su 4G circa 10 s.

## Licenze

- Framework e `xrextras`: MIT
- Texture lava: ambientCG `Lava004`, CC0 (nessuna attribuzione richiesta)
- Motore SLAM (`@8thwall/engine-binary`): licenza limited-use, gratuita anche per uso
  commerciale. Non modificabile né decompilabile. **Richiede attribuzione a Niantic Spatial.**
  Vedi https://8thwall.org/docs/open-source

## Note tecniche

- Il rilevamento del piano non usa WebXR hit-test (assente su iOS) ma lo SLAM di 8th Wall,
  che assume la camera a ~1,6 m da terra. Se il piccione sembra fluttuare o affondare,
  si regola `position` della `<a-camera>` in `index.html`.
- `play-clip` in `place-pigeon.js` sostituisce `animation-mixer` di aframe-extras, per
  evitare una dipendenza in più: riproduce la clip `Take 001` del glb.
