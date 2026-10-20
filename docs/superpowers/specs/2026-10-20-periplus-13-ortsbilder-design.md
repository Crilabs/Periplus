# Periplus 13 – Ortsbilder

Stand: 20.10.2026 · Gehört zu: `2026-10-18-periplus-design.md` · Zeitpunkt: nach M7 (offener Punkt „Bilder und Karten in Quellen“, Gesamtdesign Abschnitt 12) · Ergänzt: Teil-Spec 04 (Geometrie, Schutzsektoren), 05 (Fetch, Archiv), 06 (Facts), 07 (Konsolidierung), 08 (Liefervertrag), 09 (Admin-UI)

## Zweck

Jeder gelieferte Ort (Spot, später Highlight) bekommt neben `summary.de` ein Titelbild. Diese Spec beschreibt den Weg dorthin:

1. Ein **Luftbild** (Orthofoto) wird auf ein **Geländemodell** gelegt und als Schrägansicht vom Wasser aus gerendert. Form, Relief und Anordnung sind damit gemessen, nicht geraten.
2. Ein **Bildmodell** macht aus dem Rendering ein Katalogfoto: es zeichnet alle Oberflächen neu, behält aber Kamera, Küstenlinie und Inhalt bei.
3. Eine **Geometrieprüfung** und eine **menschliche Freigabe** sichern das Ergebnis; das Bild wird als KI-Illustration gekennzeichnet.

Ziel auf Dauer sind eigene Fotos (Nutzer-Upload, Auftrag; Entscheidung Christian, 20.10.2026). Bis dahin ist die gerenderte KI-Illustration das Titelbild; ein freies oder eigenes Foto ersetzt sie, sobald es vorliegt.

## Umfang und Stufen

Entscheidung Christian, 20.10.2026: **zunächst nur Griechenland und nur frei verfügbare Daten.**

| Stufe | Umfang | Luftbild | Kosten Luftbild |
| --- | --- | --- | --- |
| **1 (diese Umsetzung)** | griechische Reviere | Orthofoto des Hellenic Cadastre (offener WMS, mit Wasserzeichen), Sentinel-2 als Hintergrund, Copernicus DEM | 0 € |
| 2 | Länder mit offenen Orthofotos (Spanien, Frankreich, Kroatien, Slowenien, offene Regionen Italiens) | je Land, siehe Teil A | 0 € |
| 3 | übrige Mittelmeerländer | kommerziell (Vantor über UP42 mit Display & Media), nach Pilot-Angebot | siehe Kostenschätzung |

In Stufe 1 entstehen Bilder bis zur Antwort des Katasters **nur als Test** in der Admin-UI; geliefert werden sie erst nach schriftlicher Bestätigung der Lizenz (Schalter `images.delivery.ktimatologio` in `config/images.json`, Start `false`). Fällt die Antwort negativ aus, bleibt Griechenland ohne Titelbild bis Stufe 3. Teil E (Fotos und Merkmale), die UP42-Anbindung und die Adapter anderer Länder gehören nicht zu Stufe 1.

## Grundlage: Tests vom 20.10.2026

Skripte und Ergebnisse lagen im Scratchpad, nicht im Repo.

| Weg | Ergebnis |
| --- | --- |
| Bild nur aus Text (Merkmale) | typische Mittelmeerbucht; Form und Anordnung geraten |
| Merkmale + OSM-Skizze + Satellit als Vorlage | Anordnung stimmt grob, Bild beliebig; ein scharfes Orthofoto als direkte Vorlage verschlechterte das Ergebnis |
| Geschützte Fotos des Orts als Vorlagen | bei ≥ 14 Luftaufnahmen erkennbar, aber nur in der Blickrichtung der Vorlagen; bei 3 Vorlagen dominiert ein Einzelobjekt; ruhige Buchten haben kaum Fotos; rechtlich heikel |
| **Rendering (Orthofoto 0,5 m + Copernicus DEM 30 m) → Bildmodell** | **Geometrie bleibt erhalten** (Wasser-Überlappung Rendering/KI 0,85–0,95), kein fremdes Foto nötig; gewählter Weg |

