# Handoff — Pigeon AR

Stato al **3 settembre 2026**. Per struttura del progetto, deploy e licenze vedi `README.md`;
qui c'è solo quello che il README non dice: perché le cose sono come sono, e cosa manca.

L'utente (Roberto) lavora **in italiano** e vuole concept e fattibilità **prima** del codice,
con un ok esplicito prima di implementare.

## In una riga

Esperienza WebAR da browser: tieni premuto sul pavimento, appare un piccione 3D animato a
scala reale, scalabile fino a gigante. Funzionante e provata su device. Manca la taratura
finale della luce e il deploy.

## Decisioni prese e perché

**8th Wall, non WebXR.** WebXR hit-test non esiste su iOS Safari. Serviva un link unico che
funzioni ovunque.

**8th Wall è cambiato sotto i piedi al progetto.** La piattaforma hosted a pagamento è stata
ritirata il 28/02/2026; ora è open source su `8thwall.org`. Conseguenze pratiche:
niente account, **niente App Key**, niente Cloud Editor, niente hosting 8thwall.app.
Il motore si carica da CDN e basta. Lo SLAM sta nel binario `@8thwall/engine-binary`
(gratuito anche per uso commerciale, non modificabile, richiede attribuzione a Niantic
Spatial); il resto è MIT. Molta documentazione in giro è **antecedente** a questo cambio e
parla di piani a pagamento e App Key: è obsoleta, non seguirla.

**Codice a mano, non 8th Wall Studio.** Scelta esplicita dell'utente: file di testo nella sua
cartella, versionabili. Lo Studio (app desktop) esiste ma renderebbe il progetto un formato
suo, più difficile da modificare via agente.

**Pressione prolungata invece del tap.** Il tap breve spostava il piccione per sbaglio e ogni
spostamento riazzerava la rotazione impostata a mano. Ora: tap breve inerte, pressione di
600 ms piazza. L'orientamento verso la camera si applica **solo al primo piazzamento**.

**Touch gestiti a mano, non con l'evento `click` di A-Frame.** Servivano durata, spostamento
del dito e **numero di dita**: senza quest'ultimo, il primo dito di un pinch faceva partire
un piazzamento.

**Reticolo rimosso** su richiesta dell'utente (due anelli concentrici sempre visibili). Il
feedback ora è solo il cerchio che si stringe sotto il dito. Effetto collaterale accettato:
non c'è più il segnale visivo che il tracking ha agganciato il pavimento.

## Dati del modello (già verificati, non rifare l'analisi)

`Model/pigeon.glb`, copiato in `app/assets/`:

- 7,8 MB · 23.804 triangoli · 132 nodi · 1 skin
- Bounding box **0,42 × 0,21 × 0,22 m** → è già a scala reale. Scala 1:1, nessuna correzione
- Una sola animazione, `Take 001`, durata 90,667 s, interpolazione LINEAR
- **24 fps** (2176 frame; dedotto da 90,667 × 24 = 2176 esatti, keyframe max 2177)
- Ritaglio richiesto dall'utente e già applicato: **frame 840 → 1664** = 35,000 s → 69,333 s,
  clip di 34,33 s in loop

## Componenti scritti (`app/place-pigeon.js`)

| Componente | Sta su | Fa |
|---|---|---|
| `env-light` | `<a-scene>` | Genera un canvas 32×128 a gradiente cielo/orizzonte/terra e lo passa a `PMREMGenerator` come environment map. `RoomEnvironment` non è nel bundle A-Frame, da qui il gradiente a mano |
| `play-clip` | `#pigeon` | Mixer di animazione con ritaglio a frame via `THREE.AnimationUtils.subclip`. Sostituisce `animation-mixer` di aframe-extras per non aggiungere una dipendenza. Imposta anche `castShadow` ed `envMapIntensity` nodo per nodo (three.js non li eredita) |
| `shadow-fit` | `<a-scene>` | Adatta bounds e distanza della shadow camera al bounding box del modello. Senza, a scala gigante l'ombra sparisce: la shadow camera ortografica ha bounds fissi. Ricalcola solo su variazioni >5% |
| `light-tuner` | `<a-scene>` | Pannello di taratura on-device — **temporaneo**, vedi sotto |
| `tap-place` | `<a-scene>` | Pressione prolungata → raycast sul piano → posiziona |

## Da fare

1. **La luce è ancora troppo scura** — è il punto aperto principale. L'utente ha il pannello
   di taratura (bottone ☀ in alto a destra) con slider per esposizione, envMap, sole,
   hemisphere e scala. Deve trovare i valori sul telefono e comunicarli; poi vanno fissati
   in `index.html` e **il pannello va rimosso** (componente `light-tuner`, markup `#tuner`,
   bottone `#tuner-toggle`, CSS relativo).
   Se muovendo lo slider "Ambiente" non cambia nulla, `env-light` non si è costruito: è un
   bug, non una questione di valori — cercarlo lì.
   Passi 2 e 3 già discussi ma non fatti: **stima della luce reale** (`XR8.XrController
   .configure({enableLighting: true})`, restituisce `{exposure, temperature}` per frame —
   verificato dentro il chunk SLAM del binario) e **riflessi live dal feed camera**
   (`realityTexture` / `cameraTexture` esistono nel binario).
2. **Deploy** — mai fatto. Finora solo server locale + tunnel temporaneo. Istruzioni nel
   `README.md`.
3. **Ottimizzazione glb** — 7,8 MB. Draco lo porterebbe a ~3 MB. Non urgente.
4. **Comportamento** — l'utente all'inizio aveva valutato un piccione che reagisce o uno
   sciame, poi ha scelto il piazzamento semplice "per ora". Possibile direzione futura.

## Verificato / non verificato

Provato su device dall'utente e **funzionante**: tracking, piazzamento, animazione ritagliata,
rotazione a due dita, pannello di taratura.

Non verificato: scala fino a 150× e `shadow-fit` a quelle dimensioni; deploy in produzione;
comportamento su iOS vs Android a confronto.

## Ambiente di sviluppo

Server locale + tunnel HTTPS (la fotocamera richiede HTTPS anche in LAN):

```bash
cd app && npx --yes serve -p 3000
npx --yes cloudflared tunnel --url http://localhost:3000
```

`serve` fa clean-URL: `/index.html` redirige a `/index`. Testando con `curl` serve `-L`,
altrimenti sembra che il file sia vuoto.

L'URL trycloudflare della sessione del 3/9/2026 è scaduto: rigenerarne uno.

## Skill utili alla prossima sessione

- `superpowers:brainstorming` prima di aggiungere feature — è la preferenza esplicita
  dell'utente, non solo una regola generica
- `superpowers:systematic-debugging` se la luce risulta essere un bug e non una taratura
