"""Módulo de envío DICOM via C-STORE (SCU).

Permite enviar la serie CT y el RT-STRUCT generado por AURA-RT
directamente a un DICOM SCP (Eclipse/ARIA, Monaco/Elekta, Orthanc, etc.)
sin intervención manual del usuario.

Protocolo: DICOM C-STORE SCU (Service Class User)
Compatibilidad: Eclipse ARIA Storage SCP, Monaco DICOM SCP, Orthanc, dcm4chee

Uso básico:
    destination = DicomDestination(
        ae_title="ARIA_SCP",
        host="192.168.1.100",
        port=104,
        source_ae_title="AURA_RT",
    )
    result = send_case_to_dicom(
        ct_dir=Path("/path/to/ct"),
        rtstruct_path=Path("/path/to/RS.dcm"),
        destination=destination,
    )
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from pathlib import Path

import pydicom

logger = logging.getLogger("aura_rt.backend.dicom_sender")


@dataclass
class DicomDestination:
    """Configuración del nodo DICOM destino (SCP)."""

    ae_title: str
    """AE Title del nodo destino (ej. 'ARIA_SCP', 'MONACO_SCP', 'ORTHANC')."""

    host: str
    """Hostname o IP del nodo destino."""

    port: int = 104
    """Puerto DICOM del nodo destino. Default: 104 (estándar DICOM)."""

    source_ae_title: str = "AURA_RT"
    """AE Title que usará AURA como SCU al conectarse."""

    tls: bool = False
    """Habilitar TLS para la conexión (requiere configuración adicional)."""

    timeout_seconds: int = 120
    """Timeout de conexión y transferencia en segundos."""


@dataclass
class DicomSendResult:
    """Resultado del envío DICOM C-STORE."""

    success: bool
    files_sent: int = 0
    files_failed: int = 0
    ct_sent: int = 0
    rtstruct_sent: bool = False
    errors: list[str] = field(default_factory=list)
    duration_seconds: float = 0.0

    @property
    def summary(self) -> str:
        if self.success:
            return (
                f"C-STORE completado: {self.ct_sent} slices CT + "
                f"{'1 RT-STRUCT' if self.rtstruct_sent else '0 RT-STRUCT'} "
                f"en {self.duration_seconds:.1f}s"
            )
        return (
            f"C-STORE fallido: {self.files_sent} enviados, "
            f"{self.files_failed} fallidos. "
            f"Errores: {'; '.join(self.errors[:3])}"
        )


class DicomSenderError(RuntimeError):
    """Error durante el envío DICOM."""
    pass


def _check_pynetdicom() -> None:
    """Verifica que pynetdicom está disponible."""
    try:
        import pynetdicom  # noqa: F401
    except ImportError as exc:
        raise DicomSenderError(
            "pynetdicom no está instalado. "
            "Agregá 'pynetdicom>=2.0' al requirements-colab.txt "
            "y reiniciá el backend."
        ) from exc


def verify_connection(destination: DicomDestination) -> bool:
    """Verifica conectividad con el SCP usando DICOM C-ECHO.

    Args:
        destination: Configuración del nodo destino.

    Returns:
        True si el SCP responde al C-ECHO, False si no.
    """
    _check_pynetdicom()
    from pynetdicom import AE
    from pynetdicom.sop_class import Verification  # type: ignore[attr-defined]

    ae = AE(ae_title=destination.source_ae_title)
    ae.add_requested_context(Verification)

    try:
        assoc = ae.associate(
            destination.host,
            destination.port,
            ae_title=destination.ae_title,
        )
        if assoc.is_established:
            status = assoc.send_c_echo()
            assoc.release()
            return status and status.Status == 0x0000
        return False
    except Exception as exc:
        logger.warning("C-ECHO fallido host=%s port=%s: %s", destination.host, destination.port, exc)
        return False


def send_case_to_dicom(
    ct_dir: Path,
    rtstruct_path: Path | None,
    destination: DicomDestination,
) -> DicomSendResult:
    """Envía una serie CT y su RT-STRUCT al nodo DICOM destino via C-STORE.

    El orden de envío es: primero todos los slices CT, luego el RT-STRUCT.
    Esto garantiza que el SCP (Eclipse/ARIA, Monaco) ya tiene la imagen
    de referencia cuando recibe el structure set.

    Args:
        ct_dir: Directorio con los archivos DICOM de la serie CT.
        rtstruct_path: Ruta al archivo RT-STRUCT (.dcm). Puede ser None.
        destination: Configuración del nodo DICOM destino.

    Returns:
        DicomSendResult con el resumen del envío.

    Raises:
        DicomSenderError: Si no se puede establecer la asociación DICOM.
    """
    _check_pynetdicom()

    from pynetdicom import AE, debug_logger  # noqa: F401
    from pynetdicom.sop_class import (  # type: ignore[attr-defined]
        CTImageStorage,
        RTStructureSetStorage,
        ExplicitVRLittleEndian,
        ImplicitVRLittleEndian,
        ExplicitVRBigEndian,
    )

    started_at = time.perf_counter()
    result = DicomSendResult(success=False)

    # Recolectar archivos CT ordenados
    ct_files = sorted(
        path for path in ct_dir.rglob("*")
        if path.is_file() and path.suffix.lower() in (".dcm", "") and path.name != "DICOMDIR"
    )

    if not ct_files:
        result.errors.append("No se encontraron archivos DICOM en el directorio CT.")
        return result

    logger.info(
        "Iniciando C-STORE destination=%s:%s ae=%s ct_files=%s rtstruct=%s",
        destination.host,
        destination.port,
        destination.ae_title,
        len(ct_files),
        rtstruct_path.name if rtstruct_path else "ninguno",
    )

    # Configurar AE como SCU
    ae = AE(ae_title=destination.source_ae_title)

    # Transfer syntaxes soportadas
    transfer_syntaxes = [
        ExplicitVRLittleEndian,
        ImplicitVRLittleEndian,
        ExplicitVRBigEndian,
    ]

    ae.add_requested_context(CTImageStorage, transfer_syntaxes)
    if rtstruct_path:
        ae.add_requested_context(RTStructureSetStorage, transfer_syntaxes)

    # Establecer asociación
    assoc = ae.associate(
        destination.host,
        destination.port,
        ae_title=destination.ae_title,
    )

    if not assoc.is_established:
        raise DicomSenderError(
            f"No se pudo establecer asociación DICOM con "
            f"{destination.ae_title}@{destination.host}:{destination.port}. "
            "Verificá AE Title, IP, puerto y que el SCP esté activo."
        )

    logger.info("Asociación DICOM establecida con %s", destination.ae_title)

    try:
        # ── Enviar slices CT ─────────────────────────────────────────
        for ct_path in ct_files:
            try:
                ds = pydicom.dcmread(str(ct_path))
                status = assoc.send_c_store(ds)
                if status and status.Status in (0x0000, 0xFF00):
                    result.files_sent += 1
                    result.ct_sent += 1
                else:
                    code = status.Status if status else "sin respuesta"
                    result.files_failed += 1
                    result.errors.append(f"CT {ct_path.name}: status {hex(code) if isinstance(code, int) else code}")
                    logger.warning("C-STORE CT fallido file=%s status=%s", ct_path.name, code)
            except Exception as exc:
                result.files_failed += 1
                result.errors.append(f"CT {ct_path.name}: {exc}")
                logger.warning("C-STORE CT error file=%s: %s", ct_path.name, exc)

        logger.info("CT enviado: %s/%s slices", result.ct_sent, len(ct_files))

        # ── Enviar RT-STRUCT ─────────────────────────────────────────
        if rtstruct_path and rtstruct_path.exists():
            try:
                ds = pydicom.dcmread(str(rtstruct_path))
                status = assoc.send_c_store(ds)
                if status and status.Status in (0x0000, 0xFF00):
                    result.rtstruct_sent = True
                    result.files_sent += 1
                    logger.info("RT-STRUCT enviado: %s", rtstruct_path.name)
                else:
                    code = status.Status if status else "sin respuesta"
                    result.files_failed += 1
                    result.errors.append(f"RT-STRUCT: status {hex(code) if isinstance(code, int) else code}")
                    logger.warning("C-STORE RT-STRUCT fallido status=%s", code)
            except Exception as exc:
                result.files_failed += 1
                result.errors.append(f"RT-STRUCT: {exc}")
                logger.warning("C-STORE RT-STRUCT error: %s", exc)

    finally:
        assoc.release()
        logger.info("Asociación DICOM liberada")

    result.duration_seconds = round(time.perf_counter() - started_at, 2)
    result.success = result.files_failed == 0 and result.ct_sent > 0
    logger.info("C-STORE finalizado: %s", result.summary)
    return result
