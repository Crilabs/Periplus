# M3 Abnahme: Quellen und Archiv

Abnahmekriterium aus der Roadmap (Gesamtdesign): Whitelist mit 20–40 Quellen; voller Crawl archiviert; Entscheidung Konverter dokumentiert. Teil-Spec 05: 20–40 freigegebene Quellen für das Pilotrevier; vollständiger Crawl ohne fehlgeschlagene Jobs außer dokumentierten; Konverter- und PDF-Entscheidung dokumentiert; Kosten je Quelle sichtbar. Pilotbudget SERP: weniger als 500 Aufrufe.
Ablauf der Läufe: `docs/runbook.md`, Abschnitt „Quellen und Archiv“.

## Vom Code geprüft (Stand der Umsetzung)
- [x] Quellenfindung je Revier und Kachel über DataForSEO (Tiefe 20, gleiche Query 30 Tage nicht erneut, höchstens 240 Suchen je Lauf), Vorschläge aus SERP-Treffern (≥ 3) und Linkgraph (≥ 2 verlinkende freigegebene Quellen), Navily und ignorierte Portale nie vorgeschlagen; Review „Quellenfreigabe“ mit Typ, Gewicht, Änderungsrate und Crawl-Regeln.
- [x] Crawl als ein Lauf (`fetch.source → fetch.url → embed.chunks`): robots.txt je Host und Lauf, ausdrückliches Verbot pausiert die Quelle, Crawl-Regeln, Rate je Domain mit Crawl-delay, Weiterleitungen einzeln geprüft (Domain, Adresse, robots), SSRF-Schutz bis zur Verbindung (DNS-Rebinding) und im Renderer (toter Proxy), 304/gleicher Inhalt ohne neue Version, `gone` nach zwei 404/410.
- [x] Archiv: Rohdatei, Markdown und Diff je Version in S3, `content_hash` eindeutig je Dokument, Chunks an Überschriften (Ziel 500, Grenze 800 Wörter), unveränderte Chunks übernommen, Embeddings mit Voyage (`voyage-3.5`, 1024) und HNSW-Index; Kosten je Aufruf mit `source_id` in `external_calls`.
- [x] Wikivoyage über Wikidata-Sitelinks der Gazetteer-Objekte; PDF-Upload (100 MB) mit `pdftotext` und Claude-Fallback für unlesbare Seiten; Konverter Jina, Firecrawl und lokal (Readability, Rendern bei wenig Hauptinhalt).
- [x] Admin-Oberfläche: `/sources` (Liste, Status, Läufe, Kosten 30 Tage), Quell-Detail (Regeln, Testcrawl, Crawl, Pausieren/Fortsetzen, PDF-Upload, Kosten je Dienst), Dokumentansicht mit Versionen, Diff, Chunks und Rohdatei in Sandbox, `/compare/converters` mit Bewertung in drei Spalten, `/settings` mit Konverter-Entscheidung, PDF-Extraktor und Embedding-Modell.
- [x] `npm run report:converters` schreibt `docs/pilot/m3-konverter-vergleich.md`; `npm run pdf:compare` schreibt `docs/pilot/m3-pdf-vergleich.md`; `npm run check:sources` prüft die Abnahme (Exit 1 bei 19 Quellen oder vorläufiger Entscheidung, Test `scripts/__tests__/check-sources.test.ts`).
- [x] End-to-End-Test `e2e/sources.spec.ts`: Login → Quellen → vorgeschlagene Quelle im Review freigeben → Quelle als „Freigegeben“ gelistet.

