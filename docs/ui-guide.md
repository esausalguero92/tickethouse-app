# Guía de línea gráfica — Party House

## Concepto
Exclusividad nocturna. Oscuro, elegante, con acentos neón que aportan energía sin perder la sofisticación.

## Paleta
| Token            | Uso                              | Hex      |
|------------------|----------------------------------|----------|
| `--color-bg`     | Fondo principal                  | `#050509`|
| `--color-surface`| Tarjetas y paneles               | `#12121e`|
| `--color-border` | Separadores sutiles              | `#2a2a3d`|
| `--color-text`   | Texto principal                  | `#f2f2f2`|
| `--color-text-dim`| Texto secundario                | `#9a9ab0`|
| `--neon-pink`    | Acento primario / CTA            | `#ff2df7`|
| `--neon-cyan`    | Acento secundario / foco         | `#00f0ff`|
| `--neon-purple`  | Acento terciario                 | `#a855f7`|
| `--neon-gold`    | Códigos, detalles premium        | `#ffd700`|

Gradiente neón recomendado para títulos y CTA:
```
linear-gradient(135deg, #ff2df7, #a855f7, #00f0ff);
```

## Tipografía
- **Títulos (neon style):** `Orbitron`, 700/900, letter-spacing 3–4 px, uppercase.
- **Cuerpo:** `Inter`, 400/600.
- Las tipografías se cargan desde Google Fonts (ver `<head>` de los HTML).

## Efecto neón
Para títulos:
```css
background: linear-gradient(135deg, var(--neon-pink), var(--neon-purple), var(--neon-cyan));
-webkit-background-clip: text;
color: transparent;
filter: drop-shadow(0 0 12px rgba(255,45,247,0.4));
animation: neonPulse 3s ease-in-out infinite alternate;
```

Para bordes interactivos:
```css
box-shadow: 0 0 20px rgba(255,45,247,0.35), 0 0 40px rgba(168,85,247,0.2);
```

## Hero
- Espacio en esquina superior izquierda: reservado para **logo** (ver `.logo` en CSS). El placeholder actual `◆ PARTY HOUSE` se reemplaza por la imagen definitiva (SVG recomendado).
- Centrado: título en gradiente neón animado + tagline con mayúsculas espaciadas.

## Componentes clave
- **Card** (formulario de acceso, evento, pago): fondo `--color-surface`, borde sutil, box-shadow neón, radius 14 px.
- **Botón primario:** fondo gradiente neón, texto negro, hover con glow intenso.
- **Botón secundario:** transparente con borde, hover cambia a neón-pink.
- **Pay-options:** dos tiles (PayPal / Transferencia); la activa con borde pink y glow.
- **Ticket:** card premium con borde neón-pink, QR centrado sobre fondo blanco (para legibilidad del escáner), etiqueta de código en dorado.
- **Validador:** resultado verde (`#00f0b4`) o rojo (`#ff3366`) a pantalla completa con ícono grande.

## Iconografía
Evitar emojis en UI salvo casos muy puntuales. Preferir glifos Unicode elegantes (`◆ ✦ ◯ ✔ ✖`) o íconos SVG monocromos (Lucide, Phosphor, Feather) coloreados con las variables de marca.

## Motion
- `neonPulse` (3 s alternate) en títulos principales.
- Hover de cards: `translateY(-4px)` + glow.
- Transiciones generales: `0.25s ease`.

## Do / Don't
- ✅ Mantener fondos siempre muy oscuros (negro absoluto no, casi negro sí).
- ✅ Un solo acento neón dominante por sección.
- ❌ No usar múltiples gradientes saturados juntos (satura la pantalla).
- ❌ No usar blancos puros grandes (rompe la atmósfera); preferir `--color-text` (`#f2f2f2`).

## Logo (pendiente)
Colocar `logo.svg` o `logo.png` en `landing/assets/` y reemplazar el texto del `.logo` en el navbar. Tamaño sugerido: 160 × 40 px.
