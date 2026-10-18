# Periplus 06 – Erwähnungen, Fact-Extraktion und Routen (Stufen 6 und 7)

Stand: 18.10.2026 · Gehört zu: `2026-10-18-periplus-design.md` · Meilenstein: M4 · Quell-Spec: Grundprinzipien 5, 7, 8, 11; Verarbeitungsstufen 6 und 7; „Modell-Schnittstelle“; „Qualitätsmetriken“ (Belegtreue)

## Zweck

In jedem archivierten Text finden, welche Geo-Objekte er nennt (meist ohne Modell), und aus jeder Erwähnung belegte Facts gegen das Fact-Schema ziehen. Ein Fact ohne wörtliches Zitat existiert nicht.

## Stufe 6: Klassifikation und Erwähnungen

### Dokument-Klassifikation (`classify.document_version`)

Je neuer Dokumentversion ein günstiger Modellaufruf (Haiku-Klasse, Batch) mit Titel, URL, ersten 1.500 Wörtern: `doc_type`, Sprache(n), `published_at`, `observed_at` mit Begründung (z. B. „Wir waren im Mai 2024 …“ → 2024-05-15, `observed_at_basis = explicit`), erkannte Reviere/Inseln als Freitext. Ohne explizites Beobachtungsdatum gilt `published_at`, sonst Abrufdatum (`basis` entsprechend). Ergebnis wird an der Version gespeichert (technische Spalten, im Trigger freigegeben).

### Deterministischer Match (`mentions.batch`, je 50 Dokumentversionen)

1. Kandidaten-Geo-Objekte eingrenzen: Kacheln, die das Dokument bereits berührt (aus Quelle, URL-Muster, erkannten Revieren), plus deren 8 Nachbarn; bei unbekanntem Bezug das Revier der Quelle.
2. Je Chunk Wort-N-Gramme (1–4 Wörter) normalisieren (wie `geo_names.name_normalized`, griechische Wörter zusätzlich transliteriert) und gegen die Namen der Kandidaten vergleichen: exakter Treffer oder `similarity ≥ 0,75` (pg_trgm) bei Namen ≥ 5 Zeichen; Präfixe wie „Ormos“, „Bay of“, „Bucht von“, „Limani“, „Porto“ werden über eine Liste in `config/name-affixes.json` abgestreift und als Typhinweis genutzt.
3. Eindeutige Treffer (genau ein Geo-Objekt, oder ein Name, der in den Kandidaten nur einmal vorkommt) → `mentions` mit `match_kind = deterministic`, `confidence = similarity`.
4. Mehrdeutige Treffer (gleicher Name mehrfach, Transliteration unsicher, Similarity 0,6–0,75) → `mentions.disambiguate` (Haiku-Klasse, Batch) mit Chunk und den 2–6 in Frage kommenden Objekten (Name, Typ, Eltern, Koordinate). Antwort: Objekt-ID oder „keines“, Konfidenz. → `match_kind = model`.
5. Erwähnungen von Inseln und Revieren werden ebenso gespeichert (Grundprinzip 8).
6. **Neue Namen:** N-Gramme mit Ortshinweis („Bucht“, „Ormos“, „anchorage“ …), die zu keinem Objekt passen, werden in `unmatched_names` gesammelt (name_normalized, document_version_id, chunk_id). Ein Name in ≥ 2 Dokumenten verschiedener Quellen → Nominatim-Umkreissuche (20 km um die Kachel) → Review-Aufgabe `place_candidate` mit Fundstellen und Geocoding-Vorschlag.

### Kachelgrenzen

Die Einschränkung auf Kachel plus Nachbarn deckt Orte an Kachelgrenzen ab. Ob überlappende Ränder nötig sind (offener Punkt der Quell-Spec), wird in M4 an der Zahl der `unmatched_names` gemessen, die nach Erweiterung auf den Zweierring gefunden würden; ein Test-Schalter in `config/mentions.json` erlaubt den Vergleich.

## Stufe 7: Fact-Extraktion (`extraction.mention`)

