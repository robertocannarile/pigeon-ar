# Pigeon AR

**→ https://robertocannarile.github.io/pigeon-ar/**

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
   ├─ index.html
   ├─ place-pigeon.js
   └─ assets/pigeon.glb
```

## Come funziona

1. Apri il link → il browser chiede fotocamera e sensori di movimento
2. Muovi il telefono qualche secondo → lo SLAM aggancia il piano del pavimento
3. **Tieni premuto 600 ms** sul pavimento: un cerchio si stringe sotto il dito, poi il
   piccione appare lì con la sua ombra. Il tap breve è volutamente inerte
4. **Pinch** = scala (fino a 150×) · **due dita che ruotano** = rotazione
5. **Doppio tap** = pannello di taratura della luce (temporaneo, vedi `HANDOFF.md`)

L'orientamento verso la camera si applica solo al primo piazzamento: dopo, spostare il
piccione non cancella la rotazione impostata a mano.

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
- Motore SLAM (`@8thwall/engine-binary`): licenza limited-use, gratuita anche per uso
  commerciale. Non modificabile né decompilabile. **Richiede attribuzione a Niantic Spatial.**
  Vedi https://8thwall.org/docs/open-source

## Note tecniche

- Il rilevamento del piano non usa WebXR hit-test (assente su iOS) ma lo SLAM di 8th Wall,
  che assume la camera a ~1,6 m da terra. Se il piccione sembra fluttuare o affondare,
  si regola `position` della `<a-camera>` in `index.html`.
- `play-clip` in `place-pigeon.js` sostituisce `animation-mixer` di aframe-extras, per
  evitare una dipendenza in più: riproduce la clip `Take 001` del glb.