## Offen für Christian (Übergabe, nicht automatisierbar)
1. [ ] **Voyage-Zahlungsmethode hinterlegen**, bevor der volle Crawl läuft (Ruling M3-D-R1). Ohne sie gelten 3 Anfragen und 10 000 Token je Minute; `embed.chunks` läuft dann dauernd in 429-Wiederholungen. Danach fehlende Embeddings mit „Einbettungen nachholen“ (Runbook, „Embeddings neu berechnen“).
2. [ ] **Hängende Läufe beenden**: Ein Crawl-Lauf, der nach einem Worker-Absturz „Wartend“ oder „Läuft“ bleibt, sperrt seine Quellen für jeden neuen Abruf, bis er beendet ist. Eine Schaltfläche fehlt; Beenden per SQL steht im Runbook („Hängender Lauf“).
3. [ ] **Netz des Workers absichern**: Der Renderer verlässt sich auf den toten Proxy `127.0.0.1:9` (Ruling M3-SEC-R3) und die Adressprüfung im Code. Zusätzlich auf dem Server ausgehende Verbindungen in private Netze (RFC 1918, 169.254.0.0/16, 100.64.0.0/10, fc00::/7, ::1) per Firewall sperren (Verteidigung in der Tiefe).
4. [ ] **Auf dem Server** in der Reihenfolge des Runbooks:
   1. Quellenfindung für `saronic` (danach `argolic`), Vorschläge prüfen und freigeben, Ziel 20–40.
   2. Wikivoyage-Lauf je Revier; Testcrawl je freigegebener Quelle, Regeln nachschärfen.
   3. „Vergleich starten“ unter „Konverter“, alle 50 Seiten bewerten, `report:converters`, Bericht einchecken.
   4. Konverter in `config/fetch.json` entscheiden (`defaultConverter`, `converterBySource`, `decision.status "decided"`, `decision.note`), einchecken, deployen.
   5. Die zwei Revierführer als PDF hochladen, `pdf:compare` lokal, Bericht einchecken, `pdf` in `config/fetch.json` entscheiden, deployen.
   6. „Alle freigegebenen crawlen“, danach „Linkgraph-Vorschläge“ und deren Review.
   7. `check:sources` ausführen, bis es mit Exit 0 endet; fehlgeschlagene Jobs unter „Prüfen“ entscheiden oder hier dokumentieren.
5. [ ] Offenen Punkt „Fetch-Konverter (M3)“ im Gesamtdesign (Abschnitt Offene Punkte) abhaken.

## Abnahmekriterien
- [ ] **20–40 freigegebene Quellen** für das Pilotrevier: `check:sources` meldet die Zahl im Bereich.
- [ ] **Voller Crawl archiviert, ohne undokumentierte Fehler**: `check:sources` meldet 0 offene fehlgeschlagene Jobs der Queues `fetch.*` und `embed.chunks`; verbleibende fehlgeschlagene Frontier-URLs (Spalte `failed`, z. B. 403) sind je Quelle angesehen; Ausnahmen unten unter „Ergebnis“ dokumentiert.
- [ ] **Konverter-Entscheidung dokumentiert**: `docs/pilot/m3-konverter-vergleich.md` eingecheckt, `config/fetch.json` `decision.status` = `decided` (`check:sources` meldet `decided`).
- [ ] **PDF-Entscheidung dokumentiert**: `docs/pilot/m3-pdf-vergleich.md` mit ausgefüllten Prüflisten eingecheckt, `config/fetch.json` `pdf` gesetzt.
- [ ] **Kosten je Quelle sichtbar**: Quell-Detail „Kosten“ je Dienst und Spalte „Kosten 30 Tage“ in `/sources`; `check:sources` listet die Kosten je Quelle.
- [ ] **SERP-Aufrufe < 500** im Pilot: unter „Kosten“ Dienst `dataforseo` (Aufrufe) prüfen; jeder Lauf ist auf 240 Suchen gedeckelt.

## Kosten der Umsetzung (echte Aufrufe)
| Dienst | Bündel F (Konverter-Vergleich, 1 Seite Probe) | Stand Entwicklungsdatenbank vor Bündel F (Aufnahmen M3) |
| --- | ---: | ---: |
| Jina | 0,0002 € | 0,0008 € |
| Firecrawl | 0,0047 € | 0,0141 € |
| DataForSEO | 0 € | 0,0038 € |
| Anthropic | 0 € | 0,0050 € |
| Voyage | 0 € | 0 € |

