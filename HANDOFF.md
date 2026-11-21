# HANDOFF — Reloj que detecta caídas · McGill CodeJam 16

Escrito el viernes 20 nov 2026, 8:30 PM. Sirve para dos lectores: **un compañero de equipo** y **otro chat de Claude**. Es autosuficiente: no hace falta leer nada más para empezar.

> **Ojo:** las decisiones son del domingo 15 nov. Si algo ya cambió, manda lo real y corrige este archivo.
>
> **Actualizado el viernes 20 nov en la noche:** reloj en la mano y hardware confirmado (sección 3), y la lista de tareas ahora es el kanban del equipo (sección 13).

---

## 1. Qué construimos

Un **reloj** que detecta cuando un adulto mayor se cae, le pregunta en voz alta si está bien y avisa a su familia.

- Solo sensores, **sin cámaras**: la persona no debe sentirse vigilada.
- Dos roles: **Ser querido** (lleva el reloj) y **Familia** (recibe alertas y usa la app web).

**Ejemplo:** Rosa se cae a las 2:14. El reloj pregunta "Are you OK?". Rosa dice "me duele la cadera, no puedo levantarme". A los pocos segundos Lucie recibe una alerta en el teléfono y el reloj le dice a Rosa "ya le avisé a Lucie".

## 2. Hackathon

| | |
|---|---|
| Evento | McGill CodeJam 16, edificio Trottier |
| Hacking | Viernes 20 nov 7:00 PM → domingo 22 nov 12:00 PM |
| Check-in del equipo | Domingo 10:00 AM (límite) |
| Entrega | Domingo 12:00 PM |
| Jueces | Domingo 1:00–3:30 PM, Trottier Mezzanine |
| Equipo | Fabian (Mac) y Sebastian (Windows). Confirmado: podemos competir siendo 2 |
| Regla clave | Todo el código se escribe desde cero durante el hackathon. No se reutilizan proyectos anteriores |
| Contacto | codejam@mcgilleus.ca |

## 3. Estado

**Hecho (antes del hackathon):** investigación, requisitos, arquitectura, contratos de datos. Cero código.

**Confirmado (viernes 20 nov):**
- **Reloj en la mano y enciende.** Es el T-Watch S3 (ESP32-S3 LoRa), con el firmware de fábrica todavía puesto. La pantalla táctil funciona.
- **Acelerómetro: BMA423** (lo dice la caja). Interrupt IO14, SDA IO10, SCL IO11.
- **Equipo de 2:** sí podemos competir siendo dos.
- **Hardware propio:** las reglas no lo prohíben.
- **Repo:** https://github.com/FabianHerr/emily (privado). En la Mac de Fabian la carpeta se llama `repos/codeJam`. Ya tiene la app base (Vite + React + TypeScript) conectada a Convex.
- **Convex:** proyecto `emily` en el equipo `emily-codejam` (cuenta personal de Fabian), región US East. Deployment de desarrollo de Fabian: `healthy-lark-748`.
  - Rutas HTTP del reloj (`CONVEX_SITE_URL`): `https://healthy-lark-748.convex.site`
  - Cliente web: `https://healthy-lark-748.convex.cloud`
  - Panel: https://dashboard.convex.dev/d/healthy-lark-748
  - Ojo: si Sebastian corre `npx convex dev` con su cuenta, obtiene OTRO deployment con otra URL. El reloj debe apuntar al de Fabian.
- **Guías de Convex para IA:** antes de escribir código en `convex/`, leer `convex/_generated/ai/guidelines.md` (lo pide `CLAUDE.md`).

**Hardware del reloj (caja + pantalla de información del firmware de fábrica):**

| Pieza | Chip | Pines |
|---|---|---|
| Procesador | ESP32-S3, 16 MB flash, ~8 MB PSRAM | — |
| Acelerómetro | BMA423 | INT IO14 · SDA IO10 · SCL IO11 |
| Micrófono | PDM | Data IO47 · Sclk IO44 |
| Parlante | MAX98357A (I2S) | BCK IO48 · WS IO15 · DOUT IO46 |
| Vibración | DRV2605 | SDA IO10 · SCL IO11 |
| Pantalla | ST7789V 1.54" 240×240 | — |
| Táctil | Capacitivo | INT IO16 · SDA IO39 · SCL IO40 |
| Radio | SX1262 (LoRa) | — |
| Infrarrojo | — | IO02 |
| Botón | Mantener 2 s enciende, 6 s apaga | — |

**Estado sin confirmar (pregúntale a Fabian):**
- ¿El reloj suena y graba? (todavía no se ha subido código propio)
- ¿Está instalado Arduino IDE + LilyGoLib en las dos laptops? ¿Subió `helloworld`?
- ¿Hay cuentas y claves de Convex, ElevenLabs y Pushover?
- ¿Quién hace qué? El kanban asume Fabian = backend y web, Sebastian = reloj. Fabian no lo ha confirmado.

## 4. Decisiones tomadas

