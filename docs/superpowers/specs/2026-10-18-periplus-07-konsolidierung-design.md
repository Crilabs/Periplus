# Periplus 07 – Konsolidierung, Profile und Änderungserkennung (Stufe 8)

Stand: 18.10.2026 · Gehört zu: `2026-10-18-periplus-design.md` · Meilensteine: M5, wöchentlicher Lauf in M8 · Quell-Spec: Verarbeitungsstufe 8; „Zeitachse und Wiederholung“; „Änderungserkennung und Versionierung“ Ebenen 2 und 3; „Review und Freigabe“ (Konflikt)

## Zweck

Aus allen Facts, Berechnungen, Beobachtungen und Review-Entscheidungen eines Geo-Objekts ein versioniertes Profil bilden, mit einer prüfbaren Regel je Attribut, und jede Änderung gegenüber dem gültigen Profil als typisiertes Ereignis festhalten.

## Ablauf (`consolidation.geo` je Geo-Objekt)

1. **Eingänge laden:** alle Facts des Geo-Objekts aus dem aktiven Extraktionslauf je Dokumentversion (Teil-Spec 06), aus aktuellen Computations, Beobachtungen und Review-Facts. Facts aus Dokumenten mit `status = gone` zählen mit ihrem `observed_at` weiter, gelten aber ab dem Verschwinden nicht mehr als „aktuell bestätigt“.
2. **Regel je Attribut** anwenden (Tabelle unten). Jede Regel ist eine reine Funktion `(facts, context) → { value, confidence, origin, observedAt, factIds, conflict? }` in `lib/domain/consolidation/rules/`, Parameter in `config/consolidation.json`, Version als `rules_version`.
3. **Abgeleitete Werte** für den Liefervertrag: `popularity`, `quietness`, `importance` (POI), Belegung, Saisonhinweise, `summary` (siehe unten).
4. **Lückenliste:** Attribute des Schemas ohne Wert.
5. **Vergleich mit dem gültigen Profil**, Änderungsereignisse bilden (siehe unten).
6. **Neue Profilversion** nur, wenn sich Werte oder Konfidenzklassen geändert haben; `valid_from` = Datum des Laufs.
7. **Folgeaufträge:** Ort mit < 2 Dokumenten → gezielte Quellenfindung für diesen Ort (`discovery.place`, Kachel-Templates mit seinem Namen; Budget-gebunden). Konflikt ohne Zeitverlauf → Review-Aufgabe `conflict`.

## Regeln je Attribut (aus der Quell-Spec, präzisiert)

| Attribut | Regel |
| --- | --- |
| `shelter.<Sektor>` | Basis = berechneter Wert. Text-Facts korrigieren um höchstens eine Stufe (±0,3); widersprechen sich Texte, gilt der schlechtere Wert. Häfen/Marinas: Untergrenze 0,8, außer ein Text (Konfidenz ≥ 0,7) belegt eine offene Seite. |
| `swell_protection` | Text vor Berechnung, wenn ein Text-Fact ≥ 0,7 existiert; sonst berechnet. |
| `depth.*`, `seabed` | Bathymetrie; Text nur als Korrektur bei Konfidenz > 0,8. Bei Rasterkonfidenz < 0,4 und vorhandenem Text-Fact gilt der Text. |
| `holding` | Nur Text; Mehrheit gewichtet nach Quellengewicht × Konfidenz × Aktualität. |
| `services.*`, `mooring.buoys`, `highlight.*` (Vorhandensein) | Jüngste Beobachtung gewinnt; bei gleichem Monat die stärkere Quelle. Zeitverlauf (2019 ja, 2024 nein) = Änderung, kein Konflikt. |
| `occupancy` | Verteilung je Monat aus allen Facts und Beobachtungen; Monat ohne Daten `unknown`. |
| `highlight.*` (Liste) | Vereinigung, sortiert nach Zahl unabhängiger Nennungen. |
| `prohibitions` | Jede Nennung gilt, bis eine jüngere Quelle vom Typ `authority` sie aufhebt. |
| Revier-Facts (`meltemi_exposure` …) | Gewichteter Mittelwert (numerisch) bzw. Mehrheit (Enum). |
| Alle anderen | Standardregel: jüngste Beobachtung mit Konfidenz ≥ 0,5, sonst gewichtete Mehrheit. |

**Aktualität:** Gewicht `0,5 ^ (Alter in Jahren / 3)` (Halbwertszeit 3 Jahre, Parameter). **Unabhängigkeit:** mehrere Dokumente derselben Quelle zählen als eine Nennung; derselbe Text in zwei Versionen zählt einmal (übernommene Chunks).

**Konflikt:** zwei Werte, die sich nicht über die Zeit ordnen lassen (Beobachtungsdaten im selben Saisonjahr oder unbekannt) und deren Gewichtssummen sich um weniger als Faktor 1,5 unterscheiden. Das Profil zeigt den höher gewichteten Wert mit `conflict`-Vermerk (beide Werte, Daten, Quellen). Entscheidet ein Admin (Wert A, Wert B, beide = saisonal, offen lassen), entsteht ein Review-Fact, der künftig mit Konfidenz 0,95 eingeht.

