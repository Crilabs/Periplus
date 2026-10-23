# N1 – Probelauf Recherche, Landesteil GR-I (Attika, Saronischer Golf)

Lauf `01a1696e-1a7e-73a4-b982-a22bc23ba642`, 23.10.2026, Dev-Datenbank. Gemessen nach Ende aller drei Stufen.

## Kennzahlen

| Größe | Wert |
| --- | --- |
| Kandidaten (candidate/confirmed) | 85 (77 Ankerbuchten, 7 Marinas, 1 Hafen) |
| davon mit Namen | 36 (28 Ankerbuchten, alle Marinas, Hafen) |
| davon mit Treffern | 34 |
| Suchanfragen (DataForSEO) | 221 (319 Aufrufe inkl. Wiederholungen) |
| Treffer positiv / negativ | 1.232 / 1.127, im Mittel 38 bzw. 35 je Kandidat (Obergrenze 40 meist erreicht) |
| Seiten geholt | 1.259 gespeichert, 265 HTTP 403, 68 robots, 23 sonstige Fehler, 5 Umleitung auf fremde Domain |
| Seitenbewertungen | 1.413 |

**Seitenarten (Bewertung):**

| Art | Seiten | erste Hand | SEO/KI |
| --- | ---: | ---: | ---: |
| Sonstiges | 485 | 2 | 41 |
| Liste | 368 | 2 | 131 |
| Behörde | 162 | 0 | 1 |
| Revierführer | 158 | 80 | 22 |
| Reiseführer | 143 | 2 | 34 |
| Törnbericht | 41 | 35 | 0 |
| Forum | 37 | 13 | 0 |
| Marina | 19 | 0 | 1 |

**Kosten (nur dieser Lauf):** 9,83 € = Anthropic Bewertung 7,21 € + Anthropic PDF-Umwandlung 1,50 € + DataForSEO 1,12 €; ≈ 0,29 € je Kandidat mit Namen.

## Befunde

1. **Unbenannte Buchten finden nichts.** 49 der 77 Ankerbucht-Kandidaten haben keinen Namen und bekommen keine Suchanfrage. Sie sind nur über die Entdeckung aus Routen (N2, 5.5) erreichbar. Das ist die größte Lücke für die Abdeckung und Thema für N3 (Fehlliste gegen Navily).
2. **Die Treffer-Obergrenze 40 wird fast immer erreicht.** Die Suche liefert mehr, als gehalten wird; ob 40 reicht, zeigt die Bestätigungsquote in N2/N3.
3. **Wenige Seiten aus erster Hand.** Nur 41 Törnberichte und 37 Forenseiten; die meisten Belege aus erster Hand kommen aus Revierführern (80). Die Suchvorlagen sollten stärker auf Törnberichte und Blogs zielen (z. B. „{name} sailing blog“, „{name} anchored overnight“, „Törn {insel} Ankerbucht“).
4. **Viel Ausschuss in Listen.** 131 von 368 Listen sind SEO/KI; Listen zählen ohnehin nicht als Beleg.
5. **HTTP 403 bei 17 % der Seiten.** Darunter `hcg.gr` (Griechische Küstenwache, 45 Seiten) – wichtig für Negativbelege (Ankerverbote). Der direkte Abruf wird geblockt; ein Abruf über einen Konverter-Dienst (Jina/Firecrawl) für 403-Antworten wäre zu prüfen.
6. **TripAdvisor-Länderdomains** (`.at`, `.de`, `.ch`, `.co.uk`) fehlen in `skipDomains` (nur `.com`) und kosten Abrufe.

## SQL der Messung

```sql
select purpose, count(*), count(distinct place_id) from research_hits group by 1;
select outcome, reason, count(*) from research_fetches group by 1,2 order by 3 desc;
select page_kind, count(*), sum(first_hand::int), sum(generated::int) from page_assessments group by 1;
select service, stage, round(sum(cost_eur)::numeric,2) from external_calls where run_id = '<run>' group by 1,2;
```

Die Stichprobe von 30 Bewertungen von Hand (Plan-Schritt 3) steht noch aus.