| Tema | Elegido | Por qué |
|---|---|---|
| Hardware | LilyGO T-Watch S3 | Reloj con acelerómetro, micrófono, parlante, vibración, WiFi y batería |
| Detección de caídas | **Dentro del reloj**: umbrales + Random Forest | Funciona sin internet y no gasta batería ni cuota mandando datos todo el tiempo |
| Backend y app web | Convex | Todo centralizado y en tiempo real |
| Voz a texto | ElevenLabs Scribe v2 | Debe entender voces débiles o roncas |
| Texto a voz | ElevenLabs Flash v2.5 | Rápido |
| Decisión (IA) | **Claude Sonnet 5.5** (`claude-sonnet-5-5`) devuelve el JSON. Respaldo: **Google Gemini** `gemini-3.5-flash-lite`. Plan C: reglas de palabras clave | Decidido por Fabian el 21 nov (CJ-12). Sonnet: más criterio que Haiku y más rápido que Opus. Gemini: otro proveedor, modelo rápido y con nivel gratis |
| Aviso a la familia | Pushover | Suena en silencio, se repite hasta confirmar, tiene callback |
| Convex → reloj | Polling | El reloj no tiene dirección pública; sin servicios extra |
| Nombre | **Emily**: el proyecto, el repo (`FabianHerr/emily`) y la voz del reloj, que se presenta así: "Hi Rosa, it's Emily. Are you OK?" | Decidido por Fabian el 20 nov |
| Idioma de la app | **Inglés** en todo: voz, pantalla del reloj, avisos, portal, y nombres en el código (campos, tablas, archivos) | Se presenta en inglés. Decidido el 20 nov. Estos documentos y el tablero siguen en español |

**Descartado, no volver a proponer:** app de iPhone, Apple Watch, Twilio, cámaras, Raspberry Pi, mandar el acelerómetro crudo a Convex.

## 5. Arquitectura

```
RELOJ (C++)                                     FAMILIA
- Umbrales + Random Forest                      - App Pushover: alerta + "Ya voy"
- "Are you OK?" y graba 5 s                     - App web: historial, pastillas
- Preprocesa los datos del golpe                          ^        |
      |  POST /fall (audio + datos)              Pushover |        | "Ya voy" (/ack)
      v                                                   |        v
CONVEX ---------------------------------------------------------------
  AI Service ---------------------------> Notify Family
   Scribe -> junta datos -> IA (JSON)      Pushover, repite hasta confirmar
      |
      v
  Talk to Loved One                        Incidents y Devices
   texto a voz -> audio listo               estado de cada caída, latido
      |
      +--> el reloj lo recoge por polling (GET /poll)
```

| Servicio en Convex | Qué hace | Llama a |
|---|---|---|
| AI Service | Transcribe, junta los datos, decide | ElevenLabs Scribe + modelo de IA |
| Notify Family | Avisa y espera el "Ya voy" | Pushover |
| Talk to Loved One | Convierte la respuesta en audio | ElevenLabs Flash v2.5 |
| Incidents y Devices | Guarda cada caída; vigila el latido | Base de datos de Convex |

AI Service llama a Notify Family y a Talk to Loved One **en paralelo**: el aviso nunca espera al audio.

## 6. Contratos de datos

**Audio, en los dos sentidos:** PCM de 16 bits, 16 kHz, mono.

**El reloj envía con el audio (ya preprocesado):**
```json
{ "impact_max_g": 3.4, "seconds_still": 8, "position_changed": true,
  "model_confidence": 0.91, "round": 1 }
```

**La IA recibe:** lo anterior + `"transcript": "my hip hurts"` (o `null`).

**La IA devuelve:**
```json
{ "notify": true, "level": "emergency", "severity": "severe", "confidence": 0.9,
  "family_summary": "She says her hip hurts and she can't get up.",
  "reply_to_person": "Stay calm Rosa, I've told Lucie.",
  "ask_again": false }
```
`level`: `none` | `precautionary` | `emergency`. El mensaje a la familia cita lo que la persona dijo, **sin diagnósticos**.

**Rutas HTTP (HTTP actions de Convex en `https://healthy-lark-748.convex.site`). El reloj siempre inicia.**

| Ruta | Quién llama | Envía | Recibe |
|---|---|---|---|
| `POST /fall` | Reloj | Datos en la URL + WAV crudo en el cuerpo (puede ir vacío) | `{ "incidentId": "abc" }` (detalle abajo) |
| `GET /poll` | Reloj | Su identificador | `{ "audioUrl": "...", "text": "...", "askAgain": false }` o vacío |
| `GET /audio/:id` | Reloj | — | El audio de la respuesta |
| `POST /heartbeat` | Reloj | `{ "battery": 72 }` | OK |
| `POST /ack` | Pushover | Recibo confirmado | OK |

**Contrato exacto de POST /fall (implementado en CJ-6):**
- URL: `/fall?device=watch-1&round=1&impact=3.4&still=8&position=1&confidence=0.91`
  - `device` (obligatorio, debe existir en `devices`) · `round` (obligatorio, `1` o `2`) · `impact` (obligatorio, g)
  - `still` (segundos, por defecto `0`) · `position` (`0` o `1`, por defecto `0`) · `confidence` (0 a 1, por defecto `1`)
