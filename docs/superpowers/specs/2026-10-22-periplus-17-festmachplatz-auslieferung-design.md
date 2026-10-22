# Periplus 17 – Ortsarten, Festmachplatz und Auslieferung nach Beleg

Stand: 22.10.2026 · Gehört zu: `2026-10-18-periplus-design.md` · Hängt zusammen mit: Teil-Spec 15 (Marina-Website) · Ändert: Teil-Spec 03 (Seed: Ortsart als Vorschlag), 02/07 (Fact-Schema: `berthable`, Ortsart aus Belegen), 08 (Liefervertrag: `berthable`, `contact`; Auslieferungsregel), 09 (Admin: Herkunft der Bestätigung), 13 (Ortsbilder: nur ausgelieferte Orte)

## Zweck

Ankerplatz-Kandidaten entstehen aus Kartendaten (OSM-Buchten, Hafen-Tags) und aus der Geometrie. Eine OSM-Bucht ist aber nur eine Küstenform, ein OSM-Hafen oft ein Fischer- oder Fährhafen. Bisher macht ein Mensch aus einem Kandidaten einen ausgelieferten Ort (`confirmed`). Das skaliert nicht über das Mittelmeer, und die Handbestätigung prüft nicht, was die App eigentlich wissen muss: **Kann eine Charter-Crew hier festmachen?**

Diese Spec legt fest:

1. was die vier Ortsarten bedeuten,
2. ein eigenes Merkmal „Festmachplatz“ (ja/nein),
3. wann ein Ort ohne Mensch bestätigt und damit ausgeliefert wird und ein Bild bekommt.

## Ortsarten (Christian)

Die Ortsart sagt, **was** der Ort ist:

| Ortsart | Bedeutung |
| --- | --- |
| `marina` | Freizeithafen, in dem Freizeitboote anlegen. Dazu zählt auch der Stadtkai eines Inselhafens, an dem Yachten mit Heckleinen festmachen, ohne Betreiber und ohne Website, selbst wenn an der Mole Fähren anlegen. |
| `anchorage` | Ort, an dem man ankern kann. |
| `mooring_field` | Ort, an dem ein Freizeitboot an einer Boje festmacht. |
| `port` | Gewerblicher oder Industriehafen (Fähren, Fracht, Fischerei, Werft) ohne Liegeplätze für Freizeitboote. |

Die Kombination „Fährhafen mit Yacht-Liegeplätzen“ ist eine `marina` (Christian). Kein neuer Enum-Wert, keine Vertragsänderung an `kind`.

Die Ortsart aus dem Seed (`placeKindFromTags`) ist nur ein **Vorschlag**. Belegt eine Quelle oder die Marina-Website etwas anderes, wechselt die Ortsart (siehe „Ortsart aus Belegen“).

## Festmachplatz (Christian)

Das neue Merkmal `berthable` sagt, **ob eine Charter-Crew auf der Durchreise hier festmachen kann**: ankern, an einem Gastliegeplatz oder am Stadtkai anlegen, an einer freien Boje festmachen.

- Typisch ja: Marina mit Gastliegeplätzen, Stadtkai, Ankerplatz, freies Bojenfeld.
- Typisch nein: gewerblicher Hafen; ein Bojenfeld, dessen Bojen fest vergeben sind oder nur langfristig gemietet werden (Christian); eine Marina nur mit Dauerliegern („no visitors“; Claude).

Die Ortsart bleibt dabei, was der Ort ist: Ein privates Bojenfeld bleibt `mooring_field`, nur eben mit `berthable = false` (Claude: so muss niemand die Ortsart verbiegen, um „nicht für Charter“ auszudrücken).

### Fact

Neues Attribut `berthable` auf Ebene Ort, Boolean, Regel `latest_observation`, nur aus Text. Beschreibung für den Extraktions-Prompt:

> „Whether a charter crew on passage can moor here for a short stay: anchor, take a visitor berth or moor stern-to at the quay, or pick up a free buoy. False if the buoys are private or only rented long-term, if the marina takes no visiting boats, or if the harbour is commercial only.“

Wie bei `services.fuel` gilt: Ein fehlendes Zitat ergibt kein „nein“. Ein Ja braucht ein Zitat wie „visitor berths“, „we anchored in …“, „moored at the town quay“; ein Nein ein Zitat wie „private moorings only“, „no berths for visiting yachts“.

Kommt mit dem Fact-Schema v3 aus Teil-Spec 15, Teil B (gleicher Versionswechsel, ein Reprozessieren).

## Einführung (Christian)

Teil-Spec 15 und 17 gehen **zusammen live**; das Reprozessieren aller Landesteile mit Fact-Schema v3 gehört zum Vorhaben. Keine Teilregel mit v2 vorab. Die automatische Bestätigung wird je Landesteil erst eingeschaltet, wenn dessen Reprozessieren durch ist (Claude: sonst fehlen die Belege, weil v2-Facts unter v3 nicht mehr zählen, und Orte würden zu spät oder mit falschem `berthable` bestätigt).

### Ableitung ohne Fact (Claude)

Wo kein `berthable`-Fact vorliegt, leitet die Konsolidierung den Wert für ausgelieferte Orte ab, Herkunft `derived`:

| Ort | `berthable` |
| --- | --- |
| `no_anchoring` (jede Ortsart) | `false` |
| `port` | `false` |
| `anchorage`, `marina`, `mooring_field`, bestätigt (automatisch oder von Hand, auch Bestand) | `true` |

Ein Fact geht immer vor; ein privates Bojenfeld wird also nur über ein Zitat zu `false`. Begründung: Wer einen Ankerplatz bestätigt, hat bestätigt, dass man dort festmachen kann; sonst sähe die App beim Bestand fast überall „unbekannt“.

## Ortsart aus Belegen

Ein neues Text-Attribut `place.kind_evidence` (Enum wie `place_kind`, Regel `latest_observation`, nur aus Text) erlaubt es, die Ortsart aus Belegen zu korrigieren, etwa „the harbour is used by fishing boats only“ → `port` oder „the old fishing harbour now has 40 visitor berths“ → `marina`. Beschreibung im Prompt mit den Definitionen der Tabelle oben.

- Wechselt der konsolidierte Wert gegenüber `places.kind`, wird die Ortsart des Ortes angepasst (anfügend protokolliert wie eine Admin-Entscheidung, Akteur `system`, Grund mit Fact-IDs).
- Eine Ortsart, die ein Admin gesetzt hat, wird nie automatisch überschrieben. Als „von einem Admin gesetzt“ gilt (Claude): eine Ortsart, die in einer Prüfentscheidung (`confirm` mit `kind`) vom Seed-Vorschlag abweicht, und jede künftige ausdrückliche Änderung der Ortsart im Admin. Eine Bestätigung, die nur den Seed-Vorschlag übernimmt, sperrt die Ortsart nicht; sonst wirkte `place.kind_evidence` nie auf den Bestand.
- Wie der Wechsel technisch läuft (neue Zeile in `places` mit `valid_from` oder Update mit Protokoll), entscheidet der Plan nach dem, was die Zusammenführung von Orten heute tut.

## Bestätigung nach Beleg

Bisher setzt nur ein Mensch `confirmed`. Neu bestätigt die Konsolidierung einen Kandidaten automatisch, wenn die Belegregel seiner Ortsart erfüllt ist. Die Bestätigung ist das Gate für Lieferung und Bild (beide hängen schon an `delivery.spots.statuses`).

### Belegregel je Ortsart

