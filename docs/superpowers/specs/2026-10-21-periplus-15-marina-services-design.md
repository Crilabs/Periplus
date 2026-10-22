# Periplus 15 – Marina-Services: Diesel und Wasser von der Marina-Website, schlankere Highlights

Stand: 21.10.2026 · Gehört zu: `2026-10-18-periplus-design.md` · Ändert: Teil-Spec 03 (Gazetteer: Website-Adresse, Kategorien-Zuordnung), 05 (Quellen: Marina-Website als eigene Herkunft), 06 (Erwähnungen und Extraktion: Bindung an den Ort), 02/07 (Fact-Schema: Bedeutung von `services.fuel` und `services.water`), 08 (Bedeutung von `services.shop`)

## Zweck

Die App eines Abnehmers plant später Törns mit den Daten. Für die Routenplanung zählen an einer Marina zwei Services: **Diesel tanken** und **Frischwasser bunkern** (Christian). Beides gibt es schon als Facts (`services.fuel`, `services.water`, Fact-Schema v2), aber mit unscharfer Bedeutung („Whether fuel is available“) und ohne gezielte Quelle. Die beste Quelle ist die Website der Marina selbst; sie wird heute nur zufällig gefunden.

Gleichzeitig enthalten die Highlights Dinge, die keine Törnplanung braucht (Apotheke, Geldautomat, Tankstelle an der Straße, Tauchshop). Über `highlight.supply` färben sie sogar den gelieferten Service `shop` falsch: Eine Straßentankstelle in 2 km macht heute „Einkaufen möglich“.

## Entscheidungen

- Es zählt nur, was **die Marina selbst** anbietet: Tankservice an der Marina (Tankstelle am Steg oder Tankwagen an die Pier) und Wasser am Liegeplatz. Eine Tankstelle im Ort oder ein Trinkwasserbrunnen im Dorf zählt nicht, auch nicht als eigener Fall „Kanister in 300 m“ (Christian).
- Weitere Marina-Services (Werkstatt, Kran, …) werden nicht neu aufgenommen; sie ändern keine Route (Christian, im Gespräch auf Diesel und Wasser eingegrenzt).
- Periplus ruft für jede Marina **gezielt ihre eigene Website** ab und liest sie aus (Christian).
- Eine Website, die OSM oder Wikidata direkt am Ort nennt, wird **automatisch freigegeben**, ohne Prüfaufgabe (Christian).
- Fehlt ein Service auf der Website, entsteht daraus kein „nein“; der Wert wird über Törnberichte und andere Quellen bestätigt oder widerlegt (Christian). Folgt ohnehin aus „Kein Fact ohne wörtliches Zitat“: Ein Fehlen lässt sich nicht zitieren.
- Highlights: OSM `amenity=fuel|pharmacy|atm|drinking_water` und `shop=scuba_diving` fallen weg (Christian). `supply` heißt künftig „Einkaufen für die Bordküche“: `shop=supermarket` und `shop=convenience` (Minimarkt; in vielen Inselhäfen der einzige Laden). `bakery` und `butcher` fallen weg (Claude, Christian hat dem Vorschlag nicht widersprochen).

## Teil A: Kategorien aufräumen

### Konfiguration

`config/categories.json` danach:

| Kategorie | OSM |
| --- | --- |
| `food` | `amenity=restaurant|cafe|bar|pub|fast_food` (unverändert) |
| `supply` | `shop=supermarket|convenience` |
| `beach` | unverändert |
| `nature` | unverändert |
| `active` | `tourism=viewpoint` |
| `culture`, `town` | unverändert |

Die Wikidata-Zuordnungen bleiben. Die Kategorien selbst (Vertrag `highlightCategory`, DB-Enum `poi_category`) bleiben unverändert; es ändert sich nur, welche OSM-Objekte hineinfallen. Kein neuer Vertrag.

### Bestand bereinigen