- Cuerpo: los bytes del WAV tal cual, con `Content-Type: audio/wav`. Puede ir vacío. Máximo 2 MB (5 s pesan ~160 KB).
- Respuestas (siempre JSON):
  - `200` → `{ "incidentId": "jd7..." }`
  - `400` → `{ "error": "'round' must be 1 or 2" }` (falta un dato, no es número, fuera de rango o audio > 2 MB)
  - `404` → `{ "error": "Unknown device" }` o `{ "error": "Unknown incident" }`
- Ronda 2: agregar `&incidentId=<el de la ronda 1>`. Actualiza ESE incidente (`round` pasa a 2, se suma el audio, no cambia `status`).
  Si falta `incidentId`, se crea un incidente nuevo (por si el reloj perdió la respuesta de la ronda 1).

## 7. Flujo de una caída: dos rondas, sin apresurarse

```
Ronda 1: "Are you OK?" + 5 s de audio -> IA
  - Dice que está bien  -> cerrar, sin avisar
  - Pide ayuda          -> EMERGENCIA
  - Silencio            -> si el golpe fue fuerte: aviso PREVENTIVO
                           ("Posible caída, estamos verificando") -> Ronda 2

Ronda 2 (10 s después): vuelve a preguntar + 5 s
  - Responde            -> según lo que diga
  - Silencio otra vez   -> aviso GRAVE ("se cayó y no responde")
```

- El reloj tiene **su propio cronómetro**: 10 s sin respuesta de Convex → repite la pregunta solo.
- Polling: cada 60 s en día normal; cada 3 s durante una caída.
- Sin WiFi: alarma y vibración local; el incidente se envía cuando vuelve la conexión.

## 8. Respaldos y tiempos límite

**Regla única:** si el modelo principal se demora, se lanza el respaldo **en paralelo** y se usa el primero que conteste. El respaldo debe ser más rápido y de **otro proveedor**.

**Decidido el 20 nov (Fabian):** para voz a texto y texto a voz se usa **solo ElevenLabs**, sin segundo proveedor, para no complicar. Si falla o se demora, se pasa directo al Plan C de la tabla. El respaldo de otro proveedor aplica solo al modelo de IA (JSON), y solo si se elige uno en CJ-12. Créditos de ElevenLabs al 20 nov: ~8,600; una caída completa gasta unos 150.

| Paso | Lanza respaldo a los | Se rinde a los | Plan C |
|---|---|---|---|
| Voz a texto | 2 s | 4 s | Seguir con `"transcript": null` |
| IA (JSON) | 2,5 s | 5 s | Reglas: palabras clave + `impact_max_g` |
| Texto a voz | 1,5 s | 3 s | Texto en la pantalla + vibración |

- Tiempos = valores de inicio. **Medir y ajustar.**
- **Última defensa:** incidente sin resolver en 30 s → aviso preventivo (`ctx.scheduler.runAfter`, se cancela si todo termina bien).

```ts
async function withFallback(principal, respaldo, suaveMs, duroMs) {
  const p = principal();
  const r = esperar(suaveMs).then(respaldo);
  return Promise.race([Promise.any([p, r]), limite(duroMs)]);
}
```

## 9. Notify Family (Pushover)

```
POST https://api.pushover.net/1/messages.json
  token=<app>  user=<familiar>  title="Rosa fell at 2:14 PM"
  message="She says her hip hurts and she can't get up."
  priority=2  retry=30  expire=3600  callback=https://<deployment>.convex.site/ack
```

| Aviso | priority | Comportamiento |
|---|---|---|
| Preventivo | 1 | Suena una vez |
| Emergencia / grave | 2 | Se repite cada 30 s hasta confirmar (exige `retry` ≥ 30 y `expire` ≤ 10800) |
| Actualización cada 2 min | 0 | La programa Convex |

Cada familiar instala la app Pushover y activa "Critical Alerts". Prueba gratis 30 días.

**Implementado en CJ-7:**
- `convex/notify.ts`: `sendAlert({ incidentId, level, message })` manda un aviso por familiar, en paralelo, 5 s máximo cada uno; `cancelReceipts({ receipts })` corta las repeticiones. Título: "Rosa fell at 2:14 PM" (hora de Toronto).
- `convex/incidents.ts`: `getAlertTargets`, `saveReceipts` (guarda los `receipt` y el `status`) y `acknowledge` (marca `acknowledged`, guarda `acknowledgedBy`, deja "<nombre> is on the way" en `messages` y cancela los avisos de los demás).
- `POST /ack`: lee `receipt` y `acknowledged_by` del cuerpo (form o JSON) o de la URL. **Siempre responde 200** con `{ "ok": true, "found": ... }`, aunque llegue basura.
- Hasta CJ-13, cada caída nueva de ronda 1 manda directo una emergencia: "Possible fall. Impact of 3.4 g". La ronda 2 no vuelve a avisar (CJ-16).
- Regla sin bajar de nivel: si el incidente ya es `emergency`, no se manda un preventivo; si es `acknowledged` o `closed`, no se manda nada.
- **Falta la primera prueba real** (envío, "Ya voy" y cancelación nunca se han probado contra Pushover). Ojo: cualquier `POST /fall` de ronda 1 ya hace sonar los teléfonos.