| Ortsart | Bestätigt, wenn |
| --- | --- |
| `anchorage`, `mooring_field` | Festmach-Beleg aus Quellen (siehe unten) |
| `marina` | die eigene Website ist von der KI als Freizeithafen mit Gastliegeplätzen ausgewertet (Teil-Spec 15, Teil C) **oder** Festmach-Beleg aus Quellen |
| `port` | Beleg aus einer Quelle oder der Website, dass es ein gewerblicher Hafen ist (`place.kind_evidence = port` oder `berthable = false` mit Hafen-Bezug), oder OSM-Tags, die eindeutig gewerblich sind (Claude: `harbour:category` = ferry/fishing/industrial/cargo ohne `leisure=marina`) |

**Festmach-Beleg (Christian hat dem Vorschlag zugestimmt):** mindestens ein Fact mit wörtlichem Zitat, der zeigt, dass eine Crew dort festgemacht hat oder festmachen kann (`berthable = true`, `mooring.types`, `anchoring.*`, Grund, Schutz aus Text, Bojen), oder ein Routen-Stopp eines Törnberichts, und zwar aus

- **einer** Quelle vom Typ Revierführer oder Hafenhandbuch, **oder**
- **zwei** Dokumenten verschiedener Domains (Törnberichte, Blogs, Foren).

Schwellen (Anzahl, Quelltypen, zählende Attribute) stehen in `config/delivery.json` unter `confirmation`, nicht im Code. Eine bloße Erwähnung („wir segelten an X vorbei“) zählt nicht.

Voreinstellung der Quelltypen (`config/source-types.json`; Claude):

| Quelltyp | zählt |
| --- | --- |
| `pilot_guide`, `authority` | allein |
| `trip_report`, `forum`, `travel_guide`, `other` | als eines von zwei Dokumenten verschiedener Domains |
| `marina` | nur für den Ort, an den die Website gebunden ist (Teil-Spec 15), nie für Orte in der Nähe |
| `dataset` | nicht |

### Wann nicht automatisch bestätigt wird (Claude)

- Der Ort hat eine offene Dubletten-Prüfung (`place_candidate` mit Subjekt `geo_object_pair`): Er wartet, bis sie entschieden ist; sonst könnten zwei Spots für dieselbe Bucht ausgeliefert werden.
- Wie die Handbestätigung prüft die automatische die Sperrgebiete der neuesten Geometrie (`recheckExclusion`); liegt der Ort in einer Sperrfläche, wird er `no_anchoring` statt `confirmed`.

Mit der Bestätigung setzt die Konsolidierung `berthable = true`, wenn kein Fact etwas anderes sagt (für `marina`, `anchorage`, `mooring_field`); für `port` `false`.

### Vorrang und Dauer

- **Handentscheidungen gewinnen.** Ein verworfener Ort (`rejected`), `no_anchoring` und eine Admin-Ortsart werden nie durch neue Belege überstimmt. Ein Admin kann wie bisher von Hand bestätigen, auch ohne Beleg.
- **`no_anchoring` bleibt ausgeliefert**, ohne Belegregel: Verbote aus amtlichen Daten sind Sicherheitsinformation (unverändert).
- **Bestätigt bleibt bestätigt.** Verschwindet der einzige Beleg später (Dokument `gone`, Fact abgelaufen), fällt der Ort nicht aus der Lieferung; das Profil trägt dann wie heute „wenig belegt“ (`lowConfidenceNote`). Grund: ein Ort, der in der Lieferung kommt und geht, springt im Änderungsfeed hin und her.
- Bestehende, von Hand bestätigte Orte bleiben bestätigt.

### Protokoll

Jede automatische Bestätigung schreibt wie die Quellen-Autofreigabe (Teil-Spec 11) eine Entscheidung mit Akteur `system`, der Regel und den belegenden Fact- bzw. Dokument-IDs. Die Ortsseite im Admin zeigt „Automatisch bestätigt am … durch …“ mit Links auf die Belege. Offene `place_candidate`-Aufgaben des Ortes mit Subjekt Ort (nicht Paar-Prüfungen, siehe oben) werden dabei als „automatisch erledigt“ geschlossen.

## Folgen für Lieferung und Bild