Ein Re-Import fasst Objekte, die keine Regel mehr trifft, nicht an (`upsertGeoObject` kennt nur importierte Elemente; `geo_objects` erlaubt kein DELETE). Ohne Bereinigung blieben die schon importierten Tankstellen, Apotheken usw. für immer `supply`/`active`, mit Highlight und `public_id`.

- Eine Migration bzw. ein einmaliger Job nimmt allen POIs, deren Tags **keine** Regel der neuen `categories.json` mehr treffen, die Kategorie (Kategorie `null`). Damit fallen sie aus `poiInputs` (Konsolidierung) und aus der Highlight-Lieferung. Ein POI, der zusätzlich eine andere Regel trifft, bekommt deren Kategorie.
- Die Prüfung läuft über die gespeicherten Tags, gegen dieselbe Klassifizierung wie der Import (`classifyOsm`), nicht über eine zweite, handgeschriebene Liste.
- Im Liefer-Diff erscheinen die entfernten Highlights als gelöscht; das ist gewollt. Die Profile der betroffenen Orte werden neu konsolidiert, damit `highlight.supply` und `services.shop` den neuen Stand zeigen.
- Wie das „Entfernen“ technisch aussieht (Kategorie null vs. `valid_to`), entscheidet der Plan nach dem, was die Lieferung (`lib/domain/delivery/load.ts`) und der Diff schon können; Ziel ist, dass der Abnehmer die Highlights als gelöscht sieht.

### Bedeutung von `services.shop`

`services.shop` wird weiter aus `highlight.supply` abgeleitet (`lib/domain/delivery/map-spot.ts`) und heißt danach: Supermarkt oder Minimarkt im Umkreis (`poiRadiusM`, heute 2000 m) oder laut Text. Die Vertragsbeschreibung von `shop` wird entsprechend geschärft (Doku, kein Schemawechsel).

## Teil B: Bedeutung von Diesel und Wasser schärfen

Die Attribute bleiben `services.fuel` und `services.water` (Boolean, Regel `latest_observation`). Neu ist ihre Beschreibung im Fact-Schema, die im Extraktions-Prompt landet:

- `services.fuel`: „Whether the place itself offers refuelling (diesel) for boats: a fuel dock or a tanker truck at the quay. A petrol station in town does not count.“
- `services.water`: „Whether fresh water can be taken on at the berth or quay of the place (tap, hose, water connection). A fountain or tap in the village does not count.“

Ein Zitat, das nur eine Tankstelle im Ort oder einen Dorfbrunnen nennt, ergibt keinen Fact. Ein Zitat „no fuel here, nearest at X“ ergibt `false`.

### Versionierung

Fact-Schema-Versionen werden nicht in place geändert (Konvention, einmal mit Begründung gebrochen, siehe Kopf von `config/fact-schema/v2.ts`). Die geschärfte Bedeutung kommt deshalb als **Fact-Schema v3**: v2 plus die zwei neuen Beschreibungen, sonst gleich. Folge: Mit `active.json` = v3 zählen alle bisherigen Text-Facts nicht mehr (`eligibleRunSql`), bis reprozessiert ist.

Entschieden (Christian, 22.10.2026): v3 enthält auch die Attribute aus Teil-Spec 17 (`berthable`, `place.kind_evidence`). Das Reprozessieren aller Landesteile mit v3 **gehört zu diesem Vorhaben**; Teil-Spec 15 und 17 gehen zusammen live. Reihenfolge je Landesteil: v3 aktiv, Marina-Websites abrufen (Teil C), Stufen 6 bis 8 über alle Dokumentversionen, dann Lieferung. Kosten werden je Landesteil wie bei jedem Lauf erfasst; vor dem ersten Landesteil eine Schätzung aus der Zahl der Erwähnungen auf der Läufe-Seite (Claude).

## Teil C: Marina-Website abrufen

