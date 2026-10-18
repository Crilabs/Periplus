# Periplus 05 – Quellenfindung, Fetch und Archiv (Stufen 4 und 5)

Stand: 18.10.2026 · Gehört zu: `2026-10-18-periplus-design.md` · Meilensteine: M3, täglicher Fetch in M8 · Quell-Spec: Grundprinzipien 4, 6, 7, 9; Verarbeitungsstufen 4 und 5; „Änderungserkennung“ Ebene 1; „Technologie“ (SERP, Fetch); Rechtliches

## Zweck

Gute Quellen finden, freigeben lassen und vollständig lesen; jede gelesene Seite als versioniertes Markdown archivieren und in Chunks zerlegen. Das Archiv ist das eigentliche Asset (Grundprinzip 4).

## Stufe 4: Quellenfindung

### SERP (DataForSEO, vorhandener Zugang)

- Job `discovery.area` je Revier und `discovery.tile` je Kachel. Suchbegriffe = Templates aus `config/discovery.json` × Namen aus dem Gazetteer × Sprachen des Reviers. Revier-Ebene: Reviernamen; Kachel-Ebene: Inseln, Küstenorte und Buchten mit Namen (größere Buchten: Ankerfläche ≥ 20.000 m² oder ≥ 2 Namen in Wikidata). Templates wie Quell-Spec Stufe 4 („Törnbericht {name}“, „{name} anchorages“, „Revierführer {name}“, „Ankerplatz {name}“, „anchorage {name}“, „αγκυροβόλιο {name}“ …).
- DataForSEO „Google Organic Live/Regular“, Ort und Sprache je Template, Tiefe 20 Ergebnisse. Jede Antwort roh in S3 (`serp/<datum>/<hash>.json`), Ergebniszeilen in `serp_results` (query, lang, rank, url, domain, run_id).
- Kosten werden je Aufruf erfasst; Pilotbudget < 500 Aufrufe (Quell-Spec). Gleiche Query innerhalb von 30 Tagen wird nicht erneut gestellt.

### Linkgraph

Beim Fetch freigegebener Quellen werden ausgehende Links nach Domain gezählt (`outlinks`: from_source_id, to_domain, count, run_id). Domains, auf die ≥ 2 freigegebene Quellen verlinken, werden Quellenvorschläge ohne SERP.

### Quellenvorschläge und Freigabe

- Aggregation nach registrierbarer Domain (Public Suffix List). Neue Domain mit ≥ 3 SERP-Treffern oder Linkgraph-Schwelle → `sources` mit `status = proposed` und Review-Aufgabe `source_approval` mit Kontext: Treffer-URLs mit Query, Titel und Snippet, Linkgraph-Zahl, Sprache, robots.txt-Zusammenfassung, Vorschlag für Typ und Crawl-Regeln (aus URL-Mustern der Treffer abgeleitet, kein Modell).
- Admin entscheidet: Typ, Gewicht 0–1 (Vorgabe je Typ aus `config/source-types.json`: `pilot_guide` 0,9, `authority` 0,9, `marina` 0,8, `trip_report` 0,6, `travel_guide` 0,5, `forum` 0,4), Crawl-Regeln, Änderungsrate; oder ablehnen (dauerhaft ignoriert).
- Bekannte und abgelehnte Domains erzeugen keinen neuen Vorschlag.
- Vorab-Whitelist: Wikivoyage (Typ `travel_guide`), OSM-Wiki nicht. Weitere Kandidaten (Revierführer-Verlage, Marina-Seiten) entstehen über SERP.

### Crawl-Regeln (`sources.crawl_rules`, zod-Schema in `lib/domain/sources/crawl-rules.ts`)

```json
{
  "startUrls": ["https://example.com/greece/saronic/"],
  "allow": ["^/greece/(saronic|argolic)/"],
  "deny": ["/tag/", "/comment", "\\?replytocom="],
  "maxDepth": 3,
  "maxPages": 500,
  "ratePerMinute": 20,
  "render": "auto",
  "converter": "auto",
  "pdf": true
}
```

`render`: `never` (nur HTTP), `always` (Playwright), `auto` (Playwright, wenn der HTTP-Text < 500 Zeichen Hauptinhalt hat). robots.txt wird immer beachtet (auch für `startUrls`) und je Lauf neu gelesen; ein ausdrückliches Crawl-Verbot setzt die Quelle auf `paused` mit Hinweis.

## Stufe 5: Fetch