## 10. El reloj

**Configuración (igual en Mac y Windows):**
1. Arduino IDE + **Arduino-ESP32 3.3.11 o superior** (con versiones anteriores no compila).
2. **LilyGoLib** + copiar las carpetas de **LilyGoLib-ThirdParty** a `Arduino/libraries`. No usar la vieja `TTGO_TWatch_Library`.
3. Tools: Board `LilyGo T-Watch-S3` · USB CDC On Boot `Enabled` · Partition `16M Flash (3MB APP/9.9MB FATFS)` · Board Revision `Radio-SX1262` · Upload Speed `921600`.
4. Guía: https://github.com/Xinyuan-LilyGO/LilyGoLib/blob/master/docs/lilygo-t-watch-s3.md

**Ejemplos de LilyGoLib para arrancar:**

| Necesidad | Ejemplo |
|---|---|
| Acelerómetro (es BMA423, confirmado) | `sensor/BMA423_Accelerometer` |
| Grabar 5 s a 16 kHz mono | `peripheral/RecordWAV` → `instance.getAudioInput()->recordWAV(5, &buf, &size, 16000, 1)` |
| Reproducir | `peripheral/playWAV` → `instance.getAudioOutput()->playWAV(buf, size)` |
| Vibrar | `peripheral/Vibrate_Basic` → `instance.vibrator()` o `instance.drv.setWaveform(0, n); instance.drv.run();` |
| Pantalla | `helloworld`, carpeta `lvgl` |
| Reloj y alarmas | `peripheral/RTC_AlarmByUnits` |

**API de LilyGoLib verificada en el código de la librería (20 nov), todavía sin probar en el reloj:**
- Inicio: `#include <LilyGoLib.h>`, `instance.begin();` en `setup()`, `instance.loop();` en `loop()`.
- Acelerómetro: `instance.sensor->configAccelerometer(OperationMode::NORMAL, AccelFullScaleRange::FS_8G, 50.0f, AccelBandwidth::OSR2_AVG2, AccelPerfMode::CIC_AVG_MODE)`; leer con `AccelerometerData data; instance.sensor->readData(data);` → `data.mps2.x/y/z` en m/s² (dividir entre 9.80665 para g). El ejemplo viene con `FS_2G` y 100 Hz.
- Audio: el último argumento de `recordWAV` es la cantidad de canales (usar 1). El buffer se reserva con `ps_malloc()`, ya trae cabecera WAV y se libera con `free()`. `playWAV` solo acepta WAV PCM.
- `instance.codec` no aparece en la cabecera del T-Watch S3 (`LilyGoWatchS3.h`), aunque el ejemplo RecordWAV lo usa. Usar `getAudioInput()` / `getAudioOutput()`.
- Modo descarga: quitar la tapa y levantar la batería sin jalar los cables; conectar el USB; mantener la corona hasta que el puerto desaparezca; mantener BOOT y presionar la corona 1 s; soltar BOOT. Al terminar, apagar y encender con la corona.
- Reloj usado: en la primera subida, `Erase All Flash Before Sketch Upload: Enabled`; después volver a `Disabled`.

**Detección:**
1. **Portero (umbrales):** leer a 50 Hz; solo un golpe fuerte despierta al modelo. Valores de partida de la literatura: caída libre < 0,75 g, golpe > 2 g, máx. 500 ms entre ambos, quietud ~5 s. La caída libre **suma, no es obligatoria**.
2. **Juez (Random Forest):** decide si fue caída. Solo acelerómetro, 20 Hz, sobre la **magnitud** √(x²+y²+z²). Rango del sensor: ±8 g.

**Trampas conocidas:**
- WiFi solo 2.4 GHz y eduroam es difícil → **usar el hotspot de un celular**.
- No apagar la pantalla táctil en el código: no vuelve sin reiniciar.
- Si no sube el código (frecuente si traía Meshtastic): abrir la tapa y entrar en modo descarga con el botón BOOT.
- Cable **micro-USB de datos**. Corriente de carga < 130 mA.
- Batería: pocas horas con WiFi. Cargar entre demos.
- HTTPS obligatorio hacia Convex: `WiFiClientSecure` (para la demo vale `setInsecure()`).
- Audio en PSRAM con `ps_malloc()`.

## 11. Entrenar el Random Forest

| Base de datos (muñeca) | Dónde |
|---|---|
| WEDA-FALL (Fitbit, 50 Hz, incluye adultos mayores) | https://github.com/joaojtmarques/WEDA-FALL |
| Nandi et al. (41 personas, 20 Hz) | https://doi.org/10.5281/zenodo.10013090 |
| UMAFall (muñeca derecha, 20 Hz; licencia no comercial) | https://figshare.com/articles/dataset/UMA_ADL_FALL_Dataset_zip/4214283 |

