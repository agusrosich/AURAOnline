# AURA-RT Segmentation Platform

Repositorio inicial para segmentacion automatica de TC con backend remoto y cliente web.

- `backend/`: servicio FastAPI preparado para local o Google Colab, con routing a TotalSegmentator y generacion de DICOM RT-STRUCT.
- `webapp/`: cliente React + Vite con estetica WhiteSur/macOS Big Sur, pensado para navegador.
- `client/`: prototipo previo de cliente Python local. Se conserva como referencia, pero la direccion actual del producto es web app.

## Estado actual

La implementacion actual cubre un MVP tecnico en evolucion:

- Backend con `GET /health`, `GET /status` y `POST /segment`
- CORS habilitado para desarrollo del cliente web
- Routing a `TotalSegmentator` para estructuras abdominales MVP
- Generacion de `RT-STRUCT` con `rt-utils`
- Soporte de payload web:
  - `config.json`
  - `dicom/`
  - `input.nii.gz` opcional
- Web app con:
  - configuracion de URL del servidor
  - verificacion de conexion
  - carga de carpeta DICOM desde navegador
  - lectura de metadata basica del estudio
  - preview real de un slice DICOM no comprimido
  - seleccion de estructuras y presets
  - polling de estado
  - envio HTTP a `/segment`
  - descarga del ZIP de salida

MONAI UNesT y nnU-Net pelvico siguen planificados pero no implementados.

## Estructura

```text
backend/
  aura_rt_backend/
  notebooks/
  requirements-colab.txt
  .env.example
  scripts/colab_bootstrap.py
client/
  aura_rt_client/
webapp/
  src/
  package.json
  .env.example
scripts/
  run_backend.ps1
  run_backend.bat
  run_webapp.ps1
  run_webapp.bat
```

## Backend

Instalacion:

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r backend/requirements-colab.txt
```

Ejecucion directa:

```powershell
python -m uvicorn aura_rt_backend.main:app --app-dir backend --host 0.0.0.0 --port 8000
```

Ejecucion con script:

```powershell
.\scripts\run_backend.ps1
```

Si `backend/.env` no existe, el script lo genera automaticamente a partir de `backend/.env.example`.

En Windows tambien podes usar:

```bat
scripts\run_backend.bat
```

## Web App

Instalacion:

```powershell
cd webapp
npm install
```

Desarrollo:

```powershell
Copy-Item .env.example .env
npm run dev
```

o desde la raiz:

```powershell
.\scripts\run_webapp.ps1
```

En Windows tambien podes usar:

```bat
scripts\run_webapp.bat
```

## Contrato actual del payload

El cliente web empaqueta un ZIP con:

- `config.json`
- `dicom/`
- `input.nii.gz` opcional

Si `input.nii.gz` no viene, el backend convierte la serie DICOM a NIfTI antes de correr TotalSegmentator.

El backend responde un ZIP con:

- `CT/` con la serie DICOM recibida
- `masks/` con las mascaras NIfTI generadas
- `RS.<case_id>.dcm`
- `report.json`

## Colab

El script `backend/scripts/colab_bootstrap.py` deja preparado el arranque en Colab:

- instala dependencias
- prepara cache en Google Drive
- arranca `uvicorn`
- expone el puerto con ngrok via `pyngrok`

Necesita un `NGROK_AUTHTOKEN` valido en el entorno de Colab.

Notebook reproducible:

```text
backend/notebooks/AURA_RT_Colab_MVP.ipynb
```

## Advertencia

Esto **no es un dispositivo medico**. Todos los contornos deben ser revisados por el medico tratante antes de cualquier uso clinico.