Geändert am 22.10.2026 (Christian): Die Website ist nicht nur Quelle für Diesel und Wasser, sondern für Marinas das Mittel der Bestätigung (Teil-Spec 17). Sie wird deshalb auch für Kandidaten gesucht, notfalls über die Google-Suche, und von der KI auf drei Fragen ausgewertet: Freizeithafen mit Liegeplätzen für Gastboote? Diesel und Frischwasser? Wie meldet man sich an (Telefon, VHF-Kanal)?

### Welche Orte

Alle gültigen, nicht zusammengeführten Orte der Art `marina` und `port` mit Status `candidate` oder `confirmed` (nicht `rejected`; Christian, 22.10.: Kandidaten gehören dazu, weil die Website die Marina erst bestätigt). `port` ist dabei, weil der Seed die Ortsart nur rät (Teil-Spec 17): ein OSM-„Hafen“ kann ein Stadtkai sein, also eine Marina. Ankerplätze und Bojenfelder nicht.

### Herkunft der Adresse

1. OSM `website`, ersatzweise `contact:website`, am OSM-Objekt des Ortes.
2. Ersatzweise Wikidata P856 (offizielle Website), wenn der Ort eine Wikidata-ID hat.
3. Ersatzweise **Google-Suche** über den vorhandenen SERP-Adapter (DataForSEO, Christian): Vorlagen wie „{Name} marina“, „{Name} {Insel} marina“, „μαρίνα {Name}“ in `config/discovery.json` unter `placeWebsite.templates`; die ersten `maxResults` Treffer (Claude: 5) außerhalb der gesperrten Domains und außerhalb bekannter Quellen anderer Typen (Revierführer, Blogs) sind Website-Kandidaten. Höchstens eine Suche je Ort und Lauf; erneut erst nach `retryDays` (Claude: 180), damit ein Ort ohne Website nicht jeden Lauf Geld kostet.

1 und 2 werden heute nicht gespeichert. Der Gazetteer-Import übernimmt künftig `website` und `contact:website` (in `KEPT_TAGS`) und der Wikidata-Import P856. Für den Bestand werden die Tags aus den archivierten Overpass-Antworten im S3 (`datasets/overpass/<subdivision>/<date>.json`) nachgetragen, ohne neue Overpass-Abfrage.

Nicht verwendet: Adressen auf gesperrten Domains (Facebook, Instagram, Google, Booking usw., Ausschlussliste der Quellenfindung) und Adressen, deren Domain zu einer Quelle mit Status `rejected` gehört.

### Ist das die Website dieses Ortes? (nur Google-Suche)

Eine Adresse aus OSM oder Wikidata gehört zum Ort, die Zuordnung steht in den Daten. Ein Suchtreffer kann dagegen eine Nachbar-Marina, ein Charter-Anbieter oder ein Reiseportal sein. Deshalb ruft Periplus die Startseite jedes Treffers ab und lässt die KI entscheiden: Ist das die eigene Website **dieses** Ortes (Betreiber, Hafenamt oder Gemeinde für genau diesen Hafen)? Eingabe: Name(n) und Lage des Ortes, Ortsart-Vorschlag, Seitentext. Ausgabe: ja/nein, wörtliches Zitat, das den Ort nennt, Konfidenz.

- Ja mit Zitat und Konfidenz ≥ `minConfidence` (Claude: 0,8; in `config/`): Adresse wird übernommen, Herkunft `serp`.
- Sonst: verworfen, keine Prüfaufgabe (Claude: eine Prüfaufgabe je Fehlgriff würde die Queue füllen; ohne Website bleibt der Ort Kandidat und wird über Quellen bestätigt).
- Der erste Treffer mit Ja gewinnt; weitere werden nicht geprüft.

Prompt in `config/prompts/`, Modell in `config/models.json` (kleines Modell genügt, Claude).

### Freigabe