```
1. Quedarse solo con el acelerómetro de la muñeca; convertir a g; llevar todo a 20 Hz
2. Ventanas de ~2 s alrededor de cada golpe
3. Features: máximo, mínimo, promedio, varianza de la magnitud; cambio de orientación
4. scikit-learn RandomForestClassifier
5. Convertir a C++ con micromlgen (o emlearn) y pegarlo en el código del reloj
6. Probar con caídas propias sobre un colchón
```
No usar SisFall ni KFall: son de cintura.

## 12. Por verificar (no lo confirmé)

- **Audio en este reloj:** falta probar en el reloj real que `getAudioInput()->recordWAV(...)` graba y que `getAudioOutput()->playWAV(...)` suena (CJ-2 y CJ-10). Leyendo el código parece que el micrófono PDM siempre graba en mono aunque se pida otra cantidad de canales; confirmarlo con el tamaño del archivo (~160 KB para 5 s).
- **Función de batería** de `instance.pmic` (para el heartbeat, CJ-24): nombre sin verificar.

**Ya resuelto con la documentación (20 nov):**
- Scribe: `model_id = scribe_v2` en `POST https://api.elevenlabs.io/v1/speech-to-text` (cabecera `xi-api-key`, multipart con `file` y `model_id`; el texto viene en `text`). `scribe_v1` está obsoleto. La API no indica silencio: tratar un texto de menos de 3 letras como silencio.
- Texto a voz: `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format=wav_16000` con `model_id = eleven_flash_v2_5`. Existe `wav_16000`, así que no haría falta agregar la cabecera; igual comprobar que el archivo empiece con `RIFF`.
- Pushover: la respuesta de `priority=2` trae `receipt`. El callback envía `receipt`, `acknowledged`, `acknowledged_at`, `acknowledged_by`, `acknowledged_by_device`. Cancelar repeticiones: `POST https://api.pushover.net/1/receipts/{receipt}/cancel.json`. Título máx. 250 caracteres, mensaje máx. 1024.

**ElevenLabs en el código (20 nov):** `convex/elevenlabs.ts` tiene dos internal actions, `transcribe({ audioId })` y `speak({ text })`, hechas con el SDK oficial `@elevenlabs/elevenlabs-js`. El archivo usa `"use node"` porque el SDK no funciona en el runtime normal de Convex. Ninguna de las dos lanza errores: si algo falla o se pasa del tiempo (4 s y 3 s), devuelven `null`. La clave está en Convex (`ELEVENLABS_API_KEY`); falta `ELEVENLABS_VOICE_ID` (CJ-12), y sin ella `speak` devuelve `null`. **Todavía no se han probado contra la API real** (no se ha gastado ningún crédito).

**Modelo de IA, datos verificados el 21 nov (para CJ-13 y CJ-19):**
- Principal: `claude-sonnet-5-5` con el SDK oficial `@anthropic-ai/sdk` (no usar `fetch` directo). Clave en Convex: `ANTHROPIC_API_KEY`. Precio: $2 / $10 por millón de tokens, unos $0.002 por caída.
- Para que responda JSON válido: salida estructurada con `output_config: { format: ... }` (o `client.messages.parse()`). NO usar `tool_choice` forzado (`any` / `tool`): en este modelo da error 400. No se puede "rellenar" la respuesta del asistente.
- Velocidad: este modelo piensa por defecto. Para la meta de 2.5 s, empezar con `output_config: { effort: "low" }`; si sigue lento, `thinking: { type: "between_tools" }` (solo con effort `high` o menor). `thinking: { type: "disabled" }` da error 400. No enviar `temperature`.
- Revisar siempre `stop_reason`: si es `"refusal"` no hay JSON; tratarlo como fallo y pasar al respaldo.
- Respaldo: Gemini `gemini-3.5-flash-lite` (estable; Google lo describe como el más rápido y económico de la serie 3.5; gratis en el nivel gratuito, $0.30 / $2.50 por millón en el de pago). Clave en Convex: `GEMINI_API_KEY`. La documentación actual de Google usa la "Interactions API": `POST https://generativelanguage.googleapis.com/v1beta/interactions`, cabeceras `x-goog-api-key` y `Api-Revision: 2026-05-20`, cuerpo con `model`, `input` y `response_format: { type: "text", mime_type: "application/json", schema }`. **Sin confirmar:** la forma exacta de la respuesta y los límites del nivel gratuito; leer la doc antes de programarlo.
- Voz de Emily: la elige Fabian en ElevenLabs y guarda su id en `ELEVENLABS_VOICE_ID`.