**Konfidenz je Attribut:** aus Regel-Ergebnis: Herkunft (`computed` Basiswert aus Teil-Spec 04, `text` aus Fact-Konfidenz × Quellengewicht, bestätigt durch zweite unabhängige Quelle +0,15, gedeckelt bei 0,95), abgewertet mit Aktualität. Konfidenz des Profils (`score.confidence` im Vertrag) = gewichteter Mittelwert über die Kernattribute (Schutz, Tiefe, Grund, Ausschluss).

## Abgeleitete Werte

- **`popularity`** (0–1): Zahl unabhängiger Quellen mit Erwähnung, logarithmisch normiert innerhalb des Reviers (Maximum des Reviers = 1).
- **`quietness`** (0–1): aus Abstand zu Siedlung und Straße (Computation), Belegung im Juli/August, Text-Facts zu Ruhe/Lärm/Partybooten, Fähr- und Ausflugsbootverkehr; Formel in `config/consolidation.json`.
- **`importance`** eines POI (1–5): aus Zahl und Gewicht der Quellen, Wikidata-Sitelinks und Kategorie; Schwellen in Konfiguration. Bedeutungsradius 5/10/20/35/50 sm wie Liefervertrag; `spotIds` = bestätigte Orte im Radius, nach Distanz.
- **Saisonhinweise:** aus `observed_at`-Monaten und Text-Facts mit Monatsangaben.
- **`summary.de`:** zwei bis vier Sätze, erzeugt von einem Modell (Sonnet-Klasse) ausschließlich aus dem konsolidierten Profil (Werte, keine Zitate). Wird nur neu erzeugt, wenn sich das Profil geändert hat. Die 15-Wörter-Prüfung gegen das Archiv (Teil-Spec 08) läuft auf jeder Summary; ein Treffer verwirft sie und erzeugt sie mit Hinweis neu (max. 2×, sonst leer und Review).

## Änderungserkennung (Profilebene)

Vergleich neues gegen gültiges Profil je Attribut:

| Ereignis | Bedingung |
| --- | --- |
| `new_attribute` | vorher kein Wert |
| `changed` | anderer Wert, gestützt durch ≥ 2 unabhängige Beobachtungen oder eine Quelle mit Gewicht > 0,8 |
| `uncertain` | anderer Wert aus einer einzelnen schwachen Quelle; Profil behält den alten Wert, Review-Aufgabe `uncertain_change` |
| `expired` | letzte Beobachtung älter als zwei Zyklen der Kachel; Wert bleibt, Konfidenz sinkt um eine Klasse, Vermerk |
| `place_new`, `place_abandoned` | Statuswechsel des Orts |
| `geo_changed` | Name, Geometrie oder Eltern eines Geo-Objekts geändert (aus Gazetteer-Lauf) |

`severity`: `safety`, wenn `exclude`, ein Schutzsektor um > 0,2, `limits` (Tiefgang, Länge) oder `hazards` betroffen sind; `notable` bei Services, Highlights, Belegung; sonst `info`. Das Ereignis trägt alten und neuen Wert und die Profilversion; `seq` ist der Cursor des Change-Feeds.

## Zeitliche Einordnung

`valid_from` eines Profils ist das Laufdatum, nicht das Beobachtungsdatum; die Frage „Wie sah die Bucht im Juni 2025 aus?“ beantwortet `profile_as_of` aus Sicht des damaligen Wissensstands. Zusätzlich liefert `GET …/profile?observedAsOf=` (M8) eine Rekonstruktion nur aus Facts mit `observed_at ≤ Datum` (gleiche Regeln, nicht gespeichert). (Entscheidung Claude: beide Lesarten sind sinnvoll; die erste ist versioniert, die zweite berechnet.)

## Takt

Im Pilot nach jedem Lauf von Stufe 7 für alle betroffenen Geo-Objekte; ab M8 wöchentlich für alle Geo-Objekte mit neuen Facts sowie ereignisgesteuert.

## UI-Anteil

Ort-Detail: Profil mit Wert, Konfidenz, Herkunft je Attribut, Klick zeigt die zugrunde liegenden Facts und die angewandte Regel; Konfliktmarker; Zeitregler (Profilversionen) mit Diff; Liste der Änderungsereignisse. Review `conflict` und `uncertain_change`.

## Tests und Abnahme

- Jede Regel als Tabellentest mit konstruierten Facts (inkl. Zeitverlauf, Quellengewicht, Unabhängigkeit, Konflikt).
- Eigenschaftstest: Konsolidierung derselben Eingänge ist deterministisch und erzeugt keine neue Version.
- Szenario: Taverne 2019 ja, 2024 nein → `changed`, kein Konflikt; zwei gleichzeitige widersprüchliche Tiefen-Facts mit Konfidenz 0,6 → Bathymetrie gilt, kein Ereignis.
- Abnahme M5: jedes bestätigte Pilot-Geo-Objekt hat ein Profil; Lückenliste und Herkunft je Attribut in der UI; Profil zum Datum abrufbar.