- Job `fetch.source` je Quelle: arbeitet die Crawl-Front (Tabelle `crawl_frontier`: source_id, url_normalized, depth, status, discovered_at) ab und legt je URL einen Job `fetch.url` an. URL-Normalisierung: Kleinschreibung von Host, ohne Fragment, ohne Tracking-Parameter (`utm_*`, `fbclid` …), sortierte Query.
- `fetch.url`:
  1. HTTP GET mit eigenem User-Agent (`Periplus/<version> (+mailto:<CONTACT_EMAIL>)`), Rate-Limit je Domain (Teil-Spec 01), ETag/Last-Modified aus der letzten Version mitsenden.
  2. 304 oder gleicher Inhalt → nur `last_checked_at` setzen. 404/410 → `consecutive_gone + 1`; bei 2 → `documents.status = gone`, `valid_to` an seinen Facts setzt die Konsolidierung (Facts selbst bleiben, Quell-Spec).
  3. Konvertierung nach Markdown über den Konverter-Adapter (`lib/adapters/fetch/`): `jina`, `firecrawl`, `local` (Playwright + Readability + HTML-zu-Markdown). PDF: `pdf`-Adapter (siehe unten). Tabellen und Geodaten (CSV, GeoJSON, KML) bleiben strukturiert und werden zusätzlich als Markdown-Tabelle für die Klassifikation abgelegt.
  4. Normalisieren (Zeilenenden, Whitespace, Boilerplate-Entfernung je Quelle über optionale CSS-Selektoren in den Crawl-Regeln), Hash bilden.
  5. Neuer Hash → `document_versions` + S3: `archive/<document_id>/<fetched_at ISO>_<hash8>.raw.<ext>`, `.md`, `.diff` (Unified Diff zur Vorversion).
  6. Sprache erkennen (lokale Bibliothek, z. B. `franc`), `published_at` aus Metadaten (`article:published_time`, JSON-LD, URL-Datum), `observed_at` zunächst = `published_at`; die Klassifikation (Teil-Spec 06) kann sie aus dem Text präzisieren.
  7. Links extrahieren → Crawl-Front (nur innerhalb `allow`) und Linkgraph.
  8. Chunks: Zerlegung an Überschriften und Absätzen, Ziel 500 Wörter, harte Grenze 800, Überlappung 1 Absatz. Bei neuer Version eines bekannten Dokuments: Chunks mit identischem normalisiertem Text werden mit `carried_from_chunk_id` übernommen, ihre Erwähnungen gelten weiter (Quell-Spec, Änderungserkennung Ebene 1); nur geänderte Chunks gehen in Stufe 6.
  9. Job `embed.chunks` (gebündelt, Voyage-Adapter) füllt `chunks.embedding` für neue Chunks.
- **PDF:** Revierführer und Hafenhandbücher. Adapter-Kandidaten für den Vergleich in M3: `pdftotext -layout` (Poppler, lokal), ein Modell-basierter Weg (Claude mit PDF-Eingabe, seitenweise, teuer, nur wenn lokal unlesbar) und ein spezialisierter Dienst (z. B. LlamaParse oder Mistral OCR). Entscheidung nach zwei Revierführern; Kriterium: Ortsnamen und Tabellen (Tiefen, Plätze) korrekt im Markdown.
- PDFs, die gekauft oder lizenziert sind, werden über die UI hochgeladen (Quelle mit `format = pdf`, Dokument ohne URL, `url = upload://<hash>`).

## Konverter-Vergleich (M3)

50 Seiten aus 10 Quellen, je mit `jina`, `firecrawl`, `local` konvertiert, nebeneinander in der UI (Seite „Konverter-Vergleich“). Bewertung je Seite durch den Admin: Hauptinhalt vollständig, Boilerplate entfernt, Tabellen erhalten; plus Kosten und Laufzeit aus `external_calls`. Ergebnis als Entscheidung in `config/fetch.json` (Standard-Konverter, Ausnahmen je Quelle) und im Gesamtdesign unter Offene Punkte abgehakt.

## Täglicher Fetch (M8)

Quellen mit `change_rate = high` (Blogs, Foren, Marina-News) einmal täglich: nur Startseiten und Listen/Feeds (RSS, Sitemap mit `lastmod`) auf neue oder geänderte URLs prüfen, dann `fetch.url` für diese.

## UI-Anteil

Quellenliste (Status, Typ, Gewicht, Dokumente, letzte Läufe, Kosten), Quellen-Detail mit Crawl-Regeln (Formular mit Validierung) und „Testcrawl 10 Seiten“, Review `source_approval`, Dokument-Viewer: Versionen auf einer Zeitleiste, Markdown gerendert, Diff zwischen zwei Versionen, Chunks mit Erwähnungen (ab M4), Link auf Original und Rohdatei.

## Tests und Abnahme

- Crawl-Regeln und URL-Normalisierung als Unit-Tests; robots.txt-Auswertung mit Fixtures.
- Fetch-Integration gegen einen lokalen Test-HTTP-Server (Fixtures mit Änderungen, 404, gleichem Inhalt): erwartete Versionen, übernommene Chunks, `gone` nach zwei Läufen.
- Abnahme M3: 20–40 freigegebene Quellen für das Pilotrevier; vollständiger Crawl ohne fehlgeschlagene Jobs außer dokumentierten; Konverter- und PDF-Entscheidung dokumentiert; Kosten je Quelle sichtbar.