Weitere Ergebnisse, auf denen die Festlegungen unten beruhen:

- **Neigung:** 90°, 70°, 50°, 30°, 20°, 10° getestet; **30°** ist der beste Kompromiss aus Übersicht und Katalogwirkung (Entscheidung Christian).
- **Zoom:** 450 m (z1), 277 m, 173 m, 104 m Abstand. Bei 0,5-m-Luftbild bis 173 m sauber; bei 104 m übernimmt das Modell die Pixelblöcke des Renderings im Wasser als Muster – ein Prompt-Hinweis schwächt das ab, beseitigt es nicht.
- **Modelle:** Gemini 3.1 Flash Image, Gemini 3 Pro Image (mit Tiefenkarte), GPT Image 2.5 Sunburst. **GPT Image 2.5 Sunburst** zeichnet am konsequentesten neu und hält die Geometrie am besten (Entscheidung Christian).
- **Prompt:** gegliedert in *Preserve exactly / Do not add / Regenerate / Light*. Ohne den Satz „keep the existing small structures“ ließ GPT vorhandene Bauten weg; ohne „edges show the same content“ zoomte es leicht heraus.
- **Licht:** Morgen, Mittag, Nachmittag, goldene Stunde, später Abend getestet. Die Geometrie hält bei allen. **Ankerbuchten mittags**, **Marinas und Orte bei Städten abends** (Entscheidung Christian).
- **Häfen (Marina Alimos, Poros-Stadt):** Mit „Boote nur dort, wo das Rendering sie zeigt“ bleiben Stege, Yachten und Dichte erhalten; die Stadt ist am Grundriss erkennbar.
- **Wasserzeichen:** Das offene Orthofoto des griechischen Katasters trägt ein halbtransparentes Band mit Logo; beide Modelle entfernen es auf Anweisung vollständig.

## Teil A: Luftbild und Gelände

### Quellen je Land

| Land | Luftbild | Lizenz | Status |
| --- | --- | --- | --- |
| Spanien | PNOA (IGN), 25 cm, teils 15 cm | CC BY 4.0, Nennung „PNOA cedido por © IGN“ | nutzbar |
| Frankreich | BD ORTHO HR (IGN), 20 cm | Licence Ouverte 2.0 | Primärtext prüfen |
| Kroatien | DGU DOF (WMS/WMTS) | offene Lizenz, CC-BY-ähnlich | Auflösung prüfen |
| Slowenien | GURS | offen | prüfen |
| Italien | regional (z. B. Apulien 15 cm, Bozen 20 cm) | je Region | je Region prüfen |
| **Griechenland** | Hellenic Cadastre, 50 cm (Ortslagen 20 cm), Aufnahmen ca. 2007–2009, offener WMS mit Wasserzeichen | CC BY 3.0 laut geodata.gov.gr (2015) | **Anfrage gestellt** (Lizenz, Daten ohne Wasserzeichen, 25-cm-Befliegung); bis zur Antwort nur für Tests |
| Türkei, Malta, Zypern, Albanien, Montenegro, Nordafrika, Levante, übriges Italien | Vantor (WorldView/Legion) 30 cm über UP42, Mindestfläche 1 km² | kommerziell mit **Display & Media**-Lizenz | Angebot einholen, erst Pilot-Revier |
| Hintergrund überall | Sentinel-2 cloudless 2016 (EOX) bzw. eigene Sentinel-2-Szenen (Copernicus Data Space) | CC BY 4.0 bzw. Copernicus-Lizenz | nutzbar; neuere EOX-Jahrgänge sind CC BY-NC-SA und scheiden aus |

**Gelände:** Copernicus DEM GLO-30 (frei, Quellenvermerk Pflicht). Wo vorhanden, feinere offene Modelle (Spanien MDT, Frankreich RGE ALTI); Lizenz je Land prüfen.

**Ausgeschlossen:** Google, Apple, Bing/Azure, Esri, Mapbox, MapTiler-Satellit – deren Bedingungen verbieten Speichern, abgeleitete Inhalte oder KI-Eingabe.

