# Periplus

Ankerplatz-Datendienst: sammelt, belegt und versioniert Wissen über Ankerplätze, Häfen, Marinas, Reviere
und Routen im Mittelmeer und stellt es über eine API bereit. Ein Periplus war in der Antike das Verzeichnis
der Häfen und Landmarken entlang einer Küste.

## Dokumente

| Dokument | Inhalt |
| --- | --- |
| `.idea/datendienst-spec.md` | Fachliche Spec (maßgebend) |
| `docs/superpowers/specs/2026-10-18-periplus-design.md` | Gesamtdesign, Abweichungen, Stack, **Roadmap** |
| `docs/superpowers/specs/2026-10-18-periplus-NN-*.md` | Teil-Specs 01–10 je Bereich |

## Entwicklung

Voraussetzungen: Node 22, Docker.

```bash
cp .env.example .env.local          # Werte ergänzen
npm install
npm run services:up                 # Postgres (PostGIS, pgvector), Test-Postgres, S3 (SeaweedFS)
npm run dev                         # Admin-UI und API auf http://localhost:3000
```

| Dienst | Adresse |
| --- | --- |
| Postgres (Entwicklung) | `localhost:5433`, Datenbank `periplus` |
| Postgres (Tests) | `localhost:5434`, Datenbank `periplus_test` |
| S3 (SeaweedFS) | `http://localhost:8333`, Bucket `periplus-archive` |

Stand: Meilensteine M0–M7 (Teil a: Code, an Fixtures und `MockModel` geprüft) sind umgesetzt; der Pilotbetrieb (M7 Teil b) steht aus. Betrieb: `docs/runbook.md`, Pilot: `docs/pilot/m7-runbook.md`.