Eine Adresse aus OSM, Wikidata oder einer bestätigten Suche wird ohne Prüfaufgabe freigegeben (neue Herkunft `place_website` neben `serp | linkgraph | whitelist | manual`, Quellentyp `marina`). Die Admin-Oberfläche zeigt die Herkunft und erlaubt wie bei jeder Quelle Pausieren und Beenden.

Ist die Domain schon eine Quelle (etwa eine Marina-Kette mit mehreren Häfen auf einer Domain), wird keine zweite angelegt; die Start-URL kommt zur bestehenden Quelle dazu (Claude):

- `approved`: Start-URL dazu; Typ und Gewicht der Quelle bleiben (ein Typwechsel würde alle anderen Dokumente der Domain umgewichten).
- `proposed`: wird freigegeben, die offene Prüfaufgabe ist damit erledigt (die Nennung in OSM/Wikidata am Ort ist der stärkere Beleg); Typ wie vorgeschlagen.
- `paused`, `rejected`: nichts; die Adresse wird übergangen.

### Crawl

- Start-URL ist die Website-Adresse. Eine neue `place_website`-Quelle bekommt kleine Crawl-Regeln: Tiefe 2, höchstens 30 Seiten je Start-URL (bei n Start-URLs 30 × n), Werte in `config/` (Claude; Services stehen meist auf Start- oder „Facilities“-Seite). Kommt die Start-URL zu einer bestehenden Quelle, gelten deren Regeln; ein Zähler je Start-URL im Frontier ist nicht nötig.
- robots.txt, Rate-Limits und SSRF-Schutz wie bei jedem Crawl.
- Erster Abruf: eine neue Stufe im Landesteil-Aufbau nach dem Gazetteer legt die Quellen an und ruft die neuen Start-URLs ab; dazu ein Knopf „Marina-Websites abrufen“ je Landesteil unter „Läufe“. Wiederholt abgerufen werden sie wie alle freigegebenen Quellen beim Revisit. Kein neuer Zeitplaner (Claude; `changeRate` wird heute von keinem Lauf gelesen).

### Bindung an den Ort

Heute entstehen Facts nur, wenn im Text ein Name aus dem Gazetteer gefunden wird. Eine Marina-Website schreibt oft „our marina“ statt ihres Namens; die Facts gingen verloren.

Für Seiten, die über `place_website` für einen bestimmten Ort abgerufen werden, ist der Ort bekannt: Jede Version wird ohne Namenssuche diesem Ort zugeordnet und für ihn extrahiert (Extraktionseinheit Version × Ort wie heute). Namen anderer Orte auf derselben Seite werden wie bisher gefunden. Wie die Zuordnung gespeichert wird (eigene Erwähnungsart, eigene Tabelle), entscheidet der Plan; sie muss anfügend sein und im Admin an der Dokumentseite sichtbar.

Bei einer Kette mit mehreren Häfen auf einer Domain gilt die Bindung nur für die Seiten unterhalb der Start-URL des jeweiligen Ortes. Seiten, die keiner Start-URL eindeutig untergeordnet sind, laufen über die normale Namenssuche.

Schutz gegen Gemeinde- und Hafenbehörden-Websites (Claude): Nennen mehrere Orte dieselbe Start-URL (typisch: Startseite einer Gemeinde oder Behörde für mehrere Häfen), wird für keinen von ihnen gebunden; die Seiten laufen über die Namenssuche. Dasselbe gilt für Domains, die die Quellenfindung als `authority` erkennt (`typeHints`); sie werden auch nicht als Typ `marina` angelegt.

Wird ein Ort später verworfen oder zusammengeführt, folgt die Bindung der Zusammenführung (`mergedIntoId`); an einem verworfenen Ort zählt sie nicht. Die Quelle bleibt.

### Auswertung

Die gebundenen Seiten laufen durch die normale Fact-Extraktion für den Ort. Für Teil-Spec 17 und diese Spec zählen vor allem:

