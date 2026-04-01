from __future__ import annotations

import tempfile
import threading
import time
from pathlib import Path
from tkinter import filedialog, messagebox
from typing import Optional

import customtkinter as ctk
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg
from matplotlib.figure import Figure

from .dicom_utils import (
    SeriesInfo,
    anonymize_dicom_series,
    convert_series_to_nifti,
    create_request_archive,
    extract_response_archive,
    generate_anonymized_id,
    inspect_dicom_series,
    load_report,
    open_in_file_manager,
)
from .http_client import HttpClientError, SegmentationHttpClient
from .models import DISCLAIMER_TEXT, ESTIMATED_MINUTES, IMPORT_INSTRUCTIONS, MVP_STRUCTURE_OPTIONS, PRESETS, REFERENCE_DSC


ctk.set_appearance_mode("System")
ctk.set_default_color_theme("blue")


class AuraRtClientApp(ctk.CTk):
    def __init__(self) -> None:
        super().__init__()
        self.title("AURA-RT Segmentation Client")
        self.geometry("1280x860")

        self.http_client = SegmentationHttpClient()
        self.server_url_var = ctk.StringVar(value="http://127.0.0.1:8000")
        self.connection_status_var = ctk.StringVar(value="Desconectado")
        self.loaded_series_dir: Optional[Path] = None
        self.loaded_series_info: Optional[SeriesInfo] = None
        self.selected_structure_vars = {
            option.key: ctk.BooleanVar(value=False) for option in MVP_STRUCTURE_OPTIONS
        }
        self.progress_stage_var = ctk.StringVar(value="Esperando")
        self.estimate_var = ctk.StringVar(value="Tiempo estimado: N/A")
        self.result_summary_var = ctk.StringVar(value="Sin resultados todavia.")
        self.cancel_event = threading.Event()
        self.processing_thread: Optional[threading.Thread] = None
        self.polling_thread: Optional[threading.Thread] = None
        self.status_polling_active = False
        self.last_output_dir: Optional[Path] = None

        self._build_layout()
        self._update_estimate()

    def _build_layout(self) -> None:
        self.grid_columnconfigure(0, weight=1)
        self.grid_rowconfigure(1, weight=1)

        banner = ctk.CTkLabel(
            self,
            text=DISCLAIMER_TEXT,
            justify="left",
            wraplength=1100,
            font=ctk.CTkFont(size=14, weight="bold"),
        )
        banner.grid(row=0, column=0, padx=20, pady=(16, 8), sticky="ew")

        self.tabview = ctk.CTkTabview(self)
        self.tabview.grid(row=1, column=0, padx=20, pady=(0, 20), sticky="nsew")

        self.config_tab = self.tabview.add("Configuracion")
        self.load_tab = self.tabview.add("Carga TC")
        self.structures_tab = self.tabview.add("Estructuras")
        self.processing_tab = self.tabview.add("Procesamiento")
        self.result_tab = self.tabview.add("Resultado")

        self._build_config_tab()
        self._build_load_tab()
        self._build_structures_tab()
        self._build_processing_tab()
        self._build_result_tab()

    def _build_config_tab(self) -> None:
        self.config_tab.grid_columnconfigure(0, weight=1)

        self.server_entry = ctk.CTkEntry(self.config_tab, textvariable=self.server_url_var, height=38)
        self.server_entry.grid(row=0, column=0, padx=20, pady=(24, 12), sticky="ew")

        verify_button = ctk.CTkButton(
            self.config_tab,
            text="Verificar conexion",
            command=self._start_health_check,
        )
        verify_button.grid(row=0, column=1, padx=(0, 20), pady=(24, 12), sticky="e")

        status_label = ctk.CTkLabel(
            self.config_tab,
            textvariable=self.connection_status_var,
            anchor="w",
            font=ctk.CTkFont(size=16, weight="bold"),
        )
        status_label.grid(row=1, column=0, padx=20, pady=(0, 12), sticky="w")

        help_text = (
            "Ingrese la URL publica del backend Colab/ngrok o un endpoint local. "
            "La GUI consultara /health para verificar conectividad antes del envio."
        )
        ctk.CTkLabel(
            self.config_tab,
            text=help_text,
            justify="left",
            wraplength=980,
        ).grid(row=2, column=0, padx=20, pady=(0, 24), sticky="w")

    def _build_load_tab(self) -> None:
        self.load_tab.grid_columnconfigure(0, weight=0)
        self.load_tab.grid_columnconfigure(1, weight=1)
        self.load_tab.grid_rowconfigure(1, weight=1)

        select_button = ctk.CTkButton(
            self.load_tab,
            text="Seleccionar carpeta DICOM",
            command=self._select_dicom_folder,
        )
        select_button.grid(row=0, column=0, padx=20, pady=20, sticky="w")

        self.metadata_box = ctk.CTkTextbox(self.load_tab, width=360)
        self.metadata_box.grid(row=1, column=0, padx=20, pady=(0, 20), sticky="nsw")
        self.metadata_box.insert("1.0", "Sin estudio cargado.")
        self.metadata_box.configure(state="disabled")

        figure = Figure(figsize=(6, 6), dpi=100)
        self.preview_axis = figure.add_subplot(111)
        self.preview_axis.set_title("Preview slice central")
        self.preview_axis.axis("off")
        self.preview_canvas = FigureCanvasTkAgg(figure, master=self.load_tab)
        self.preview_canvas.get_tk_widget().grid(row=1, column=1, padx=(0, 20), pady=(0, 20), sticky="nsew")
        self.preview_canvas.draw()

    def _build_structures_tab(self) -> None:
        self.structures_tab.grid_columnconfigure(0, weight=1)

        ctk.CTkLabel(
            self.structures_tab,
            text="Fase 1 MVP: seleccionar estructuras abdominales",
            font=ctk.CTkFont(size=18, weight="bold"),
        ).grid(row=0, column=0, padx=20, pady=(24, 8), sticky="w")

        checkbox_frame = ctk.CTkFrame(self.structures_tab)
        checkbox_frame.grid(row=1, column=0, padx=20, pady=8, sticky="ew")
        checkbox_frame.grid_columnconfigure((0, 1, 2), weight=1)

        for index, option in enumerate(MVP_STRUCTURE_OPTIONS):
            checkbox = ctk.CTkCheckBox(
                checkbox_frame,
                text=option.label,
                variable=self.selected_structure_vars[option.key],
                command=self._update_estimate,
            )
            checkbox.grid(row=index // 3, column=index % 3, padx=16, pady=12, sticky="w")

        preset_frame = ctk.CTkFrame(self.structures_tab)
        preset_frame.grid(row=2, column=0, padx=20, pady=8, sticky="ew")

        for column, preset_name in enumerate(PRESETS):
            button = ctk.CTkButton(
                preset_frame,
                text=preset_name,
                command=lambda name=preset_name: self._apply_preset(name),
            )
            button.grid(row=0, column=column, padx=12, pady=12, sticky="w")

        ctk.CTkLabel(
            self.structures_tab,
            textvariable=self.estimate_var,
            font=ctk.CTkFont(size=15, weight="bold"),
        ).grid(row=3, column=0, padx=20, pady=(8, 24), sticky="w")

    def _build_processing_tab(self) -> None:
        self.processing_tab.grid_columnconfigure(0, weight=1)
        self.processing_tab.grid_rowconfigure(2, weight=1)

        ctk.CTkLabel(
            self.processing_tab,
            textvariable=self.progress_stage_var,
            font=ctk.CTkFont(size=18, weight="bold"),
        ).grid(row=0, column=0, padx=20, pady=(24, 8), sticky="w")

        self.progressbar = ctk.CTkProgressBar(self.processing_tab)
        self.progressbar.grid(row=1, column=0, padx=20, pady=(0, 12), sticky="ew")
        self.progressbar.set(0)

        self.log_box = ctk.CTkTextbox(self.processing_tab)
        self.log_box.grid(row=2, column=0, padx=20, pady=(0, 12), sticky="nsew")

        button_frame = ctk.CTkFrame(self.processing_tab)
        button_frame.grid(row=3, column=0, padx=20, pady=(0, 20), sticky="ew")

        self.start_button = ctk.CTkButton(
            button_frame,
            text="Iniciar procesamiento",
            command=self._start_processing,
        )
        self.start_button.grid(row=0, column=0, padx=12, pady=12, sticky="w")

        cancel_button = ctk.CTkButton(
            button_frame,
            text="Cancelar",
            fg_color="#B91C1C",
            hover_color="#991B1B",
            command=self._cancel_processing,
        )
        cancel_button.grid(row=0, column=1, padx=12, pady=12, sticky="w")

    def _build_result_tab(self) -> None:
        self.result_tab.grid_columnconfigure(0, weight=1)

        ctk.CTkLabel(
            self.result_tab,
            textvariable=self.result_summary_var,
            justify="left",
            wraplength=960,
            anchor="w",
        ).grid(row=0, column=0, padx=20, pady=(24, 8), sticky="ew")

        self.result_box = ctk.CTkTextbox(self.result_tab, height=320)
        self.result_box.grid(row=1, column=0, padx=20, pady=8, sticky="ew")

        open_button = ctk.CTkButton(
            self.result_tab,
            text="Abrir carpeta de salida",
            command=self._open_output_folder,
        )
        open_button.grid(row=2, column=0, padx=20, pady=(8, 8), sticky="w")

        ctk.CTkLabel(
            self.result_tab,
            text=IMPORT_INSTRUCTIONS,
            justify="left",
            wraplength=960,
        ).grid(row=3, column=0, padx=20, pady=(0, 24), sticky="w")

    def _set_metadata_text(self, text: str) -> None:
        self.metadata_box.configure(state="normal")
        self.metadata_box.delete("1.0", "end")
        self.metadata_box.insert("1.0", text)
        self.metadata_box.configure(state="disabled")

    def _append_log(self, message: str) -> None:
        timestamp = time.strftime("%H:%M:%S")
        self.log_box.insert("end", f"[{timestamp}] {message}\n")
        self.log_box.see("end")

    def _set_stage(self, stage: str, progress: float) -> None:
        self.progress_stage_var.set(stage)
        self.progressbar.set(progress)

    def _selected_structures(self) -> list[str]:
        return [key for key, variable in self.selected_structure_vars.items() if variable.get()]

    def _update_estimate(self) -> None:
        structures = self._selected_structures()
        if not structures:
            self.estimate_var.set("Tiempo estimado: N/A")
            return
        estimated_minutes = sum(ESTIMATED_MINUTES.get(key, 2) for key in structures)
        self.estimate_var.set(f"Tiempo estimado: {estimated_minutes} min aprox.")

    def _apply_preset(self, preset_name: str) -> None:
        selected_keys = set(PRESETS[preset_name])
        for key, variable in self.selected_structure_vars.items():
            variable.set(key in selected_keys)
        self._update_estimate()

    def _start_health_check(self) -> None:
        threading.Thread(target=self._run_health_check, daemon=True).start()

    def _run_health_check(self) -> None:
        try:
            response = self.http_client.health_check(self.server_url_var.get().strip())
            status_text = f"Conectado: {response.get('status', 'ok')}"
        except Exception as exc:
            status_text = f"Desconectado: {exc}"
        self.after(0, lambda: self.connection_status_var.set(status_text))

    def _select_dicom_folder(self) -> None:
        folder = filedialog.askdirectory(title="Seleccionar carpeta con serie DICOM CT")
        if not folder:
            return
        threading.Thread(target=self._load_series_worker, args=(Path(folder),), daemon=True).start()

    def _load_series_worker(self, folder: Path) -> None:
        try:
            series_info = inspect_dicom_series(folder)
        except Exception as exc:
            self.after(0, lambda: messagebox.showerror("Carga DICOM", str(exc)))
            return

        def update_ui() -> None:
            self.loaded_series_dir = folder
            self.loaded_series_info = series_info
            metadata_text = (
                "Serie CT cargada\n\n"
                f"Carpeta: {folder}\n"
                f"Modalidad: {series_info.modality}\n"
                f"StudyDate: {series_info.study_date or 'N/D'}\n"
                f"Slices: {series_info.slices}\n"
                f"Voxel size: {series_info.voxel_spacing}\n"
                "Paciente mostrado: ANON\n"
            )
            self._set_metadata_text(metadata_text)
            self.preview_axis.clear()
            self.preview_axis.imshow(series_info.preview_slice, cmap="gray")
            self.preview_axis.set_title("Slice central")
            self.preview_axis.axis("off")
            self.preview_canvas.draw()
            self._append_log(f"Serie CT cargada desde {folder}")

        self.after(0, update_ui)

    def _start_processing(self) -> None:
        if self.processing_thread and self.processing_thread.is_alive():
            messagebox.showwarning("Procesamiento", "Ya hay un caso en ejecucion.")
            return
        if not self.server_url_var.get().strip():
            messagebox.showerror("Procesamiento", "Defina la URL del backend antes de continuar.")
            return
        if self.loaded_series_dir is None:
            messagebox.showerror("Procesamiento", "Seleccione una serie DICOM CT antes de continuar.")
            return

        structures = self._selected_structures()
        if not structures:
            messagebox.showerror("Procesamiento", "Seleccione al menos una estructura.")
            return

        self.cancel_event.clear()
        self.start_button.configure(state="disabled")
        self.result_box.delete("1.0", "end")
        self.result_summary_var.set("Procesando caso...")
        self._set_stage("Anonimizando", 0.05)
        self._append_log("Inicio de procesamiento local.")

        self.processing_thread = threading.Thread(
            target=self._processing_worker,
            args=(structures,),
            daemon=True,
        )
        self.processing_thread.start()
        self._start_status_polling()

    def _processing_worker(self, structures: list[str]) -> None:
        try:
            working_dir = Path(tempfile.mkdtemp(prefix="aura_rt_client_"))
            anonymized_id = generate_anonymized_id(str(self.loaded_series_dir))
            anonymized_dicom_dir = working_dir / "dicom_anon"
            input_nifti_path = working_dir / "input.nii.gz"
            archive_path = working_dir / "request.zip"
            output_root = Path(__file__).resolve().parents[1] / "output" / anonymized_id
            response_zip_path = output_root / "response.zip"

            if self.cancel_event.is_set():
                raise HttpClientError("Procesamiento cancelado por el usuario.")

            self.after(0, lambda: self._append_log("Anonimizando serie DICOM..."))
            anonymize_dicom_series(self.loaded_series_dir, anonymized_dicom_dir, anonymized_id)

            if self.cancel_event.is_set():
                raise HttpClientError("Procesamiento cancelado por el usuario.")

            self.after(0, lambda: self._set_stage("Convirtiendo", 0.2))
            self.after(0, lambda: self._append_log("Convirtiendo DICOM a NIfTI..."))
            convert_series_to_nifti(anonymized_dicom_dir, input_nifti_path)

            config = {
                "structures": structures,
                "modality": "CT",
                "fast_mode": True,
                "anonymized_id": anonymized_id,
            }
            create_request_archive(anonymized_dicom_dir, input_nifti_path, config, archive_path)

            self.after(0, lambda: self._set_stage("Enviando", 0.4))
            self.after(0, lambda: self._append_log("Enviando estudio al backend remoto..."))
            self.http_client.submit_segmentation(
                self.server_url_var.get().strip(),
                archive_path,
                response_zip_path,
                timeout_seconds=600,
                cancel_check=self.cancel_event.is_set,
            )

            if self.cancel_event.is_set():
                raise HttpClientError("Procesamiento cancelado por el usuario.")

            self.after(0, lambda: self._set_stage("Descargando", 0.85))
            self.after(0, lambda: self._append_log("Extrayendo resultado ZIP..."))
            extract_response_archive(response_zip_path, output_root)
            report = load_report(output_root)
            self.last_output_dir = output_root
            self.after(0, lambda report=report, output_root=output_root: self._show_report(report, output_root))
            self.after(0, lambda: self._set_stage("Completado", 1.0))
        except Exception as exc:
            self.after(0, lambda: messagebox.showerror("Procesamiento", str(exc)))
            self.after(0, lambda: self._append_log(f"Error: {exc}"))
            self.after(0, lambda: self._set_stage("Fallido", 0))
        finally:
            self.status_polling_active = False
            self.after(0, lambda: self.start_button.configure(state="normal"))

    def _show_report(self, report: dict[str, object], output_root: Path) -> None:
        generated_structures = report.get("generated_structures", [])
        models_used = report.get("models_used", [])
        processing_seconds = report.get("processing_seconds", 0)

        lines = [
            f"Case ID: {report.get('case_id', 'N/D')}",
            f"Modelos usados: {', '.join(models_used) if models_used else 'N/D'}",
            f"Tiempo total: {processing_seconds} s",
            "",
            "Estructuras generadas:",
        ]
        for structure in generated_structures:
            lines.append(f"- {structure}: {REFERENCE_DSC.get(str(structure), 'Referencia no disponible')}")

        self.result_box.delete("1.0", "end")
        self.result_box.insert("1.0", "\n".join(lines))
        self.result_summary_var.set(
            f"Resultado disponible en {output_root}. RT-STRUCT y CT listos para importacion."
        )
        self._append_log("Caso completado y resultados descomprimidos.")
        self.tabview.set("Resultado")

    def _start_status_polling(self) -> None:
        if self.polling_thread and self.polling_thread.is_alive():
            return
        self.status_polling_active = True
        self.polling_thread = threading.Thread(target=self._status_polling_worker, daemon=True)
        self.polling_thread.start()

    def _status_polling_worker(self) -> None:
        while self.status_polling_active:
            if self.cancel_event.is_set():
                return
            try:
                status = self.http_client.get_status(self.server_url_var.get().strip())
                message = str(status.get("message", "Sin mensaje"))
                active_model = status.get("active_model")
                if active_model:
                    message = f"{message} [{active_model}]"
                self.after(0, lambda msg=message: self._append_log(f"Backend: {msg}"))
            except Exception:
                pass
            for _ in range(5):
                if not self.status_polling_active or self.cancel_event.is_set():
                    return
                time.sleep(1)

    def _cancel_processing(self) -> None:
        self.cancel_event.set()
        self.http_client.close()
        self._append_log("Cancelacion solicitada. Si el POST ya fue enviado, el backend puede seguir trabajando.")

    def _open_output_folder(self) -> None:
        if self.last_output_dir is None:
            messagebox.showwarning("Resultado", "Todavia no hay carpeta de salida para abrir.")
            return
        try:
            open_in_file_manager(self.last_output_dir)
        except Exception as exc:
            messagebox.showerror("Resultado", str(exc))


def main() -> None:
    app = AuraRtClientApp()
    app.mainloop()


if __name__ == "__main__":
    main()
