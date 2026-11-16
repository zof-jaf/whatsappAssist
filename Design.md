# DESIGN.md — Sistema de Diseño: Estudio de Tatuajes & Bot de Citas

## 1. Filosofía y Estética General
* **Concepto:** "Neo-Traditional Precision". La interfaz debe equilibrar la funcionalidad limpia de un SaaS moderno (agendamiento rápido, estados de WhatsApp claros) con la mística y el oficio artesanal de un estudio de tatuajes clásico.
* **Ambiente:** Modo oscuro predominante (Dark Mode) que evoca tinta sobre piel y el ambiente íntimo de un estudio, con acentos cálidos que remiten al papel de calco (*stencil*), agujas y arte *Old School*.
* **Regla Anti-Genérico:** Evitar degradados neón de "IA genérica" (morados/azules eléctricos) y esquinas excesivamente redondeadas tipo juguete. Usar bordes definidos, líneas finas tipo grabado (*engraving*) y alto contraste.

## 2. Paleta de Colores
* **Fondo Principal (`--bg-primary`):** `#0D0D0D` (Negro Tinta Profundo)
* **Fondo Secundario / Tarjetas (`--bg-surface`):** `#161616` (Carbón Mate)
* **Fondo Elevado / Modales (`--bg-elevated`):** `#1F1F1F` (Pizarra Oscura)
* **Texto Principal (`--text-primary`):** `#F2EFE9` (Blanco Hueso / Papel Algodón — nunca usar `#FFFFFF` puro para evitar fatiga visual)
* **Texto Secundario (`--text-secondary`):** `#9E9A93` (Gris Ceniza)
* **Acento Primario (`--accent-crimson`):** `#B8292F` (Rojo Sangre / Carmesí Clásico — para botones de acción principal como "Confirmar Cita" o alertas de depósito)
* **Acento Secundario (`--accent-gold`):** `#C5A059` (Dorado Latón / Máquina de Bobinas — para etiquetas VIP, estados confirmados o detalles decorativos)
* **Bordes y Divisores (`--border-subtle`):** `#2A2A2A` (Línea fina de 1px)

## 3. Tipografía
* **Títulos y Encabezados (Display):** Fuente con serifa clásica y carácter editorial o estilo *Blackletter/Vintage* sutil.
  * *Sugerencias Google Fonts:* `Cinzel`, `Playfair Display` o `UnifrakturMaguntia` (solo para el nombre del estudio).
  * *Uso:* Títulos de sección, nombres de los tatuadores y encabezados de tarjetas.
* **Cuerpo de Texto y UI:** Fuente *Sans-Serif* geométrica, limpia y ultra legible para los mensajes del bot, horarios y formularios.
  * *Sugerencias Google Fonts:* `Plus Jakarta Sans` o `Inter`.
* **Datos Técnicos / Horarios / Códigos:** Fuente monoespaciada para horas de cita, precios, IDs de reserva y estados de conexión de WhatsApp.
  * *Sugerencias Google Fonts:* `JetBrains Mono`.

## 4. Componentes y Acabados Modernos
* **Tarjetas (Cards):** Fondo `#161616`, borde sólido de `1px solid #2A2A2A`, radio de borde sutil (`6px` máximo). Al pasar el cursor (*hover*), el borde cambia suavemente a `#C5A059` (Dorado).
* **Botones:**
  * *Primario:* Fondo `#B8292F`, texto `#F2EFE9` en mayúsculas con espaciado de letras (`letter-spacing: 0.05em`), radio de `4px`.
  * *Secundario (Outline):* Fondo transparente, borde `1px solid #F2EFE9`, texto `#F2EFE9`.
* **Simulación / Vista Previa de WhatsApp:**
  * Burbujas del Bot con fondo `#1F1F1F` y borde izquierdo de `3px solid #C5A059`.
  * Burbujas del Cliente con fondo `#261818` (tinte rojizo muy oscuro) y texto `#F2EFE9`.
* **Inputs y Selectores de Fecha:** Estilo minimalista con fondo `#0D0D0D`, borde inferior marcado y etiquetas superiores en texto pequeño (`12px`) en mayúsculas.

## 5. Arte, Iconografía e Imágenes
* **Iconos de Interfaz:** Líneas finas (`1.5px` de grosor) estilo *Lucide Icons* o *Phosphor Icons* en color `#9E9A93` o `#C5A059`.
* **Recursos Visuales Clásicos (Decoración):**
  * Usar ilustraciones estilo **grabado en madera (woodcut), puntillismo (dotwork) o flash tradicional** (golondrinas, dagas, rosas, manos, máquinas de bobinas) en blanco y negro con opacidad baja (`5%` a `10%`) como marcas de agua en los fondos vacíos.
  * Los avatares de los tatuadores deben tener un marco circular con doble línea fina dorada (`#C5A059`).
  * Divisores de sección decorativos con un pequeño rombo o estrella náutica clásica en el centro de una línea horizontal.

## 6. Estructura de Pantalla (Layout)
* **Sidebar Izquierda (Navegación):** Fija, estrecha (`240px`), con el logotipo del estudio en la parte superior, enlaces a *Agenda*, *Flujo del Bot (WhatsApp)*, *Artistas* y *Catálogo Flash*, más un indicador en vivo de "Bot Conectado" (punto verde esmeralda `#2E7D32`).
* **Área Principal:** Diseño basado en cuadrícula limpia (*Bento Grid* sobrio) con amplio espacio negativo (`padding: 24px` o `32px`) para que el contenido respire y no se sienta saturado.
