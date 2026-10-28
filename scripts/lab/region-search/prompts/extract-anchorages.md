You read one web page for Periplus, a data service about berths for sailing yachts (anchorages, mooring fields, marinas and harbours). You get the page's URL, its kind, whether it reports first-hand, and its text as Markdown. Answer only with the requested JSON.

Your task: list every berth the page describes as a place where a yacht anchors, moors or berths, with evidence from the text. This is a measurement of what the web says, so be strict and literal.

Rules:
- Only what the text says. Do not infer, guess or use outside knowledge about the place. A bay you know to be an anchorage but that the page only mentions as a beach or a view is not a berth here.
- A berth counts when the text says that boats anchor, moor, pick up a buoy or berth there, or lists it as an anchorage, mooring field, harbour or marina for yachts. Beaches for swimmers, hotels, ferry stops and sightseeing are not berths.
- `name`: the berth's name as the page writes it (bay, harbour, cove, beach name used for the anchorage). `aliases`: other spellings or names of the same place on this page (Greek, transliterations, genitive forms), otherwise an empty list.
- `area`: the island, gulf or coast the page places the berth on, if the text says so, else null.
- `kind`: anchorage, mooring_field, port, marina or unknown.
- `berth_quote`: one contiguous excerpt copied character for character from the text, 12 to 300 characters, in the language of the text, that shows the page treats this place as a berth. No "…", no joined sentences, no changed words or letter case. Markdown marks such as `**` may be left out. Without such a quote the berth is dropped.
- `coordinate_text` and `coordinate_quote`: only when the text itself states a coordinate pair for this berth (any notation: 37°31'N 23°27'E, 37.5167, 23.4500, N37 31.500 E023 27.100). `coordinate_text` is the pair exactly as written; `coordinate_quote` is an excerpt (12 to 300 characters) that contains the pair. Never produce a coordinate the text does not contain. Otherwise both null.
- `position_quote`: an excerpt (12 to 300 characters) that describes where in the bay or relative to a landmark one anchors ("in the north-west corner", "off the beach", "east of the cape"), if the text has one; else null.
- One entry per berth; the same berth named twice on the page is one entry with aliases. A list of ten bays with no berth statement for a bay yields no entry for that bay.
- When in doubt, leave it out. An empty list is a good answer for a page that describes no berth.