**Bestand nur je Ort:** Gekauft oder geladen wird ein Fenster von 1,5 × 1,5 km um jeden Ort, sobald der Ort für ein Paket feststeht – kein Vorabkauf ganzer Küsten. Abgelegt in S3 unter `imagery/<source>/<tile>`, mit Quelle, Lizenz, Aufnahmedatum und Auflösung in `imagery_tiles`.

### Kosten (Schätzung, Stand 20.10.2026)

Rund 15.000 Orte im Mittelmeer (~12.000 Ankerbuchten, ~2.800 Häfen und Marinas; geschätzt, OSM-Zählung steht aus), ~20.000 km² Fenster, davon ~14.000 km² ohne offene Daten. Listenpreise Vantor 30 cm ~17,5–25,5 $/km² zzgl. Aufpreis für Display & Media (unbekannt) → grob 300.000–600.000 $, bzw. 150.000–300.000 $, falls Griechenland offen ist. KI-Bild ~0,10–0,30 $ je Bild. Gekauft wird revierweise mit dem Ausbau, beginnend mit einem Pilot-Revier.

## Teil B: Rendering

- **Kamera:** Neigung 30°, Bildwinkel 50°, Bildformat 3:2 (1536 × 1024). Kamera **über dem Wasser**, Blick auf den Ort. Blickziel ist der Spot-Punkt (bei Buchten der Strand bzw. Buchtscheitel, bei Häfen das Hafenbecken). Die Blickrichtung ist die Gegenrichtung zur Mitte des offenen Sektors aus der Schutzberechnung (Teil-Spec 04); liegt der Kamerapunkt dann über Land, wird der Azimut in 10°-Schritten gedreht, bis er über Wasser liegt.
- **Zoomstufe:** Standard z1 = 260 m Höhe, 450 m Abstand. Nähere Stufen (z2 = 160 m, z3 = 100 m) nur, wenn das Luftbild fein genug ist: ein Luftbild-Pixel darf im Bildvordergrund höchstens `render.maxSourcePixelOnScreen` (Start 5) Bildpunkte groß werden. Bei 0,5 m reicht das bis z3, bei 25 cm eine Stufe näher.
- **Aufbau:** zwei Geländenetze – weit (±0,06° um den Ort, 15-m-Raster, Sentinel-2) und Kern (Fenster des Luftbilds, 4-m-Raster interpoliert, Orthofoto). Das grobe Netz wird unter dem Kern abgesenkt, damit es nicht durchstößt. Weiße Randflächen ohne Daten (an den Rand angrenzende weiße Bereiche) werden mit Sentinel-2 gefüllt.
- **Ausgaben je Ansicht:** Rendering (`photo`), exakte Land-Wasser-Maske (`mask`, Wasser = Geländehöhe ≤ 0), optional Tiefenkarte.
- **Umsetzung:** im Worker als headless Chromium (vorhanden wegen Playwright) mit einer kleinen three.js-Szene in TypeScript, damit kein zweiter Sprach-Stack entsteht. Die Tests liefen mit PyVista; das Verfahren ist dasselbe. Kameraregeln und Szenenaufbau in `lib/domain/images/render-plan.ts`, Ausführung in `lib/pipeline/images/render.ts`.

## Teil C: Bildmodell

- **Modell:** GPT Image 2.5 Sunburst über `v1/images/edits`, Größe 1536 × 1024, Qualität `high`; Adapter `lib/adapters/openai-image.ts`, Modell und Parameter in `config/models.json`, Aufgabe `generate-place-image`. Tests über einen Mock-Bildadapter, nie über das Netz.
- **Prompt** (`config/prompts/generate-place-image/v1.md`), aus Blöcken zusammengesetzt:

