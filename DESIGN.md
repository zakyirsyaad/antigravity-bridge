---
name: Antigravity Bridge & Pool
description: High-craft, dual-protocol AI inference gateway and multi-account pool interface
colors:
  primary: "#ffffff"
  primary-glow: "rgba(255, 255, 255, 0.18)"
  secondary: "#a1a1aa"
  accent-emerald: "#10b981"
  accent-amber: "#f59e0b"
  accent-rose: "#f43f5e"
  accent-zinc: "#e4e4e7"
  surface-base: "#000000"
  surface-card: "#09090b"
  surface-card-hover: "#121215"
  surface-elevated: "#18181b"
  surface-highlight: "#27272a"
  border-subtle: "rgba(255, 255, 255, 0.08)"
  border-hover: "rgba(255, 255, 255, 0.18)"
  border-highlight: "rgba(255, 255, 255, 0.35)"
  text-primary: "#fafafa"
  text-secondary: "#a1a1aa"
  text-muted: "#71717a"
typography:
  display:
    fontFamily: "'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 800
    lineHeight: 1.2
    letterSpacing: "-0.03em"
  title:
    fontFamily: "'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  body:
    fontFamily: "'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  mono:
    fontFamily: "'JetBrains Mono', ui-monospace, 'SF Mono', monospace"
    fontSize: "0.8125rem"
    fontWeight: 600
rounded:
  sm: "6px"
  md: "10px"
  lg: "16px"
  xl: "20px"
  full: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  card:
    backgroundColor: "{colors.surface-card}"
    rounded: "{rounded.xl}"
    padding: "22px"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "#000000"
    rounded: "{rounded.md}"
    padding: "9px 18px"
  quota-bar:
    backgroundColor: "{colors.surface-elevated}"
    rounded: "{rounded.full}"
    height: "6px"
---

## 1. Overview
Antigravity Bridge is a mission-critical AI inference gateway connecting local developer agents (Claude Code, Hermes, Cursor, Python SDK) to Google Antigravity. The UI adheres strictly to the **Google Stitch Design System** and embodies the **Minimalist OLED Zinc** aesthetic: pitch black contrast, razor-sharp hairline borders, high-contrast monochrome actions, and jitter-free real-time telemetry.

## 2. Colors
- **The OLED Zinc Doctrine (`#000000`, `#09090b`, `#18181b`)**:
  - `surface-base` (`#000000`): Pure OLED pitch black canvas providing infinite depth and energy efficiency.
  - `surface-card` (`#09090b`): Dense zinc-950 foundation for content modules.
  - `surface-elevated` (`#18181b`): Tonal elevation for inputs, headers, and meter backtracks.
- **Monochrome Chrome & Contrast (`#ffffff`, `#fafafa`)**:
  - `primary` (`#ffffff`): High-contrast pure white action triggers on black backgrounds.
  - Hairline borders: `rgba(255, 255, 255, 0.08)` baseline, illuminating to `0.18` on hover.
- **Functional Telemetry Accents**:
  - `accent-emerald` (`#10b981`): Active account indicator pulse.
  - `meter-healthy` (`linear-gradient(90deg, #a1a1aa, #ffffff)`): High-contrast monochrome quota fill.
  - `accent-amber` (`#f59e0b`): Rate-limit cooldown state (HTTP 429) and warning countdown.
  - `accent-rose` (`#f43f5e`): Total exhaustion and fatal status alerts.

## 3. Typography
- **Headlines & Interface**: Plus Jakarta Sans (weights 600, 700, 800) for clean modernist readability.
- **The Tabular Numeral Rule**: Every numerical value, percentage, countdown clock, and token metric enforces `font-variant-numeric: tabular-nums` via JetBrains Mono. Numbers update in place with zero horizontal jitter.
- **Balanced Headings**: Applied `text-wrap: balance` across all section headers.

## 4. Elevation
- **Concentric Radii Principle**: Outer card radii (`var(--radius-xl): 20px`) seamlessly envelop internal meter containers (`var(--radius-md): 10px`) with consistent visual rhythm (`outer = inner + padding`).
- **Active Account Glow**: The currently serving account card is illuminated with an ambient silver rim glow (`0 0 24px rgba(255, 255, 255, 0.08)`) and elevated with deep drop-shadow (`0 12px 32px -8px rgba(0, 0, 0, 0.8)`).
- **Hairline Borders**: Zero heavy solid borders; all separations use subtle 8% to 18% alpha overlays.

## 5. Components
- **Account Identity Card**:
  - Avatar with uppercase account initial on zinc base.
  - Truncated email with copy-on-hover.
  - Real-time rolling quota progress tracks (5-Hour Rolling and Weekly Cycle Cap).
  - High-contrast "Set Active" primary button, "Clear Cooldown" action, and subtle danger removal trigger.
- **Auto-Failover Controller**:
  - Micro-pill toggle with animated status LED.
- **Universal Multi-Harness Connect**:
  - Clean tabbed container for Free Claude Code (FCC), Hermes Agent, Cursor IDE, and Python OpenAI SDK.
- **Theme Switcher**:
  - Real-time instant theme switcher supporting Minimalist OLED Zinc (Default), Gemini Cosmic, Claude Terracotta, and Cyber Emerald.

## 6. Do's and Don'ts
- **DO** maintain pure `#000000` as the canvas baseline for deep OLED black contrast.
- **DO** use tabular numerals on all countdown timers and percentage displays.
- **DO** keep button primary in crisp pure white `#ffffff` with dark `#000000` text for maximum contrast.
- **DON'T** introduce noisy colored backgrounds; keep colored accents strictly reserved for operational status (active, cooldown, warning).
- **DON'T** use opaque drop shadows that wash out dark OLED surfaces.
