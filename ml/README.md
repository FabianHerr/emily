# ml/ — el modelo que decide si un golpe fue una caída (CJ-21)

Un Random Forest pequeño (20 árboles) que mira 4 segundos alrededor de un golpe y da un puntaje de 0 a 1. Por encima de **0.37** es caída. Corre dentro del reloj.

## Resultado

Medido con personas que el modelo nunca vio (se deja una persona fuera, se entrena con las demás y se prueba con ella):

| | Caídas detectadas | Falsas alarmas |
|---|---|---|
| Todas | 776 de 870 (89 %) | 205 de 1.371 (15 %) |
| Gente de WEDA-FALL | 336 de 350 (96 %) | 78 de 442 (18 %) |
| Gente de FallAllD | 440 de 520 (85 %) | 127 de 929 (14 %) |

- "Falsa alarma" = un movimiento normal fuerte (más de 2 g) que el modelo llama caída. Solo hace que Emily pregunte "Are you OK?"; a la familia no le llega nada.
- Lo que más lo engaña: golpear una mesa, saltar, aplaudir, dejarse caer en una silla.
- Lo que más se le escapa: caídas suaves (rodar de la cama, desmayarse deslizándose por una pared). El golpe típico de una caída no detectada es 3.5 g.
- El ajuste 89 % / 15 % lo eligió Fabian. Otros puntos del mismo modelo: 86 % / 10 %, 93 % / 20 %, 97 % / 30 % (`FALSE_ALARM_RATE` en `train.py`).

## Datos (no se suben al repo: `ml/data/`)

| Conjunto | Aparato | Qué aporta | Cómo se consigue |
|---|---|---|---|
| WEDA-FALL | Fitbit en la muñeca | 350 caídas (14 personas), 442 actividades normales (25 personas, 11 mayores) | `git clone https://github.com/joaojtmarques/WEDA-FALL.git ml/data/WEDA-FALL` |
| FallAllD | Registrador en la muñeca | 520 caídas (9 personas), 929 actividades normales (13 personas) | "Main data file" en IEEE DataPort (cuenta gratis), descomprimido en `ml/data/FallAllD/` |

Cosas que se midieron en los archivos y que la documentación no dice:

- **WEDA-FALL recorta a 4 g por eje** y **las caídas de 13 de las 14 personas están a 40 Hz**, no a 50. La columna de tiempo es la hora de entrega, no de medición: no se usa para espaciar las filas.
- **FallAllD llega a 8 g**, igual que nuestro reloj, a 238 Hz; se baja a 50 Hz. El golpe está en el centro de cada archivo. Las caídas "rec." son caídas reales en las que la persona se levanta después.
- Entrenado solo con WEDA-FALL, el modelo detectaba 87 % en gente de WEDA-FALL pero solo 59 % en gente de FallAllD. Por eso se entrena con los dos.
- Ninguno de los dos tiene caídas de personas mayores ni caídas reales: todas son actuadas por adultos jóvenes.

## Las 9 características (`features.py`)

Se calculan a 50 Hz, con cada eje limitado a ±8 g, alrededor del instante de mayor fuerza:

| # | Nombre | Qué es |
|---|---|---|
| 1–4 | `max_g`, `min_g`, `mean_g`, `variance` | De la fuerza total, desde 1 s antes hasta 1 s después del golpe |
| 5 | `turn_degrees` | Ángulo entre la dirección de la muñeca en el primer medio segundo y el último de esos 2 s |
| 6 | `after_std` | Cuánto varía la fuerza entre 1 s y 3 s después del golpe |
| 7 | `after_off_1g` | Qué tan lejos de 1 g (reposo) está la fuerza en ese tramo |
| 8 | `after_max_g` | El mayor valor en ese tramo |
| 9 | `turn_3s_degrees` | Ángulo entre la dirección antes del golpe y la de 2 s a 3 s después |

Las cuatro últimas ("qué pasa después") fueron la mayor mejora: con 10 % de falsas alarmas, las caídas detectadas pasaron de 70 % a 86 %.

## Comandos

```bash
cd ml
python3 -m venv .venv && .venv/bin/pip install numpy pandas scikit-learn scipy emlearn setuptools
.venv/bin/python train.py    # entrena, mide y guarda model.joblib (unos 2 minutos)
.venv/bin/python export.py   # escribe watch_model/ y comprueba el modelo en C contra Python
```

## Para el reloj (CJ-22): `ml/watch_model/`

- `fall_model.h` + `eml_trees.h` + `eml_common.h`: el modelo en C (hecho con emlearn). Se llama así:
  ```c
  float features[9];   // en el orden de la tabla de arriba
  float out[2];
  fall_model_predict_proba(features, 9, out, 2);
  bool isFall = out[1] > FALL_SCORE_THRESHOLD;   // fall_threshold.h
  ```
- `test_cases.csv`: 20 casos con sus 9 características y el puntaje esperado, para comprobar el cálculo del reloj.
- El modelo en C se comparó con el de Python en las 2.241 grabaciones: la mayor diferencia de puntaje fue 0.004 y dio la misma respuesta en 2.240.

Lo que el reloj tiene que hacer igual que `features.py`: limitar cada eje a ±8 g, usar el instante de mayor fuerza como centro, y esperar 3 s después del golpe antes de calcular.

## Límites

- Entrenado con datos públicos de otros aparatos. **Nunca se probó con nuestro reloj.**
- La regla "preguntar siempre si el golpe pasa de 3 g" detecta 96 % de las caídas, pero pregunta en 62 % de los movimientos normales fuertes: anula al modelo. Es mejor usar solo el puntaje.
- Licencia de WEDA-FALL: no está clara en su repositorio. FallAllD: CC BY (citar a Saleh, Abbas y Le Bouquin Jeannès, IEEE Sensors Journal 2020).
