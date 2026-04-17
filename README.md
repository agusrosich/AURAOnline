# AURA-RT Segmentation Platform

Plataforma de segmentación automática de TC para planificación de radioterapia. El backend corre en Google Colab (GPU remota) y se expone públicamente via ngrok. Los clientes —web o desktop— se conectan a esa URL para enviar estudios y recibir el RT-STRUCT resultante.

```
                  ┌─────────────────────────────────┐
                  │        Google Colab (GPU)        │
                  │  FastAPI + TotalSegmentator v2   │
                  │  uvicorn · ngrok tunnel          │
                  └────────────────┬────────────────┘
                                   │ HTTPS (ngrok URL)
              ┌────────────────────┴────────────────────┐
              │                                         │
   ┌──────────▼──────────┐               ┌─────────────▼──────────┐
   │      Web App         │               │    Desktop Client       │
   │   React + Vite       │               │  Python + customtkinter │
   │  Cualquier navegador │               │  Windows                │
   └─────────────────────┘               └────────────────────────┘
```

> **Advertencia clínica:** Los contornos generados son un punto de partida y deben ser revisados y aprobados por el médico tratante antes de cualquier uso clínico. Esta plataforma **no es un dispositivo médico**.

---

## Estado actual — v0.2.0

### Backend ✅
- `GET /health` — estado del servicio y estructuras soportadas
- `GET /status` — progreso del caso activo con polling
- `POST /segment` — recibe ZIP, devuelve ZIP con RT-STRUCT
- Routing a **TotalSegmentator v2** para 21 estructuras
- Conversión DICOM → NIfTI integrada (SimpleITK + fallback pydicom)
- Generación de RT-STRUCT con `rt-utils`
- Suavizado gaussiano 3 mm post-segmentación
- CORS abierto para desarrollo

### Web App ✅
- Configuración de URL del backend (ngrok o local)
- Verificación de conexión contra `/health`
- Carga de carpeta DICOM desde el navegador
- Preview de slice central
- Selección de estructuras y presets
- Polling de estado en tiempo real
- Envío HTTP y descarga del ZIP de salida
- Exportación directa del RT-STRUCT a carpeta local desde Chrome/Edge

### Desktop Client ✅ *(Windows)*
- GUI completa con `customtkinter` (5 tabs)
- Selección de carpeta DICOM con preview matplotlib
- **Anonimización de PHI** antes del envío (PatientName, DOB, 12 tags DICOM)
- Conversión local DICOM → NIfTI antes de enviar
- Polling de `/status` en hilo separado
- Descarga streaming con soporte de cancelación
- Apertura automática de carpeta de salida en Windows
- Barra lateral de exportación para incluir/excluir ROI y cambiar colores antes de guardar el RT-STRUCT

### Planificado 🔜
- MONAI UNesT (estructuras de cabeza y cuello)
- nnU-Net pélvico

---

## Estructuras soportadas (TotalSegmentator v2)

| Grupo | Estructuras |
|---|---|
| Abdomen | Hígado, Bazo, Riñón D/I, Páncreas, Vesícula, Aorta abdominal, Estómago, Intestino |
| Tórax | Pulmón D/I, Corazón, Tráquea, Esófago |
| Esqueleto | Vértebras, Pelvis ósea, Fémures, Costillas |
| Pelvis masculina | Próstata, Vejiga *(+ otros planificados)* |
| Neurológico | Cerebro *(+ otros planificados)* |

---

## Estructura del repositorio

```
backend/
  aura_rt_backend/       # FastAPI app (main, pipeline, rtstruct_builder, etc.)
  notebooks/             # AURA_RT_Colab_MVP.ipynb
  scripts/
    colab_bootstrap.py   # Setup automático en Colab
  requirements-colab.txt
  .env.example
client/                  # Cliente desktop Python/Windows
  aura_rt_client/
    app.py               # GUI customtkinter
    dicom_utils.py       # Anonimización, conversión, packaging
    http_client.py       # HTTP con streaming y cancelación
    models.py            # Estructuras MVP y presets
  requirements.txt
webapp/                  # Cliente web React + Vite
  src/
    App.jsx              # App principal
    catalog.js           # Catálogo de estructuras y presets
    dicom.js             # Lectura DICOM en el browser
    nifti.js             # Preview NIfTI en el browser
  package.json
  .env.example
scripts/
  run_backend.ps1 / .bat
  run_webapp.ps1 / .bat
```