| Block | Inhalt |
| --- | --- |
| Szene | „3D terrain render of a real Greek place – {Beschreibung}“; Beschreibung je Ortsart aus dem Profil (Bucht mit Strand, Marina mit Becken und Stegen, Hafenstadt mit Promenade) |
| Preserve exactly | Kamera, 30°, Bildwinkel, Ausschnitt; Bildränder zeigen denselben Inhalt (nicht herauszoomen, kein zusätzlicher Himmel); Form und Lage von Küste, Molen, Stegen, Straßen, Gebäuden, Hügeln; welche Flächen Wald, offener Boden, Bebauung, Strand, Wasser sind; vorhandene kleine Bauten behalten |
| Boote | **Ankerbucht:** alle Boote und Menschen entfernen. **Marina, Hafen, Ort bei Stadt:** Boote dort behalten, wo das Rendering sie zeigt, gleiche Lage, Größe und Dichte; keine Boote, wo es keine zeigt |
| Do not add | keine neuen Gebäude, Stege, Wellenbrecher, Straßen, Inseln, Felsen |
| Artefakte | Rendering ist niedrig aufgelöst, verpixelt und trägt ggf. ein halbtransparentes Band mit Logo: nur für Anordnung, Formen und Farben nutzen, keine Blöcke, Raster oder Schlieren übernehmen, Band und Logo entfernen |
| Regenerate | alle Oberflächen als echtes Foto neu zeichnen (Bäume, Fels, Kies, Häuser mit Dächern, Bootsrümpfe, klares Wasser mit Grund und Seegras); Farben lebendig, aber naturgetreu, Polfilter-Look, keine Übersättigung, keine HDR-Säume |
| Light | siehe unten |

- **Lichtstimmung je Ortsart** (Liste in `config/images.json`):

| Ortsart | Licht |
| --- | --- |
| Ankerbucht, Bojenfeld | **Mittag:** später Vormittag im Hochsommer, Sonne hoch und leicht hinter der Kamera, knappe klare Schatten, leuchtendes Türkis über Sand, tiefes Saphirblau mit feinem Glitzern |
| Marina, Hafen, **Ankerplatz bei einer Stadt** | **Später Abend:** etwa 20 Minuten nach Sonnenuntergang, Himmel von Orange-Rosa bis Tiefblau, weiches Licht ohne harte Schatten, warme Fenster, Straßen- und Steglichter mit Spiegelungen im ruhigen Wasser, ein paar Spaziergänger auf Promenaden |

  „Bei einer Stadt“: innerhalb von `light.townRadiusM` (Start 1.000 m) liegt ein Geo-Objekt `settlement` oder ein OSM-Ort `place=town|village` mit Bebauung im Bildausschnitt. Die Regel macht Code, nicht das Modell.

## Teil D: Prüfung und Freigabe

1. **Geometrie:** Überlappung der Wasserfläche zwischen Maske und KI-Bild (IoU) unterhalb des gerenderten Horizonts. Startschwellen: Mittag ≥ `check.minWaterIoU.midday` (0,80), Abend ≥ `check.minWaterIoU.evening` (0,60, weil die Farberkennung dunkles Wasser schlechter trifft). Darunter: einmal neu erzeugen, dann Review. Der Farbdetektor ist eine Notlösung; ersetzt wird er durch einen Kantenvergleich der projizierten Küstenlinie (offener Punkt).
2. **Wasserzeichen-Reste:** einfache Bildprüfung auf Schriftzug und Logo; Treffer → neu erzeugen.
3. **Menschliche Freigabe:** Review-Aufgabe `place_image` zeigt Rendering, KI-Bild, Maske, IoU und Licht; Knöpfe „Freigeben“, „Neu erzeugen“, „Kein Bild“. Ohne Freigabe wird kein Bild geliefert.
4. **Kennzeichnung:** `kind = ai_illustration`, Alt-Text beginnt mit „KI-Illustration:“; Abnehmer müssen das sichtbar machen (Vertragsregel).
5. **Neu erzeugen** nur bei neuem Luftbild, neuer Prompt- oder Modellversion oder geänderter Ortsart – nicht je Lauf.

## Teil E: Fotos und Aussehens-Merkmale (zweite Stufe)

Unabhängig vom Titelbild bleibt der Weg aus der ersten Fassung dieser Spec erhalten, aber als zweite Stufe nach dem Rendering:

