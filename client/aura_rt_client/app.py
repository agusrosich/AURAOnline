from __future__ import annotations

import tempfile
import threading
import time
from pathlib import Path
from tkinter import colorchooser, filedialog, messagebox
from typing import Optional

import customtkinter as ctk
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg
from matplotlib.figure import Figure

from .dicom_utils import (
    SeriesInfo,
    anonymize_dicom_series,
    build_custom_rtstruct,
    convert_series_to_nifti,
    create_request_archive,
    extract_response_archive,
    generate_anonymized_id,
    inspect_dicom_series,
    load_report,
    open_in_file_manager,
)
from .http_client import HttpClientError, SegmentationHttpClient
from .models import (
    DISCLAIMER_TEXT,
    ESTIMATED_MINUTES,
    IMPORT_INSTRUCTIONS,
    MVP_STRUCTURE_OPTIONS,
    PRESETS,
    REFERENCE_DSC,
    structure_default_color,
    structure_display_name,
)


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
        self.last_report: Optional[dict[str, object]] = None
        self.current_output_ct_dir: Optional[Path] = None
        self.current_output_original_rtstruct: Optional[Path] = None
        self.export_structure_vars: dict[str, ctk.BooleanVar] = {}
        self.export_structure_colors: dict[str, tuple[int, int, int]] = {}
        self.export_structure_mask_paths: dict[str, Path] = {}
        self.export_structure_swatches: dict[str, ctk.CTkLabel] = {}
        self.export_status_var = ctk.StringVar(value="Todavia no hay estructuras cargadas para exportar.")

        self._build_layout()
        self._clear_export_editor()
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
        self.result_tab.grid_columnconfigure(1, weight=0)
        self.result_tab.grid_rowconfigure(1, weight=1)

        ctk.CTkLabel(
            self.result_tab,
            textvariable=self.result_summary_var,
            justify="left",
            wraplength=1180,
            anchor="w",
        ).grid(row=0, column=0, columnspan=2, padx=20, pady=(24, 8), sticky="ew")

        self.result_box = ctk.CTkTextbox(self.result_tab, height=320)
        self.result_box.grid(row=1, column=0, padx=(20, 12), pady=8, sticky="nsew")

        sidebar = ctk.CTkFrame(self.result_tab, width=360)
        sidebar.grid(row=1, column=1, rowspan=2, padx=(0, 20), pady=8, sticky="ns")
        sidebar.grid_columnconfigure(0, weight=1)

        ctk.CTkLabel(
            sidebar,
            text="Barra de exportacion",
            font=ctk.CTkFont(size=17, weight="bold"),
            anchor="w",
        ).grid(row=0, column=0, padx=16, pady=(16, 6), sticky="ew")

        ctk.CTkLabel(
            sidebar,
            text=(
                "Elegi que estructuras incluir en el RT-STRUCT final, "
                "quitalas de la exportacion o cambia su color antes de guardarlo."
            ),
            justify="left",
            wraplength=300,
            anchor="w",
        ).grid(row=1, column=0, padx=16, pady=(0, 10), sticky="ew")

        self.export_structure_list = ctk.CTkScrollableFrame(sidebar, width=320, height=340)
        self.export_structure_list.grid(row=2, column=0, padx=16, pady=(0, 12), sticky="nsew")
        sidebar.grid_rowconfigure(2, weight=1)

        self.export_status_label = ctk.CTkLabel(
            sidebar,
            textvariable=self.export_status_var,
            justify="left",
            wraplength=300,
            anchor="w",
        )
        self.export_status_label.grid(row=3, column=0, padx=16, pady=(0, 12), sticky="ew")

        self.export_button = ctk.CTkButton(
            sidebar,
            text="Exportar RT-STRUCT personalizado",
            command=self._export_custom_rtstruct,
            state="disabled",
        )
        self.export_button.grid(row=4, column=0, padx=16, pady=(0, 8), sticky="ew")

        action_frame = ctk.CTkFrame(sidebar, fg_color="transparent")
        action_frame.grid(row=5, column=0, padx=16, pady=(0, 16), sticky="ew")
        action_frame.grid_columnconfigure((0, 1), weight=1)

        self.select_all_button = ctk.CTkButton(
            action_frame,
            text="Seleccionar todas",
            command=self._select_all_export_structures,
            state="disabled",
        )
        self.select_all_button.grid(row=0, column=0, padx=(0, 6), pady=(0, 6), sticky="ew")

        self.clear_selection_button = ctk.CTkButton(
            action_frame,
            text="Quitar todas",
            command=self._clear_export_structures,
            state="disabled",
        )
        self.clear_selection_button.grid(row=0, column=1, padx=(6, 0), pady=(0, 6), sticky="ew")

        self.reset_colors_button = ctk.CTkButton(
            action_frame,
            text="Restaurar colores",
            command=self._reset_export_colors,
            state="disabled",
        )
        self.reset_colors_button.grid(row=1, column=0, columnspan=2, pady=(0, 0), sticky="ew")

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
            wraplength=1180,
        ).grid(row=3, column=0, columnspan=2, padx=20, pady=(0, 24), sticky="w")

    @staticmethod
    def _rgb_to_hex(color: tuple[int, int, int]) -> str:
        return "#" + "".join(f"{component:02x}" for component in color)

    @staticmethod
    def _mask_name_from_path(mask_path: Path) -> str:
        if mask_path.name.lower().endswith(".nii.gz"):
            return mask_path.name[:-7]
        return mask_path.stem

    def _set_export_status(self, message: str, *, tone: str = "neutral") -> None:
        tone_colors = {
            "neutral": ("gray10", "gray90"),
            "success": "#166534",
            "warning": "#a16207",
            "danger": "#b91c1c",
        }
        self.export_status_var.set(message)
        self.export_status_label.configure(text_color=tone_colors.get(tone, tone_colors["neutral"]))

    def _clear_export_editor(self, *, message: str = "Todavia no hay estructuras cargadas para exportar.") -> None:
        for child in self.export_structure_list.winfo_children():
            child.destroy()

        self.export_structure_vars.clear()
        self.export_structure_colors.clear()
        self.export_structure_mask_paths.clear()
        self.export_structure_swatches.clear()

        placeholder = ctk.CTkLabel(
            self.export_structure_list,
            text=message,
            justify="left",
            wraplength=260,
        )
        placeholder.grid(row=0, column=0, padx=8, pady=8, sticky="w")

        self.export_button.configure(state="disabled")
        self.select_all_button.configure(state="disabled")
        self.clear_selection_button.configure(state="disabled")
        self.reset_colors_button.configure(state="disabled")
        self._set_export_status(message, tone="neutral")

    def _refresh_export_status(self) -> None:
        total = len(self.export_structure_vars)
        selected = sum(1 for variable in self.export_structure_vars.values() if variable.get())

        if total == 0:
            self._set_export_status("Todavia no hay estructuras cargadas para exportar.", tone="neutral")
            self.export_button.configure(state="disabled")
            self.select_all_button.configure(state="disabled")
            self.clear_selection_button.configure(state="disabled")
            self.reset_colors_button.configure(state="disabled")
            return

        self.export_button.configure(state="normal" if selected > 0 else "disabled")
        self.select_all_button.configure(state="normal")
        self.clear_selection_button.configure(state="normal")
        self.reset_colors_button.configure(state="normal")

        if selected == 0:
            self._set_export_status(
                f"No hay estructuras marcadas para exportar. Desmarcaste las {total} disponibles.",
                tone="warning",
            )
            return

        self._set_export_status(
            f"Se exportaran {selected} de {total} estructuras. El RT-STRUCT original no se modifica.",
            tone="neutral",
        )

    def _add_export_structure_row(self, structure_name: str, *, row_index: int) -> None:
        row_frame = ctk.CTkFrame(self.export_structure_list)
        row_frame.grid(row=row_index, column=0, padx=6, pady=6, sticky="ew")
        row_frame.grid_columnconfigure(2, weight=1)

        enabled_var = ctk.BooleanVar(value=True)
        enabled_var.trace_add("write", lambda *_: self._refresh_export_status())
        self.export_structure_vars[structure_name] = enabled_var

        color = structure_default_color(structure_name)
        self.export_structure_colors[structure_name] = color

        checkbox = ctk.CTkCheckBox(row_frame, text="", variable=enabled_var, width=24)
        checkbox.grid(row=0, column=0, rowspan=2, padx=(10, 6), pady=10, sticky="n")

        swatch = ctk.CTkLabel(
            row_frame,
            text="",
            width=22,
            height=22,
            fg_color=self._rgb_to_hex(color),
            corner_radius=6,
        )
        swatch.grid(row=0, column=1, rowspan=2, padx=(0, 8), pady=10, sticky="n")
        self.export_structure_swatches[structure_name] = swatch

        ctk.CTkLabel(
            row_frame,
            text=structure_display_name(structure_name),
            anchor="w",
            font=ctk.CTkFont(size=14, weight="bold"),
        ).grid(row=0, column=2, padx=(0, 8), pady=(8, 0), sticky="ew")

        reference_text = REFERENCE_DSC.get(structure_name)
        metadata = structure_name if not reference_text else f"{structure_name} - {reference_text}"
        ctk.CTkLabel(
            row_frame,
            text=metadata,
            anchor="w",
            justify="left",
            text_color=("gray45", "gray65"),
        ).grid(row=1, column=2, padx=(0, 8), pady=(0, 8), sticky="ew")

        actions_frame = ctk.CTkFrame(row_frame, fg_color="transparent")
        actions_frame.grid(row=0, column=3, rowspan=2, padx=(0, 10), pady=8, sticky="e")

        ctk.CTkButton(
            actions_frame,
            text="Color",
            width=68,
            command=lambda name=structure_name: self._choose_export_structure_color(name),
        ).grid(row=0, column=0, pady=(0, 6), sticky="ew")

        ctk.CTkButton(
            actions_frame,
            text="Excluir",
            width=68,
            fg_color="#991b1b",
            hover_color="#7f1d1d",
            command=lambda name=structure_name: self._exclude_export_structure(name),
        ).grid(row=1, column=0, sticky="ew")

    def _populate_export_editor(self, output_root: Path, report: dict[str, object]) -> None:
        self.current_output_ct_dir = output_root / "CT"
        self.current_output_original_rtstruct = next(output_root.glob("RS*.dcm"), None)

        if not self.current_output_ct_dir.exists():
            self._clear_export_editor(message="No se encontro la carpeta CT del resultado. No es posible exportar un RT-STRUCT nuevo.")
            return

        masks_dir = output_root / "masks"
        mask_paths = {
            self._mask_name_from_path(mask_path): mask_path
            for mask_path in sorted(masks_dir.glob("*.nii.gz"))
        }
        generated_structures = [str(item) for item in report.get("generated_structures", [])]

        ordered_structures: list[str] = []
        for structure_name in generated_structures:
            if structure_name in mask_paths and structure_name not in ordered_structures:
                ordered_structures.append(structure_name)
        for structure_name in sorted(mask_paths):
            if structure_name not in ordered_structures:
                ordered_structures.append(structure_name)

        if not ordered_structures:
            self._clear_export_editor(message="El resultado no trae mascaras NIfTI editables para exportar.")
            return

        for child in self.export_structure_list.winfo_children():
            child.destroy()

        self.export_structure_vars.clear()
        self.export_structure_colors.clear()
        self.export_structure_mask_paths.clear()
        self.export_structure_swatches.clear()

        for row_index, structure_name in enumerate(ordered_structures):
            self.export_structure_mask_paths[structure_name] = mask_paths[structure_name]
            self._add_export_structure_row(structure_name, row_index=row_index)

        self._refresh_export_status()

    def _choose_export_structure_color(self, structure_name: str) -> None:
        current_color = self.export_structure_colors.get(
            structure_name,
            structure_default_color(structure_name),
        )
        rgb_color, _ = colorchooser.askcolor(
            color=self._rgb_to_hex(current_color),
            title=f"Elegir color para {structure_display_name(structure_name)}",
            parent=self,
        )
        if rgb_color is None:
            return

        next_color = tuple(max(0, min(255, int(round(component)))) for component in rgb_color)
        self.export_structure_colors[structure_name] = next_color
        swatch = self.export_structure_swatches.get(structure_name)
        if swatch is not None:
            swatch.configure(fg_color=self._rgb_to_hex(next_color))
        self._set_export_status(
            f"Color actualizado para {structure_display_name(structure_name)}.",
            tone="neutral",
        )

    def _exclude_export_structure(self, structure_name: str) -> None:
        variable = self.export_structure_vars.get(structure_name)
        if variable is None:
            return
        variable.set(False)

    def _select_all_export_structures(self) -> None:
        for variable in self.export_structure_vars.values():
            variable.set(True)
        self._set_export_status("Todas las estructuras quedaron marcadas para exportacion.", tone="neutral")

    def _clear_export_structures(self) -> None:
        for variable in self.export_structure_vars.values():
            variable.set(False)
        self._set_export_status("Se quitaron todas las estructuras de la exportacion.", tone="warning")

    def _reset_export_colors(self) -> None:
        for structure_name in self.export_structure_colors:
            default_color = structure_default_color(structure_name)
            self.export_structure_colors[structure_name] = default_color
            swatch = self.export_structure_swatches.get(structure_name)
            if swatch is not None:
                swatch.configure(fg_color=self._rgb_to_hex(default_color))
        self._set_export_status("Colores restaurados a los valores por defecto.", tone="neutral")

    def _selected_export_structures(self) -> dict[str, tuple[Path, tuple[int, int, int]]]:
        selected_structures: dict[str, tuple[Path, tuple[int, int, int]]] = {}

        for structure_name, variable in self.export_structure_vars.items():
            if not variable.get():
                continue
            mask_path = self.export_structure_mask_paths.get(structure_name)
            if mask_path is None:
                continue
            selected_structures[structure_name] = (
                mask_path,
                self.export_structure_colors.get(structure_name, structure_default_color(structure_name)),
            )

        return selected_structures

    def _export_custom_rtstruct(self) -> None:
        if self.current_output_ct_dir is None or self.last_report is None:
            messagebox.showwarning("Exportacion", "Todavia no hay un resultado listo para exportar.")
            return

        selected_structures = self._selected_export_structures()
        if not selected_structures:
            messagebox.showwarning(
                "Exportacion",
                "Marca al menos una estructura en la barra derecha antes de exportar.",
            )
            self._set_export_status("No hay estructuras seleccionadas para exportacion.", tone="warning")
            return

        destination = filedialog.askdirectory(
            title="Seleccionar carpeta destino para el RT-STRUCT personalizado"
        )
        if not destination:
            return

        case_id = str(self.last_report.get("case_id", "CUSTOM"))
        output_path = Path(destination) / f"RS.{case_id}.custom.dcm"

        if output_path.exists():
            should_replace = messagebox.askyesno(
                "Exportacion",
                f"El archivo {output_path.name} ya existe.\n\nDesea reemplazarlo?",
                parent=self,
            )
            if not should_replace:
                return

        try:
            build_custom_rtstruct(
                dicom_root=self.current_output_ct_dir,
                structures=selected_structures,
                output_path=output_path,
            )
        except Exception as exc:
            self._set_export_status(f"Error al exportar: {exc}", tone="danger")
            messagebox.showerror("Exportacion", str(exc), parent=self)
            return

        self._set_export_status(f"RT-STRUCT exportado en {output_path}.", tone="success")
        self._append_log(
            f"RT-STRUCT personalizado exportado en {output_path} con {len(selected_structures)} estructura(s)."
        )
        messagebox.showinfo(
            "Exportacion",
            f"RT-STRUCT personalizado guardado en:\n{output_path}",
            parent=self,
        )

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
        self.last_output_dir = None
        self.last_report = None
        self.current_output_ct_dir = None
        self.current_output_original_rtstruct = None
        self._clear_export_editor(message="Esperando un nuevo resultado para habilitar la exportacion.")
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
        original_rtstruct = next(output_root.glob("RS*.dcm"), None)

        lines = [
            f"Case ID: {report.get('case_id', 'N/D')}",
            f"Modelos usados: {', '.join(models_used) if models_used else 'N/D'}",
            f"Tiempo total: {processing_seconds} s",
            f"RT-STRUCT original: {original_rtstruct.name if original_rtstruct else 'No encontrado'}",
            "",
            "Estructuras generadas:",
        ]
        for structure in generated_structures:
            lines.append(f"- {structure}: {REFERENCE_DSC.get(str(structure), 'Referencia no disponible')}")

        self.result_box.delete("1.0", "end")
        self.result_box.insert("1.0", "\n".join(lines))
        self.last_report = report
        self.current_output_ct_dir = output_root / "CT"
        self.current_output_original_rtstruct = original_rtstruct
        self._populate_export_editor(output_root, report)
        self.result_summary_var.set(
            f"Resultado disponible en {output_root}. Podes revisar la barra derecha para elegir, quitar o recolorear estructuras antes de exportar."
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