---

## Backend

### Instalación local

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r backend/requirements-colab.txt
```

### Ejecución local

```powershell
# Con script (genera .env automáticamente si no existe)
.\scripts\run_backend.ps1

# O directamente
python -m uvicorn aura_rt_backend.main:app --app-dir backend --host 0.0.0.0 --port 8000
```

### Variables de entorno (`backend/.env`)

| Variable | Default | Descripción |
|---|---|---|
| `AURA_RT_PORT` | `8000` | Puerto de escucha |
| `AURA_RT_LOG_LEVEL` | `INFO` | Nivel de log |
| `AURA_RT_CORS_ORIGINS` | `*` | Orígenes CORS permitidos |
| `TOTALSEG_HOME_DIR` | *(vacío)* | Cache de modelos TotalSegmentator |
| `NGROK_AUTHTOKEN` | *(vacío)* | Token ngrok para Colab |

---

## Web App

### Instalación

```powershell
cd webapp
npm install
```

### Desarrollo

```powershell
# Desde webapp/
Copy-Item .env.example .env
npm run dev

# O desde la raíz
.\scripts\run_webapp.ps1
```

### Variable de entorno (`webapp/.env`)

| Variable | Default | Descripción |
|---|---|---|
| `VITE_AURA_RT_DEFAULT_SERVER_URL` | `http://127.0.0.1:8000` | URL pre-cargada al abrir la app |
| `VITE_AURA_RT_POLL_INTERVAL_MS` | `5000` | Intervalo de polling de `/status` |

---

## Desktop Client (Windows)

Cliente alternativo con anonimización local de PHI, pensado para entornos donde los datos del paciente no deben salir del equipo sin ser procesados primero.

### Instalación

```powershell
cd client
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

### Ejecución

```powershell
python -m aura_rt_client.app
```

### Diferencias respecto a la web app

| Característica | Web App | Desktop Client |
|---|---|---|
| Plataforma | Cualquier navegador | Windows |
| Anonimización PHI | ❌ (el usuario es responsable) | ✅ Automática antes del envío |
| Conversión DICOM → NIfTI | En el backend | Local antes de enviar |
| Estructuras disponibles | 21 (catálogo completo) | 5 (MVP: abdomen core) |
| Preview de slice | ✅ | ✅ |
| Cancelación mid-flight | ✅ | ✅ |

> **Nota:** El cliente desktop cubre solo el subconjunto MVP de estructuras. Para acceder a las 21 estructuras, usar la web app.

---

## Google Colab

El notebook `backend/notebooks/AURA_RT_Colab_MVP.ipynb` levanta el backend completo en Colab con GPU y lo expone públicamente via ngrok.

El script `backend/scripts/colab_bootstrap.py`:
- Instala dependencias
- Prepara caché de modelos en Google Drive
- Arranca `uvicorn`
- Expone el puerto con `pyngrok`

Requiere un `NGROK_AUTHTOKEN` válido en los secrets de Colab. Una vez corriendo, copiar la URL ngrok en la configuración del cliente (web app o desktop).

---

## Contrato del payload

### Request (`POST /segment`)

ZIP con:
```
config.json          # { structures, modality, fast_mode, anonymized_id }
dicom/               # Serie CT (puede estar en subcarpetas)
input.nii.gz         # Opcional — si no viene, el backend convierte la serie
```

### Response

ZIP con:
```
CT/                  # Serie DICOM recibida
masks/               # Máscaras NIfTI por estructura
RS.<case_id>.dcm     # DICOM RT-STRUCT listo para importar
report.json          # Resumen: estructuras, modelos, tiempo, warnings
```

### Importación en Eclipse/ARIA

`File > Import > DICOM` → seleccionar carpeta `CT/` y luego el archivo `RS.*.dcm`.