Die Probe (eine Wikivoyage-Seite durch alle drei Konverter) lief gegen die Entwicklungsdatenbank in einer zurückgerollten Transaktion; die Kosten oben stammen aus ihren `external_calls`-Zeilen vor dem Rollback. Alles liegt weit unter `config/budgets.json`. Der eigentliche Vergleich (50 Seiten) kostet auf dem Server etwa 0,24 € Firecrawl und 0,01 € Jina.

## Offene Kleinpunkte aus den Reviews (bewusst verschoben)
| Punkt | Ort |
| --- | --- |
| `crawl_frontier.updated_at` setzt die Anwendung, kein Trigger | `lib/pipeline/fetch/url.ts`, `lib/pipeline/fetch/source.ts` |
| `documents.url_normalized` ist global eindeutig: eine URL gehört genau einer Quelle (zweiter Upload desselben PDFs zeigt den Hinweis auf die erste Quelle) | `lib/db/schema/sources.ts` |
| Fixtures filtern Header per Sperrliste (`set-cookie`, `x-client-ip`, `x-analytics`) statt Erlaubnisliste | `lib/adapters/http-fixtures.ts` |
| Zweig „`costOf` wirft“ in `httpCall` ohne Test | `lib/adapters/http.ts` |
| SERP: S3-Objekt bleibt verwaist, wenn das Einfügen nach dem Ablegen scheitert; Queries mit 40xxx-Fehler werden im nächsten Lauf erneut bezahlt | `lib/domain/discovery/serp.ts` |
| Quellenfindung: kein ausdrücklicher Test für die Wiederholung eines Laufs; Prüfung „Revier bereit“ dreifach kopiert; Dublettenschleife doppelt; Navily nur als `navily.com` gesperrt; `domainCandidates` liest ganze Tabellen | `lib/pipeline/discovery-run.ts`, `datasets-run.ts`, `geometry-run.ts`, `lib/domain/discovery/queries.ts`, `config/discovery.json`, `lib/domain/discovery/proposals.ts` |
| Chunker: Überschriften h4–h6 zählen nicht für die Regel „Überschrift allein“; CSV schneidet überzählige Zellen ab; `franc` ordnet nicht gelistete Sprachen einer gelisteten zu | `lib/domain/documents/chunker.ts`, `structured.ts`, `language.ts` |
| Kein Gesamt-Bytebudget je Seitendarstellung, nur je Teilanfrage (Ruling M3-C-R7) | `lib/adapters/fetch/browser.ts` |
| „Alle freigegebenen crawlen“ nimmt je Quelle eine Advisory-Sperre in einer Transaktion; bei Tausenden Quellen `max_locks_per_transaction` beachten | `lib/pipeline/fetch/run.ts` |
| Beendete Quellen sind nur noch per URL erreichbar (angenommen, M3-E-R1) | `app/(admin)/sources/[id]/page.tsx` |
| Konverter-Vergleich: eine fehlgeschlagene Umwandlung kostet 0 € in `converter_outputs` (bezahlte Jina-/Firecrawl-Antworten mit Zielfehler stehen nur in `external_calls`); der Start prüft „kein anderer Vergleich läuft“ ohne Sperre | `lib/pipeline/compare-converters.ts`, `lib/pipeline/compare-converters-run.ts` |

## Bewusst verschoben
- Täglicher Abruf über RSS und Sitemaps → M8 (Spec 05); `change_rate` wird in M3 nur gepflegt.
- `restricted_areas.source_id` bleibt leer bis zur Konsolidierung (M5).
- LlamaParse und Mistral OCR für PDFs: kein Schlüssel, nur als Option im PDF-Bericht vermerkt.

## Ergebnis
Datum der Abnahme: _offen_. Freigegebene Quellen: _offen_. Ausgabe von `check:sources`: _offen_. Konverter-Entscheidung: _offen_ (vorläufig `local`). PDF-Entscheidung: _offen_ (vorläufig `pdftotext` mit Claude-Fallback). Dokumentierte Fehler des vollen Crawls: _offen_.