**AI Service en el código (CJ-13):**
- `convex/ai.ts` (runtime normal, el SDK de Anthropic funciona ahí): `processFall({ incidentId, round })`, programada por `recordFall` en cada incidente nuevo y en cada ronda 2 nueva (un reintento igual no programa nada). `decideWithClaude(...)` prueba solo a Claude desde la terminal. `convex/decide.ts`: reglas puras (`decideOnSilence`, `fallbackDecision`, `validateDecision`, esquema JSON).
- Sin audio en la ronda → la emergencia de siempre: "Possible fall. Impact of 3.4 g" (sin ElevenLabs ni Claude).
- Silencio (transcript `null`) → ronda 1 con golpe ≥ 3 g: preventivo y volver a preguntar; < 3 g: no avisa y vuelve a preguntar; ronda 2: emergencia "Rosa fell and is not responding."
- Con palabras → Claude (`claude-sonnet-5-5`, `effort: "low"`, salida estructurada, respaldo de rechazo `fallbacks: "default"`, límite 5 s).
- Claude falla (sin clave, tiempo, error, rechazo, JSON malo) → emergencia `Said: "<lo que dijo>"`. Cualquier error inesperado → la emergencia fija.
- En el incidente se guarda `transcript` y `decision` (+ `source`: silence/claude/fallback, `sttMs`, `aiMs`); `level: "none"` lo cierra (nunca una emergencia ya enviada). Lo que Emily responde queda en `messages`.
- Medido el 21 nov (12 llamadas a Claude, dentro de Convex): con `effort: "low"` mediana 2.2 s (1.6 a 3.1 s; la primera incluye compilar el esquema). `between_tools` no fue más rápido de forma clara (mediana 1.7 s). Las 4 respuestas de prueba dieron el nivel esperado; "ignore your instructions..." quedó en precautionary.
- **Falta probar** la cadena completa con audio real y avisos reales (Scribe + Claude + Pushover); no se ha llamado a `processFall`.

**Sigue por verificar:**
- Segundos reales de respuesta de Sonnet 5.5 y de Gemini con el JSON de ejemplo (medir en CJ-13; meta 2.5 s).
- Cuánto tarda el arranque en frío de las actions de Node en Convex (puede sumar al tiempo de respuesta; medir en CJ-18).
- Tiempos reales de cada paso, volumen del parlante, y si Scribe entiende una voz débil grabada con el reloj.
- Umbral de "golpe fuerte" (inicio: > 3 g).

## 12b. Para no olvidar

Cosas que ya sabemos y que es fácil pasar por alto. Cada una dice en qué tarea toca resolverla.

| # | Qué | Cuándo se resuelve |
|---|---|---|
| 0 | **Faltan dos claves de IA en Convex:** `ANTHROPIC_API_KEY` (Claude) y `GEMINI_API_KEY` (respaldo, se crea en Google AI Studio). Las guarda Fabian con `npx convex env set`. | CJ-12 |
| 1 | **Falta `ELEVENLABS_VOICE_ID` en Convex.** Sin ella `speak` devuelve `null` y el reloj solo muestra texto. Elegir una voz y guardarla con `npx convex env set ELEVENLABS_VOICE_ID <id>`. | CJ-12 |
| 2 | **`convex/elevenlabs.ts` nunca se ha probado contra la API real.** Compila y está desplegado, nada más. La primera prueba real gasta créditos: hacerla una vez, con intención, y mirar cuánto bajó el contador. | CJ-13 y CJ-14 |
| 3 | **El módulo usa el SDK en modo Node (`"use node"`).** Puede tardar más en arrancar en frío. Medirlo; si suma más de ~1 s, cambiar a llamadas `fetch` directas (los datos de la API están en la sección 12). | CJ-18 |
| 4 | **CJ-13 y CJ-14 deben usar `transcribe` y `speak` de `convex/elevenlabs.ts`.** No escribir otra vez las llamadas a ElevenLabs. Las especificaciones del tablero describen la llamada web directa; lo que vale es el módulo. | CJ-13 y CJ-14 |
| 5 | **Créditos de ElevenLabs: ~8,600 al 20 nov.** Una caída completa gasta unos 150 (peor caso). No probar la voz en bucle; guardar unos 3,000 para el domingo. Mirar en la cuenta cuándo se renuevan. | Todo el fin de semana |
| 6 | **Fabian debe generar dos audios** con la voz elegida y pasárselos a Sebastian: "Hi Rosa, it's Emily. Are you OK?" y "Rosa, it's Emily again. Are you OK?". El nombre "Rosa" queda grabado en el audio. | CJ-10 (después de CJ-12) |
| 7 | **La clave de ElevenLabs tiene permisos amplios** (se autorizó la lista completa: clonar voces, doblaje, etc.). Termina en `8e98`. Borrarla en la cuenta de ElevenLabs después del hackathon. | Domingo, después de los jueces |
| 8 | **La clave de ElevenLabs está en dos sitios:** `.env.local` (Mac de Fabian, ignorado por git) y Convex. El backend usa la de Convex. Si se cambia la clave, hay que actualizar las dos. | Solo si se cambia |
| 9 | ~~Falta `PUSHOVER_APP_TOKEN` en Convex.~~ **Hecho el 20 nov.** Falta comprobar que el token sea válido: se sabrá con el primer aviso. Cada familiar necesita además su propia clave de usuario de Pushover. | CJ-7 |
| 10 | **Sebastian no corre `npx convex dev`.** Crearía otro backend con otra URL. El reloj apunta a `https://healthy-lark-748.convex.site`. | Siempre |
| 11 | **Tablero: no guardar una tarea con el panel abierto desde hace rato.** Si otro (o Claude) la editó mientras tanto, "Guardar" pisa esos cambios con la copia vieja. Cerrar y volver a abrir antes de editar. | Siempre |
| 12 | **El paso "cargar la clave por Vite" del asistente de ElevenLabs se omitió a propósito.** La clave no debe llegar al navegador; vive en Convex. Si `onboard check` lo vuelve a pedir, ignorarlo. | — |