- **Bildkandidaten** aus Törnberichten im Archiv (Bildverweise sind schon im Markdown; neu: Turndown-Regel für `data-src`/`srcset`, Teaser-Links verwerfen), Commons-Geosuche und Google-Bildersuche über DataForSEO; Ausschlüsse: robots.txt- und KI-Vorbehalte, TDMRep, Plattformen mit Extraktionsverbot oder Datenbankschutz (Navily, Tripadvisor, soziale Netzwerke, Stockfoto-Anbieter).
- **Prüfung** durch ein Vision-Modell (echtes Foto, zeigt den Ort, Übersicht/Detail, Blickrichtung); geschützte Fotos werden nach der Prüfung gelöscht (§ 44b Abs. 2 UrhG), Beleg bleiben URL, Hash und Bildregion.
- **Aussehens-Merkmale** als Facts mit neuer Herkunft `image` (z. B. `shore_material`, `beach_surface`, `buildings_shore`, `landing`, `landmark`, `water_colour`); ins Profil nur bei Beleg auf mindestens zwei Fotos verschiedener Quellen (Regel `image_min_two`). Sie speisen `summary.de` und die Szenenbeschreibung im Prompt.
- **Titelbild-Rang:** eigenes Foto > freies Foto (CC0, CC BY; CC BY-SA nur nach Freischaltung) > gerenderte KI-Illustration > kein Bild.

Geschützte Fotos gehen **nicht** ins Bildmodell. Der in der ersten Fassung vorgesehene Weg „KI-Illustration aus geschützten Luftaufnahmen“ entfällt.

## Liefervertrag (Teil-Spec 08)

Optionales Feld `images` an `spot` und `highlight` (Minor-Version): eine Liste in Lieferreihenfolge, das erste Bild ist das Titelbild. Ein Spot kann mehrere Bilder haben (Titelbild und weitere Ansichten; Entscheidung Christian, 20.10.2026). Jedes Bild nennt, von wo es aufgenommen ist.

```json
"images": [{
  "kind": "photo | ai_illustration",
  "file": "images/sp_8f3k2-title.jpg",
  "width": 1536, "height": 1024,
  "alt": { "de": "KI-Illustration: Bucht mit Kiesstrand und Pinienwald, Blick vom Wasser" },
  "light": "midday | evening | null",
  "observedAt": "2009-06-01",
  "license": "CC-BY-4.0 | periplus | …",
  "attribution": "Luftbild © Hellenic Cadastre (CC BY 3.0) · Gelände © DLR/Airbus, Copernicus · Illustration: Periplus",
  "sourceUrl": null,
  "camera": { "position": [23.4447, 37.5081], "heightM": 260, "viewBearingDeg": 112, "tiltDeg": 18, "fovDeg": 50 }
}]
```

- `camera` gibt Standort (Länge, Breite), Höhe über dem Meer in Metern, Blickrichtung (Grad, im Uhrzeigersinn ab Nord), Neigung und vertikalen Bildwinkel an; bei einer KI-Illustration immer gesetzt, bei Fotos ohne bekannte Kamera `null`.

- `observedAt` ist bei `ai_illustration` das Aufnahmedatum des Luftbilds.
- `attribution` nennt immer Luftbild- und Geländequelle; bei kommerziellen Luftbildern den vom Anbieter verlangten Vermerk.
- Bilddateien unter `deliveries/<area>/<dataVersion>/images/`, Hash in `file_hashes`. Die 15-Wörter-Regel gilt für `alt`.

## Rechtliches

| Vorgang | Rahmen | Bedingung |
| --- | --- | --- |
| Offene Orthofotos speichern, rendern, mit KI bearbeiten, anzeigen | CC BY / Licence Ouverte / offene Lizenzen | Namensnennung im Vertrag und in der App |
| Griechisches Kataster | CC BY 3.0 (Katalog 2015) | **bis zur schriftlichen Bestätigung nur Tests**; Entfernen des Wasserzeichens durch die KI ist bei offener Nennung geringes Risiko (§ 95c UrhG), Daten ohne Wasserzeichen sind angefragt |
| Kommerzielle Luftbilder (Vantor, Airbus) | Standardlizenz nur intern | Display & Media bzw. Background-Layer-Lizenz nötig; Verarbeitung durch einen fremden KI-Dienst vorab freigeben lassen |
| Bildmodell (OpenAI) | API-Bedingungen | Bezahlstufe ohne Training mit Kundendaten |
| Fotos aus dem Netz (Teil E) | § 44b UrhG | nur Analyse, Opt-out beachten, löschen nach Prüfung |