- **Einheit:** eine Erwähnung mit ihrem Chunk plus Nachbar-Chunks (davor/danach), gruppiert je (Dokumentversion, Geo-Objekt), damit mehrere Erwähnungen desselben Orts in einem Text nur einen Aufruf kosten.
- **Eingabe an das Modell:** Text der Chunks mit Zeichenpositionen, Geo-Objekt (Name, Typ, Ebene, Eltern), Dokumenttyp, Beobachtungsdatum, das Fact-Schema der Ebene als Liste mit Beschreibung und Wertebereich (aus `config/fact-schema/`), die Abbildungstabellen (z. B. Schutz-Wörter → Zahl).
- **Ausgabe (zod-Schema):** Liste von `{ attribute, value, quote, confidence, observed_at? }`; `quote` muss ein zusammenhängender wörtlicher Ausschnitt sein (≤ 300 Zeichen).
- **Belegprüfung (harte Schranke):** `quote` wird normalisiert (Whitespace, typografische Anführungszeichen, Bindestriche) und muss als Teilstring im normalisierten Chunk-Text vorkommen. Kein Treffer → Fact wird verworfen und gezählt. Ein Extraktionslauf, in dem nach dieser Prüfung ein Fact ohne Beleg gespeichert würde, ist unmöglich; zusätzlich prüft ein Kontrolljob je Lauf `quote_verified` über alle Facts (Kennzahl Belegtreue, Teil-Spec 10).
- **Wertprüfung:** `value` gegen das zod-Schema des Attributs; ungültig = verworfen und gezählt.
- **Sprache:** Zitate bleiben in der Originalsprache; die Werte sind sprachneutral (Enums, Zahlen).
- **Highlights:** Nennungen von Tavernen, Stränden, Ruinen usw. werden als Fact `highlight.<category>` am Ort extrahiert, mit Name des POI, falls genannt. Passt der Name zu einem `poi`-Geo-Objekt im Umkreis von 2 km, wird zusätzlich eine Erwähnung des POI angelegt; sonst entsteht ein `unmatched_names`-Eintrag (POIs werden erst ab zwei Nennungen Kandidat).
- **Batch:** Extraktion läuft über die Batch-API; `ai.batch.poll` verteilt Ergebnisse. Ereignisgesteuerte Einzelfälle (M8) synchron.

### Modellvergleich (M4)

200 Erwähnungen aus mindestens 8 Quellen und allen Dokumenttypen, je mit Sonnet- und Opus-Klasse extrahiert (zwei `extraction_runs`). Vergleich in der UI nebeneinander: Anzahl Facts, verworfene Zitate, Übereinstimmung, Kosten; der Admin bewertet eine Stichprobe von 50 Abweichungen. Entscheidung in `config/models.json`, im Gesamtdesign abgehakt. Facts des nicht gewählten Laufs bleiben gespeichert, werden aber nicht konsolidiert (Konsolidierung liest nur den aktiven Lauf je Dokumentversion, Teil-Spec 07).

## Routen aus Törnberichten (`extraction.route`)

Für Dokumentversionen mit `doc_type = trip_report` ein zusätzlicher Aufruf über das ganze Dokument (bei > 20.000 Wörtern in Abschnitten): Stopps in Reihenfolge mit Name, Datum, Liegeart, Leg-Hinweise (Distanz, Dauer, Wind) jeweils mit Zitat. Stopps werden über die vorhandenen Erwähnungen den Geo-Objekten zugeordnet; nicht zuordenbare Stopps bleiben mit Namen stehen und zählen in der Kennzahl Routen-Rekonstruktion als offen. Routen sind unveränderlich (Quell-Spec).

## Reprozessierung

Bei neuem Fact-Schema, Prompt oder Modell: ein Admin startet in der UI einen Lauf `reprocess` für eine Kachel/ein Revier und Stufen 6–8. Es entsteht ein neuer `extraction_run`; alte Facts bleiben. Die Konsolidierung nimmt je Dokumentversion den jüngsten erfolgreichen Lauf der aktiven Konfiguration.

## Prompts

`config/prompts/classify-document/v1.md`, `disambiguate-mention/v1.md`, `extract-facts/v1.md`, `extract-route/v1.md`. Gemeinsame Regeln in jedem Prompt: nur aus dem Text, nichts erschließen, jedes Fact mit wörtlichem Zitat, im Zweifel weglassen, Datum nur wenn im Text. Prompts werden englisch geschrieben; Texte sind mehrsprachig.

## UI-Anteil

Dokument-Viewer zeigt Erwähnungen als Hervorhebung, Facts mit Zitat-Markierung im Text; Ort-Detail listet Facts je Attribut mit Zitat, Quelle, Datum, Konfidenz, Lauf; Seite „Modellvergleich“; Review `place_candidate` aus Texten.

## Tests und Abnahme

- Unit: Normalisierung, Affix-Abstreifen, Zitat-Prüfung (inkl. Griechisch, typografische Zeichen), Gruppierung von Erwähnungen.
- Integration mit `MockModel`: Fixture-Dokumente (deutsch, englisch, griechisch) mit erwarteten Erwähnungen und Facts; ein gefälschtes Zitat wird verworfen; Wiederanlauf erzeugt keine Dubletten.
- Abnahme M4: Belegtreue 100 %; Modellwahl dokumentiert; Kosten je Erwähnung gemessen; Anteil Erwähnungen ohne Modellaufruf > 70 %.