- Ausgeliefert werden wie bisher Orte mit Status in `delivery.spots.statuses` (`confirmed`, `no_anchoring`). Nur die Art, wie ein Ort `confirmed` wird, ändert sich.
- **Auch Nicht-Festmachplätze werden ausgeliefert** (Christian): ein bestätigter gewerblicher Hafen oder ein privates Bojenfeld mit `berthable = false`, damit die App sie auf der Karte zeigen und meiden kann.
- Bilder (Teil-Spec 13) entstehen weiter nur für ausgelieferte Orte; ein Kandidat bekommt kein Bild. Unverändert, weil die Bildstufe dieselbe Statusliste liest.
- Inseln, Orte (Siedlungen), Reviere und Highlights werden wie bisher ohne Quellenbeleg ausgeliefert (Christian).
- Highlights dürfen nur auf ausgelieferte Spots verweisen (`spotIds`). Die Validierung prüft das; ein Verweis auf einen nicht ausgelieferten Ort fällt weg (Claude).

## Liefervertrag

Vertrag 2.3 (2.2 ist die Highlight-Stufe aus Teil-Spec 16), nur additive Felder:

- `spot.berthable: boolean | null` – Festmachplatz für Charter-Crews; `null` = unbekannt.
- `spot.contact: { vhf: string | null, phone: string | null, url: string | null } | null` – Anmeldung bei Marina oder Hafen. Das Fact-Attribut `contact` gibt es schon (Fact-Schema v2), es wird heute nicht geliefert. Quelle vor allem die Marina-Website (Teil-Spec 15).
- Doku von `kind` mit den Definitionen der Tabelle oben.

## Folgen, die bewusst in Kauf genommen werden

- **Berechnete, unbenannte Buchten** (`origin = 'computed'`, Teil-Spec 04) werden praktisch nie ausgeliefert: Die Erwähnungserkennung läuft über Namen, ein Text kann sie kaum belegen. Die App verliert damit stille Ausweichbuchten. Aus Sicherheitssicht gewollt; ein Admin kann sie von Hand bestätigen.
- Ein Stadtkai ohne Website wird erst mit Törnberichten oder Hafenhandbuch ausgeliefert.
- Die Zahl ausgelieferter Orte sinkt gegenüber „alles Bestätigte“ nicht, steigt aber langsamer als die Zahl der Kandidaten.

## Kennzahlen

Je Landesteil auf der Qualitätsseite:

- Kandidaten, davon automatisch bestätigt, von Hand bestätigt, ohne Beleg.
- Ausgelieferte Orte je Ortsart, davon `berthable` ja/nein/unbekannt.
- Ortsart-Wechsel durch Belege (Seed-Vorschlag → Ergebnis), als Maß dafür, wie gut der Seed rät.

## Tests

- Belegregel: ein Revierführer-Fact bestätigt einen Ankerplatz; ein Törnbericht allein nicht, zwei von verschiedenen Domains schon; zwei Dokumente derselben Domain nicht; eine Erwähnung ohne Festmach-Fact nicht.
- Marina: ausgewertete Website bestätigt; Website mit „no visitors“ ergibt `berthable = false`.
- Hafen: `place.kind_evidence = port` stuft eine Seed-Marina um; Admin-Ortsart bleibt.
- Vorrang: `rejected` bleibt trotz neuer Belege; `no_anchoring` wird ohne Beleg geliefert.
- Dauer: Beleg-Dokument `gone` → Ort bleibt bestätigt.
- Lieferung: `berthable` und `contact` im Spot; Highlight-Verweis auf nicht ausgelieferten Ort fällt weg.
- Bild: Kandidat bekommt kein Bild, automatisch bestätigter Ort schon.

## Nicht-Ziele

- Unbenannte Buchten über Texte belegen (Abgleich über Koordinaten aus Texten).
- Liegeplatz-Preise, Reservierung, Öffnungszeiten der Marina.
- Neue Ortsart für Stadtkai oder Kombi-Hafen.