## Datenmodell

- `imagery_tiles` (stabil mit Gültigkeit): `source` (`pnoa`, `ign_fr`, `dgu_hr`, `ktimatologio`, `vantor`, `sentinel2`, …), `bbox`, `resolution_m`, `acquired_at`, `license`, `attribution`, `file_key`, `watermarked bool`, `cost_eur`.
- `place_renders` (nur anfügend): `geo_object_id`, `camera` jsonb (Ziel, Azimut, Höhe, Neigung, Bildwinkel), `zoom`, `imagery_tile_ids`, `dem_source`, `photo_key`, `mask_key`, `depth_key`, `renderer_version`.
- `place_images` (versioniert mit `valid_from`/`valid_to`): `geo_object_id`, `slot` (`title`, `view-2`, …; je Ort und Slot ein aktuelles Bild), `sort_order`, Kameradaten (`camera_position`, `camera_height_m`, `view_bearing_deg`, `camera_tilt_deg`, `camera_fov_deg`), `kind` (`photo` | `ai_illustration`), `rank`, `render_id`, `light`, `model`, `prompt_version`, `water_iou`, `file_key`, `alt`, `attribution`, `license`, `observed_at`, `review_decision_id`.
- `review_kind` um `place_image` erweitern.
- Teil E: `image_candidates`, `image_assessments`, `image_observations`, Spalte `facts.image_observation_id` (wie in der ersten Fassung).

## Konfiguration

`config/images.json`: Luftbildquellen je Land mit Lizenz und Status, Kameraparameter (Neigung, Bildwinkel, Höhen je Zoomstufe), `render.maxSourcePixelOnScreen`, Lichtregeln je Ortsart und `light.townRadiusM`, Prüfschwellen, Ausschlusslisten für Teil E, und die Obergrenze der Bilderzeugungen je Lauf (`pipeline.maxGenerationsPerRun`; sie liegt in `images.json`, nicht in `budgets.json`). Budgets in `config/budgets.json` nur für Geld (Luftbildkauf je Landesteil). Prompts unter `config/prompts/generate-place-image/` (Blöcke als Abschnitte einer Datei).

## Pipeline

Neue Stufe `images` nach der Konsolidierung, je Ort, der für ein Paket feststeht:

1. Luftbild-Fenster sicherstellen (offene Quelle laden bzw. kommerziell bestellen, Budget prüfen).
2. Render-Plan (Kamera, Zoom, Licht) berechnen und rendern.
3. Bild erzeugen, prüfen (Teil D), Review-Aufgabe anlegen.
4. Nach Freigabe in `place_images` übernehmen; das nächste Paket liefert es aus.

Fachlogik in `lib/domain/images/`, Ablauf in `lib/pipeline/images/`, Adapter in `lib/adapters/` (Orthofoto-Dienste je Land, UP42, OpenAI-Bild).

## UI-Anteil (Teil-Spec 09)

- Ortsseite: Titelbild mit Art, Licht und Quellen; Rendering und Maske aufklappbar.
- Review `place_image` wie in Teil D.
- Seite des Landesteils (`/subdivisions/<Schlüssel>`): Abdeckung (Orte, mit Luftbild, mit freigegebenem Bild, lieferbar, Median der Wasser-IoU, Anteil abgelehnt, Kosten der Luftbilder und der Bilderzeugung) und die Schaltfläche „Titelbilder erzeugen“.
- Ortsseite, Reiter „Titelbild“: alle aktuellen Bilder mit Kamera, der Entwurf aus der offenen Prüfung, „Weitere Ansicht erzeugen“ und „Bild entfernen“.

## Kennzahlen (je Landesteil)

| Kennzahl | Ziel Pilot |
| --- | --- |
| Anteil Spots mit freigegebenem Titelbild (Stufe 1: griechisches Pilot-Revier) | ≥ 80 % |
| In der Review verworfene Bilder | < 20 % |
| Median Wasser-IoU (Mittag) | ≥ 0,85 |
| Kosten je Spot (Luftbild + Erzeugung) | offen: < 1 €; kommerziell: wird gemessen |