| Frage (Christian) | Attribut | Wirkung |
| --- | --- | --- |
| Freizeithafen, in dem Freizeitboote anlegen können? | `berthable`, `place.kind_evidence` (Teil-Spec 17) | `berthable = true` von der eigenen Website bestätigt eine Marina; „commercial port only“ stuft auf `port` um |
| Diesel, Frischwasser? | `services.fuel`, `services.water` (Teil B) | Lieferung `services` |
| Wie meldet man sich an? | `contact` (vhf, phone, url; gibt es schon) | Lieferung `spot.contact` (Teil-Spec 17) |

Unverändert: Facts mit wörtlichem Zitat, Konsolidierung mit Quellgewichten (`marina` 0.8) und `latest_observation`. Ein jüngerer Törnbericht „Tankstelle geschlossen“ schlägt eine ältere Website-Angabe. Ein fehlendes Zitat ergibt nie „nein“.

Damit eine Website eine Marina bestätigt, muss der `berthable`-Fact aus einer Seite stammen, die über `place_website` an genau diesen Ort gebunden ist (Claude: eine Marina-Kette, die auf ihrer Startseite „berths available“ schreibt, bestätigt nicht jeden ihrer Häfen).

## Liefervertrag

Keine Feldänderung. Geschärfte Beschreibungen von `services.fuel`, `services.water` und `services.shop` in der Vertragsdoku. Im Diff tauchen gelöschte Highlights (Teil A) und geänderte Services auf.

## Kennzahlen

Je Landesteil, auf der vorhandenen Qualitätsseite:

- Marinas/Häfen mit bekannter Website, davon abgerufen.
- Anteil Marinas mit Wert (ja/nein) für `services.fuel` und `services.water`, davon mit Website als Quelle.

## Tests

- Kategorien: Klassifizierung mit neuer `categories.json`; Bereinigung entzieht Tankstelle/Apotheke/ATM/Wasserhahn/Tauchshop die Kategorie, lässt Supermarkt und Minimarkt stehen, setzt bei Doppel-Tags die verbleibende Kategorie.
- `services.shop` wird nicht mehr durch eine Tankstelle im Umkreis `yes`.
- Gazetteer übernimmt `website`/`contact:website`; Wikidata P856; Nachtrag aus archivierter Overpass-Antwort.
- Freigabe: neue Quelle `place_website`, Wiederverwendung einer bestehenden Domain, gesperrte und abgelehnte Domains werden übergangen.
- Google-Suche (SERP und KI über Mocks): ohne OSM/Wikidata-Adresse wird gesucht; Treffer einer Nachbar-Marina wird von der KI abgelehnt, der eigene Treffer übernommen; ohne Treffer keine Prüfaufgabe; keine zweite Suche vor `retryDays`; Kandidaten werden gesucht, verworfene Orte nicht.
- Bestätigung: `berthable = true` von der gebundenen Website bestätigt die Marina (Teil-Spec 17); dasselbe von der Startseite einer Kette mit mehreren Häfen nicht.
- Bindung: eine Seite ohne Marina-Namen ergibt eine Extraktionseinheit für den Ort; Kette mit zwei Start-URLs bindet je Unterbaum.
- Fact-Schema v3: die geschärften Beschreibungen von `services.fuel` und `services.water` stehen im Extraktions-Prompt; v3 unterscheidet sich von v2 nur darin. Eine zusätzliche Code-Prüfung nach der Extraktion gibt es nicht; die Schärfe kommt allein aus dem Prompt.

## Nicht-Ziele

- Weitere Marina-Services (Werkstatt, Kran, Slip, Segelmacher).
- Diesel-Preise, Öffnungszeiten der Tankstelle, Unterscheidung Diesel/Benzin.
- Google Places als Website-Quelle (kein Adapter, Google-Domains gesperrt). Die Google-**Suche** über DataForSEO ist dagegen Weg 3 der Adressfindung.
- Websites von Ankerplätzen, Tavernen o. Ä.

## Offene Punkte

Keine. Der Wechsel auf Fact-Schema v3 ist entschieden (Teil B).
