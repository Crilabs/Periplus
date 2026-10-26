# T0 – Eingang und Ausgangsstand (Attika 2)

Stand 26.10.2026, 13:35. Gesteuert über den Periplus-MCP von lokal (Worktree `pruefung/attika-2`).

## Step 1: Eingangsbedingungen

| Prüfung | Erwartung | Ergebnis |
| --- | --- | --- |
| `origin/main` enthält N5, N6, N7, MCP + Steuerung | ja | ja: #32 (N5), #33 (N6), #31 (Tor), #34/#36 (MCP), #37 (N7); lokal in `pruefung/attika-2` gemergt |
| CI auf `main` | grün | grün: letzter Lauf auf `main` (Merge #37, 26.10. 10:29) erfolgreich; #34 war rot, durch #35/#36 behoben |
| `research:gate` meldet Kernwerte | Abschnitt „Kernwerte gegen die Referenz (N=…)“ | ja (`lib/domain/research/gate-report.ts`), nicht mehr „noch nicht verglichen“ |
| `/readyz` | 200 | 200 |
| MCP `version` | SHA `main`, Migration ≥ `0082_mcp_reader_login` | `4a005d0` = `origin/main`; `0082_mcp_reader_login` (26.10. 06:26); `configHash` 235619fe91b05187, `gateConfigHash` 7d3da3c5b8cf1d15 |
| Produktion leer (A2) | 0 | `subdivisions` 0, `geo_objects` 0, `runs` 0, `places` 0, `tiles` 0 |
| Worker | ein Heartbeat, Queues leer | ein Heartbeat (Alter 0 s), alle 27 Queues 0 wartend/aktiv/fehlgeschlagen, nichts pausiert |

**Tor Step 1: erfüllt.**

## Step 2: Vorher-Werte (vor N5–N7, Dev-Datenbank)

| Größe | Vorher | Quelle |
| --- | --- | --- |
| Navily-Spots im Landesteil (alte Datei) | 558 | `n3-tor.md` |
| Kandidaten Probekachel | 85 (77 Ankerbuchten, 7 Marinas, 1 Hafen), 36 mit Namen | `n1-probelauf.md` |
| Kandidaten GR-I (N7-Messlauf) | 186 | `befunde.md` B8 |
| Gazetteer-Objekte GR-I (N7) | 2.317 (Hierarchie 1,4 min) | `befunde.md` B7 |
| Dinge an Land GR-I (N7) | 5.602 OSM- + 50 Wikidata-POIs, 36,5 min | `befunde.md` B8/B24 |
| bestätigt N=2 / 3 / 4 / 5 | 2 / 0 / 0 / 0, Korrektheit 100 % bei N=2 | `n3-tor.md` |
| Fehlliste N=2 | kein Kandidat 529, ohne Namen 7, ohne Treffer 1, zu wenige Quellen 12, Negativbelege 7 | `n3-tor.md` |
| Kosten je Kandidat (Probekachel) | 9,83 € gesamt, ≈ 0,29 € je Kandidat mit Namen | `n1-probelauf.md` |
| Suchtreffer je Kandidat | 38 positiv / 35 negativ (Obergrenze 40 meist erreicht) | `n1-probelauf.md` |

## Step 3: Navily-Referenz (nur Zählungen)

Datei `data/navily/navily-spots.json` (lokal, gitignored), Stand 25.10.2026 22:58.

| Größe | Wert |
| --- | --- |
| Spots gesamt | 914 |
| je `kind` | `mooring` 743, `port` 171 |
| je `type` | `anchor` 720, `aflot` 60, `public_quay` 49, `jetty` 45, `prohibited` 18, `dry-berthing` 16, `buoy` 5, `sluice` 1 |

Vormessung gegen die Dev-DB (25.10.2026): 751 im Polygon von `GR-I`, 430 in Kacheln von `GR-I` (6 `prohibited`, 10
`dry-berthing`), 22 von 25 Küstenkacheln mit Spot.

Ruling: Polygon- und Kachel-Zählungen auf Produktion folgen nach T1 (Polygon) bzw. T2 (Kacheln). Produktion hat noch
keine Landesteile und Kacheln (A2), ein Zählen jetzt ist nicht möglich. Die Dateizählung entspricht der Vormessung
(914), die Datei ist unverändert.

**Tor T0 (Referenz deckt GR-I ab):** ja nach Vormessung; Bestätigung auf Produktion in `T1-gazetteer.md`.

## Step 4: Konfiguration (wirksam auf Produktion, MCP `version`)

- `research.gate`: Schwellen 2–5, `released` false, `chosenThreshold` null, `maxPositionDeviationM` 150,
  `shelterErrorMin` 0,7, `minConfirmed` 25, `minCoverage` 0,5.
- `research.confirmation`: `minIndependentSources` 2, `minSignalConfidence` 0,7, `corridorAloneConfirms` false,
  `copyMinSharedWords` 12.
- `research`: `maxHitsPerCandidate` 40, `refetchDays` 90, Sprachen GR el/en/de/it/fr, 11 positive und 5 negative
  Suchvorlagen; Entdeckung `corridorBufferKm` 3, `minNameSimilarity` 0,8.
- `quality.navily`: `excludedTypes` prohibited, dry-berthing; `prohibitedTypes` prohibited.
- Budgets je Tag: Anthropic 80 €, DataForSEO 10 €, OpenAI 10 €, Jina 5 €, Firecrawl 2 €.
- Modelle: Bewertung, Routen, Extraktion (`extract-berth` Prompt v2), Landseite, Bündel: `claude-sonnet-5-5`;
  Bild- und Website-Prüfung `claude-haiku-5-5`; Ortsbild `gpt-image-2.5-sunburst` high (0,25 €/Bild);
  Batch-Rabatt 50 %.
