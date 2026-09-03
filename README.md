# Pigeon AR

Esperienza di realtà aumentata da browser: rileva il pavimento, tocchi, appare un piccione
a scala reale che cammina in loop.

Costruita con il motore **8th Wall** (open source dal 28/02/2026, `8thwall.org`) + **A-Frame**.
Nessun account, nessuna App Key, nessun abbonamento.

## Struttura

```
Pigeon/
├─ Model/pigeon.glb        # sorgente originale
├─ README.md
└─ app/                    # <- questa cartella è il sito da pubblicare
   ├─ index.html
   ├─ place-pigeon.js
   └─ assets/pigeon.glb
```

## Come funziona

1. Apri il link → il browser chiede fotocamera e sensori di movimento
2. Muovi il telefono qualche secondo → lo SLAM aggancia il piano del pavimento
3. Compare un **reticolo bianco** a terra sotto il puntamento
4. **Tap** → il piccione si posiziona lì, rivolto verso di te, con ombra
5. **Pinch** = scala · **due dita** = rotazione · **tap altrove** = sposta

Il modello è 0,42 × 0,21 × 0,22 m, cioè la taglia di un piccione vero. Scala 1:1.

## Test in locale

La fotocamera richiede **HTTPS** (o `localhost`): da telefono serve un tunnel.

```bash
cd app
npx --yes serve -p 3000
# in un altro terminale
npx --yes ngrok http 3000
```

Apri sul telefono l'URL `https://...ngrok...` che ti stampa.

## Pubblicazione

Va bene qualsiasi hosting statico. Il contenuto da caricare è **`app/`**.

**GitHub Pages**

```bash
git init && git add . && git commit -m "Pigeon AR"
git branch -M main
git remote add origin git@github.com:<utente>/pigeon-ar.git
git push -u origin main
# Settings → Pages → Source: main, folder /app
```

**Netlify** — trascina la cartella `app/` su https://app.netlify.com/drop

## Requisiti dispositivo

- iOS 14.3+ (Safari, Chrome, Firefox) · Android 8+ (Chrome, Samsung Internet)
- HTTPS obbligatorio
- Primo caricamento ~8 MB (il `.glb`). Su 4G circa 10 s.

## Licenze

- Framework e `xrextras`: MIT
- Motore SLAM (`@8thwall/engine-binary`): licenza limited-use, gratuita anche per uso
  commerciale. Non modificabile né decompilabile. **Richiede attribuzione a Niantic Spatial.**
  Vedi https://8thwall.org/docs/open-source

## Note tecniche

- Il rilevamento del piano non usa WebXR hit-test (assente su iOS) ma lo SLAM di 8th Wall,
  che assume la camera a ~1,6 m da terra. Se il piccione sembra fluttuare o affondare,
  si regola `position` della `<a-camera>` in `index.html`.
- `play-clip` in `place-pigeon.js` sostituisce `animation-mixer` di aframe-extras, per
  evitare una dipendenza in più: riproduce la clip `Take 001` del glb.