## 12c. Mediciones

| Qué | Medido | Cuándo | Meta |
|---|---|---|---|
| `POST /fall` responde (Convex guarda el incidente) | 0.29 s | 21 nov, con `curl` desde la Mac | — |
| Pushover acepta los dos avisos y se guardan los recibos | menos de 1.6 s desde el envío | 21 nov | — |
| Suena el teléfono de Fabian (iPhone, Critical Alerts) | menos de 2 s desde el envío | 21 nov, medido a ojo | menos de 10 s |
| Voz a texto (ElevenLabs `scribe_v2`, clip de 3.2 s, 16 kHz) | mediana 0.24 s (0.23–0.40 s, 5 veces; la primera es la más lenta). Transcribió perfecto | 21 nov, dentro de Convex, voz "Grandma" de macOS | límite 4 s |
| Decisión de Claude (`claude-sonnet-5-5`, effort low) | mediana 2.17 s (1.57–3.08 s, 12 veces) | 21 nov | 2.5 s, límite 5 s |
| Voz de Emily (ElevenLabs `eleven_flash_v2_5`, frase de 3.8 s) | 0.45–0.49 s en caliente; **3.2 s la primera vez (en frío)** | 21 nov, dentro de Convex | límite 3 s |
| Cadena del servidor: voz a texto → Claude → voz de Emily | **2.3–2.5 s en caliente, 6.9 s en frío** (3 veces, sin alertas) | 21 nov | — |

Ojo: la primera llamada en frío casi pasa el límite de 3 s de la voz. Antes del demo, hacer una caída de prueba para "calentar". Falta medir lo que pasa en el reloj: subir el WAV, esperar el `/poll` (CJ-14) y reproducir. La voz todavía no está conectada a `processFall`: eso es CJ-14.

Falta medir: desde la caída real del reloj (CJ-9), y los pasos de voz e IA (CJ-18).

## 13. Tareas del sprint (kanban)

**Tablero en vivo (fuente de verdad):** https://claude.ai/artifact/MNWCwnhqiiRGp8ERtAke7i

- Columnas: Por hacer → En curso → En review → Hecho.
- El estado real está en el tablero. Esta lista es una copia del viernes 20 nov en la noche: solo CJ-1 estaba en Hecho, el resto en Por hacer.
- Cada tarea tiene en el tablero su especificación completa (archivos, pasos, llamadas exactas a las APIs) y su "Listo cuando…". Ejemplo, CJ-5: dejar caer el reloj sobre una almohada lo hace vibrar; caminar y aplaudir no.
- F = Fabian (backend y web), S = Sebastian (reloj), F+S = los dos. Reparto propuesto, sin confirmar. Las dos tareas de ML (CJ-21 y CJ-22) se hacen juntos, para aprender: lo pidió Fabian.
- Prioridad: **Imp.** = imprescindible, Importante, Si sobra.

Primero el camino completo con lo mínimo; después se mejora cada pieza.

**Vie noche (7 PM–2 AM) — meta: primer demo de punta a punta**

| # | Tarea | Quién | Espera a | Prioridad |
|---|---|---|---|---|
| CJ-1 | Confirmar qué acelerómetro trae el reloj — **Hecho: BMA423** | S | — | Imp. |
| CJ-2 | Reloj: conexión segura, Arduino IDE + LilyGoLib y subir `helloworld` | S | — | Imp. |
| CJ-3 | Repo en GitHub + proyecto Convex + claves | F | — | Imp. |
| CJ-4 | Reloj: leer el acelerómetro a 50 Hz | S | CJ-2 | Imp. |
| CJ-5 | Reloj: detectar caída con umbrales y vibrar | S | CJ-4 | Imp. |
| CJ-6 | Convex: tablas + `POST /fall` que guarda el incidente | F | CJ-3 | Imp. |
| CJ-7 | Convex: Notify Family con Pushover + `/ack` | F | CJ-6 | Imp. |
| CJ-8 | Reloj: WiFi por hotspot + `POST /fall` con datos | S | CJ-5, CJ-6 | Imp. |
| CJ-9 | **Hito 1:** primer demo de punta a punta (3 veces seguidas) | F+S | CJ-7, CJ-8 | Imp. |

**Sáb mañana — meta: audio e IA**

| # | Tarea | Quién | Espera a | Prioridad |
|---|---|---|---|---|
| CJ-10 | Reloj: "Are you OK?" + grabar 5 s | S | CJ-5 | Imp. |
| CJ-11 | Reloj: enviar el audio en `POST /fall` | S | CJ-10, CJ-8 | Imp. |
| CJ-12 | Decidir el modelo de IA y los respaldos | F | — | Imp. |
| CJ-13 | Convex: AI Service (Scribe → IA → JSON) | F | CJ-12, CJ-7 | Imp. |
| CJ-28 | Convex: registro de eventos (`events`) para el portal | F | CJ-6 | Importante |