## Tests

- Render-Plan: Azimut aus offenem Sektor, Drehung bis über Wasser, Zoomgrenze aus Auflösung – Unit-Tests.
- Lichtregel: Ankerbucht → Mittag; Marina → Abend; Ankerbucht mit Ort im Radius → Abend.
- Prompt-Zusammenbau je Ortsart (Boote entfernen bzw. behalten) als Snapshot.
- Rendering gegen ein kleines Fixture-Gelände mit Fixture-Textur: Maske deterministisch.
- Pipeline mit Mock-Bildadapter: IoU unter Schwelle → neu erzeugen, dann Review; Freigabe → `place_images`.
- Vertrag: `image` validiert; `attribution` enthält Luftbild- und Geländequelle.

## Aufwand (grob)

| Teil | Aufwand | Stufe |
| --- | --- | --- |
| A: Kataster-WMS-Adapter, Sentinel-2, Copernicus DEM, `imagery_tiles` | 1–2 Tage | 1 |
| B: Render-Plan, three.js-Renderer im Worker, Masken | 3 Tage | 1 |
| C: OpenAI-Bildadapter, Prompt-Blöcke, Lichtregel | 1–2 Tage | 1 |
| D: Prüfung, Review `place_image`, Vertrag, Liefer-Schalter | 2 Tage | 1 |
| Adapter offene Orthofotos je weiteres Land | je 0,5–1 Tag | 2 |
| UP42/Vantor-Anbindung (nach Angebot) | 1–2 Tage | 3 |
| E: Fotos und Merkmale | 6–7 Tage | später |

Stufe 1 gesamt: grob 7–9 Tage.

## Hinweis nach Teil-Spec 14

Nach Teil-Spec 14 liegt die Liefereinheit im Landesteil (Land, Verwaltungseinheit), nicht im Revier. Wo diese Spec „Revier“ sagt, in den Budgets, der Abdeckung, den Kennzahlen und beim Pilot, ist der **Landesteil** gemeint; Reviere sind überlappende Namensgebiete außerhalb der Hierarchie. Der Laufumfang `subdivision` der Bildstufe und die Abdeckung der Landesteil-Seite folgen dem. Die Obergrenze der Bilderzeugungen je Lauf steht in `config/images.json` (`pipeline.maxGenerationsPerRun`), nicht in `config/budgets.json`.

## Abweichungen

- **Nach außen nur abgeleitete Fakten** (Gesamtdesign Abschnitt 9): Das Titelbild ist ein aus Luftbildern abgeleitetes Bild, keine Faktenangabe. Zulässig, weil die Luftbilder unter offenen oder dafür erworbenen Lizenzen stehen. Mit Umsetzung in Abschnitt 4 des Gesamtdesigns eintragen.
- **Kein Fact ohne wörtliches Zitat** (Gesamtdesign Abschnitt 3): betrifft nur Teil E (Herkunft `image` mit Bildregion als Beleg).

## Offene Punkte

- Antwort des Hellenic Cadastre (Lizenz, Daten ohne Wasserzeichen, 25-cm-Befliegung, Aufnahmedaten); davon hängt rund ein Drittel der Kosten ab.
- Angebot Vantor/UP42 (und Airbus) für ein Pilot-Revier: Preis 30 cm und 50 cm, Aufpreis Display & Media, Freigabe der Verarbeitung durch einen fremden KI-Dienst, native App gedeckt?
- OSM-Zählung der Orte je Land (Overpass war am 20.10. nicht erreichbar).
- Geometrieprüfung über Küstenkanten statt Wasserfarbe.
- Pixelmuster im Wasser bei nahen Zoomstufen: zusätzlich nur die Wasserfläche im Rendering weichzeichnen (Maske vorhanden)?
- Wasserfarbe: Das Modell macht trübe Hafenbecken karibisch; Prompt-Zusatz „Wasserfarbe wie im Rendering, nur klarer“ testen.
- Stabilität: Streuung bei mehrfacher Erzeugung desselben Orts messen.
