@AGENTS.md

# Periplus – Repo-Guide

Periplus ist der Ankerplatz-Datendienst: ein reiner Datensammel- und Bereitstellungsdienst mit interner
Admin-Oberfläche. Keine Endnutzer, keine Mandanten.

## Was gilt

- **Fachlich maßgebend:** `.idea/datendienst-spec.md`. Bei Widerspruch gilt sie, außer bei den Abweichungen in
  Abschnitt 4 des Gesamtdesigns.
- **Wie gebaut wird:** `docs/superpowers/specs/2026-10-18-periplus-design.md` (Stack, Struktur, Glossar, Roadmap)
  und die Teil-Specs `…-01-…` bis `…-10-…`.
- DSTAP war nur der erste Prototyp; der Liefervertrag ist abnehmerneutral, keine Kompatibilität mit DSTAP.
- Schlank bleiben: von Caloga/Contexta nur übernehmen, was hier trägt; keine Designery-Infrastruktur
  (Entra, Repo-Vorlage, GlitchTip, SITA).

## Konventionen

- Code, Bezeichner, Tabellen, API, Vertrag, Prompts: Englisch. Oberfläche: Deutsch. Specs: Deutsch.
  Glossar im Gesamtdesign, Abschnitt 8.
- Fachlogik nur in `lib/domain` und `lib/pipeline`; Seiten, API-Routen und Job-Handler bleiben dünn.
- Kein Fact ohne wörtliches Zitat oder Berechnungs-Eingangsdaten. Nur anfügende Tabellen werden nie
  geändert oder gelöscht.
- Schwellen, Gewichte, Schemas, Prompts, Budgets: in `config/`, nicht im Code.
- Externe Dienste nur über Adapter in `lib/adapters`; Tests rufen nie das Netz, KI über `MockModel`.
- Tests gegen echte Postgres (`db-test`, Name endet auf `_test`), nicht gegen Mocks.
- Vor Code an Routen, `proxy.ts` oder `next.config.ts`: Next-16-Doku in `node_modules/next/dist/docs/` lesen.

## Befehle

| Befehl | Was |
| --- | --- |
| `npm run services:up` / `services:down` | Entwicklungsdienste (Postgres, Test-Postgres, S3) |
| `npm run dev` | Next.js-Entwicklungsserver |
| `npm run lint` | ESLint |
| `npm run build` | Build und Typprüfung |