**Sáb tarde — meta: el reloj responde, dos rondas**

| # | Tarea | Quién | Espera a | Prioridad |
|---|---|---|---|---|
| CJ-14 | Convex: Talk to Loved One + `/poll` + `/audio` | F | CJ-13 | Imp. |
| CJ-15 | Reloj: polling y reproducir la respuesta | S | CJ-11, CJ-14 | Imp. |
| CJ-16 | Convex: lógica de dos rondas | F | CJ-13 | Imp. |
| CJ-17 | Reloj: ronda 2 + cronómetro propio | S | CJ-15 | Imp. |
| CJ-18 | **Hito 2:** demo completo con voz, tiempos medidos | F+S | CJ-16, CJ-17 | Imp. |
| CJ-30 | Reloj: pantallas para la persona (inglés, letra grande, botones "I'm OK" y "I need help") | S | CJ-15 | Importante |

**Sáb noche — mejoras**

| # | Tarea | Quién | Espera a | Prioridad |
|---|---|---|---|---|
| CJ-19 | Convex: respaldos, tiempos límite y última defensa | F | CJ-16 | Importante |
| CJ-20 | App web de la familia: historial y "Ya voy" | F | CJ-16 | Importante |
| CJ-21 | ML juntos: entrenar el Random Forest y exportarlo a C++ | F+S | — | Importante |
| CJ-22 | ML juntos: usar el Random Forest como juez en el reloj | F+S | CJ-21, CJ-17 | Importante |
| CJ-23 | Convex: actualización cada 2 min | F | CJ-16 | Si sobra |
| CJ-24 | Heartbeat + aviso "protección apagada" | F+S | CJ-18 | Si sobra |
| CJ-25 | Recordatorio de pastillas + modo sin WiFi | F+S | CJ-20 | Si sobra |
| CJ-29 | Portal de la familia: estado, actividad en vivo y alerta urgente | F | CJ-20, CJ-28 | Importante |
| CJ-32 | Resumen diario del agente en el portal | F | CJ-28, CJ-29, CJ-12 | Si sobra |

**Dom mañana — entregar**

| # | Tarea | Quién | Espera a | Prioridad |
|---|---|---|---|---|
| CJ-26 | Congelar el código (8 AM), ensayar la demo, grabar video de respaldo | F+S | CJ-18 | Imp. |
| CJ-27 | Check-in 10:00 AM y entrega 12:00 PM | F+S | CJ-26 | Imp. |

No existe CJ-31: se propuso "actividad inusual" y Fabian la descartó.

**Dos interfaces:** el ser querido usa la pantalla del reloj (CJ-30); la familia usa el portal web (CJ-20, CJ-29, CJ-32), que lee la tabla `events` (CJ-28).

Si el tiempo se acaba: con CJ-1 a CJ-18 ya hay demo. En el pitch: "la versión 2 agrega ML en el reloj y MQTT".

**Fuera del MVP:** respuestas pregrabadas, WebSocket/MQTT, LoRa, optimización de batería, aviso al familiar más cercano, privacidad granular.

## 14. Para empezar (Sebastian)

```
git clone https://github.com/FabianHerr/emily.git
cd emily
npm install
```

- **No correr `npx convex dev`.** Solo Fabian lo corre. Con otra cuenta se crea otro backend con otra URL.
- Copiar `watch/secrets.example.h` a `watch/secrets.h` y llenar: el hotspot del celular y `CONVEX_SITE_URL = https://healthy-lark-748.convex.site`.
- Abrir Claude Code dentro de la carpeta `emily`: lee `CLAUDE.md` solo, y ese archivo lo manda a este.
- Primera tarea: CJ-2 en el tablero (incluye cómo conectar el reloj usado de forma segura).

## 15. Para el otro chat de Claude

- Responde en **español**, **simple, corto y con ejemplos**. Fabian rechaza respuestas largas.
- **Sin sobreingeniería.** Si hay dos caminos, el más simple que funcione para la demo.
- No reabras lo descartado (sección 4) salvo que Fabian lo pida.
- La IA redacta y clasifica; **avisar a la familia nunca puede depender de que una API responda** (secciones 7 y 8).
- No des por hecho lo "sin confirmar" de la sección 3 ni lo de la sección 12: pregunta o verifica.
- Al terminar o empezar una tarea, actualiza su estado en el tablero de la sección 13 (Sebastian necesita permiso de edición sobre el artefacto).
- Este archivo vive en la raíz del repo `FabianHerr/emily` y `CLAUDE.md` manda a leerlo primero. Es la única copia que se mantiene; las copias viejas (Descargas, proyecto "Hackaton CodeJam") están desactualizadas.
- Versión con diagramas: https://claude.ai/artifact/QF5kJyZunwwBZyudSD2Jz4
