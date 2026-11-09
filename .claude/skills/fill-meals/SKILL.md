---
name: fill-meals
description: Help the user decide what and where to eat for the meals that have no place yet in a TripCode trip, dish first and place second, from real data. Use when the user says "這餐吃什麼", "幫我決定這幾餐", "附近有什麼好吃的", "推薦餐廳", "當地必吃", "有什麼必吃的", "fill the meals", or presses 「找吃的」 on the 訂票清單 page. Never invents a restaurant, a rating, a price or opening hours.
---

# Decide what to eat, then where

The old way, a map search for "restaurants near <stop>", is not what anyone does and its results are poor. The way here: **the dish first** (what is this city known for eating), **then places that really exist near where you will be, open at that hour**, with the proof for each. The user can do most of it by tapping 「找吃的」 on the 訂票清單 page (`#/trip/<id>/office`); you help when they ask in chat, or to fill what the buttons cannot (Chinese names, reasons, web evidence).

Read **`trip-authoring`** first if you will edit `trip.ts`. Everything about the food guide goes through `npm run tripcode -- food …` (the file `trips/<id>/food.json` is never edited by hand).

## What you do

1. **See where things stand:** `npm run tripcode -- food show <tripId> --pretty` (dishes, taste, places looked at) and `npm run tripcode -- ready <tripId> --pretty` (the meals with no place show as `meal-gap`). Ask nothing the files already answer.
2. **The dishes of the city.** If `food show` has none for the city:
   - read Wikivoyage's Eat section: `food guide <tripId> --city 羅馬 --page Rome --pretty` (add `--save` to keep them). It reads names only, with the page's revision, and never overwrites a dish already in the file. The page name is the English Wikivoyage title (`Rome`, `Osaka`; a district page like `Rome/Colosseo` also works).
   - **The editors' picks (how to tell a good place from an arbitrary one without ratings):** a district page (`--page Rome/Colosseo`, `Osaka/Minami`) also lists the places Wikivoyage's editors recommend, with coordinates and the date of their last edit; `food guide` keeps them (`listings`) and `food near` puts a matching shop first, marked 「旅遊指南（Wikivoyage）列為推薦」 with the edit date. Read the district page of where the user will eat when one exists. An old edit date is a lead, not a promise: say so.
   - then improve what it saved: for each dish `food dish add <tripId> --json '{…}'` with a Chinese name (`nameZh`), one line of **your own words** for why (`why`), `tags` (pork, beef, seafood, raw, offal, spicy, vegetarian-ok, street-food, dessert, pasta, noodle…), and `match` (`names`: how the dish is spelled on a shop sign, local script included; `cuisines`: OSM cuisine tags like `okonomiyaki`; `venueWords`: `trattoria`, `osteria`). Keep the Wikivoyage source on the dish.
   - dishes you know yourself and the page does not list are allowed, **marked as your own impression**: `"sources": [{"kind":"ai","fetchedAt":"<now ISO>"}]`. The screen then says 「AI 的印象，尚未查證」. Do not write a source you did not read.
3. **Taste.** Ask once, in plain words, what to avoid (pork? raw? offal?), the budget and whether kids come; record it: `food taste <tripId> --avoid-tag pork --diet no-pork --budget mid --kids true`. Do not ask what `party` (kids) or earlier answers already say. **Record only what the user actually said.** "道地的羅馬菜，不吃內臟" is `--avoid-tag offal`, not also pork or anything you think likely; if a dish you would drop is borderline (oxtail), keep it and say so, or ask.
4. **Places for a meal:** `food near <tripId> --date <YYYY-MM-DD> --slot lunch|dinner [--anchor prev|next|hotel|<itemId>] --save --pretty` (always with `--save`: that is what shows the places on the user's screen and fetches their photos). It uses the meal window and the stops on either side from the trip, the dishes you chose, OpenStreetMap, and says what it dropped and why. Read its output honestly:
   - A map has **no ratings or reviews**. Never call a place "popular" or "highly rated". Each result has a Google Maps link for the user to see ratings; the user's own rule is review count first, then rating, and they apply it there.
   - `generalMode: true` means no shop name or cuisine tag matched any chosen dish (normal in Italy). Say so; do not claim a place serves the dish.
   - `open: unknown` means the opening hours are not written down: say to check before going.
5. **Shortlist, then read about each one. A list of names is not an answer.** Nobody can choose between "César Étoile" and "Flora Danica" from a name and opening hours. Before you recommend anything:
   - From `food near … --save` take **at most 3** places: drop fast-food and chain outlets (Burger King, Quick, McDonald's…) and anything flagged as a tourist trap or sitting right beside a landmark, put the guide's picks (`旅遊指南列為推薦`) first. If fewer than 3 are worth it, give fewer.
   - For each, `WebSearch` its name and city (also the local-script name), then **open 1–2 real pages** (its own site, a guide such as Michelin or Time Out, a newspaper, a food blog by a person) and read them. Learn: what kind of place it is, what people order there, the price **only if a page states it**, and what to know (queue, cash only, closes early, a tourist menu).
   - Record it: `food profile <tripId> --place <key> --json '{"summary":"一句話：這是什麼店、為什麼值得走","order":["點什麼"],"price":"頁面寫的價位","watch":"要注意的","sources":["https://你讀過的網頁"]}'`. Your own words; `sources` are the pages you actually read (the command refuses a profile without one). **No rating, stars, score or review count, anywhere**: the command refuses those too.
   - A photo: `food near --save` already fetches the picture of the top places' own websites. For a place that has none, try `food photo <tripId> --place <key> --page <the place's own https website>` (a site you found yourself). Use the place's own site only. If it fails, go on without a picture. Never use pictures from image searches or of other places.
   - If you find **no page at all** about a place, say 「網路上查不到介紹」 for it, rank it below the ones you could read about, or leave it out. Do not fill the gap with what you imagine a trattoria is like.
   - Evidence of one claim (「某報導推薦」) also goes in with `food evidence add … --kind web --claim recommended --source https://… --confidence recent --detail "一句話"` (no address, no evidence).
6. **Answer short: the screen already shows the places.** `food near … --save` puts the places on the left of the screen (the 「餐廳推薦」 board of the 訂票清單 page) as cards with the photo of the place's own page, and every `food profile` you write appears on its card a moment later. So **do not repeat a table or a list of names in chat**, and never a table of opening hours. Say, in a few lines:
   - one sentence on which dish you started from and why it suits this meal;
   - for each of the (at most 3) places you read about: your own judgement in one or two sentences (what it is, why or why not for this meal, the one thing to watch), with the source in `[site](url)` form;
   - at most two lines on what you could not check (no page found, hours unknown);
   - what you need from the user (a choice, or 「按『選這餐』」 on the card).
   Mention that the cards are on the left in one short sentence. If `food photo` failed for a place, do not apologise at length: the card simply has no picture.
7. **Adopt:** the user presses 「加入這餐」 in the drawer, or tells you which place. Only a place that `food near` returned (it has the "exists" proof) can be put in the itinerary. In chat, tell the user to press 「加入這餐」 for it (that fills the meal item with the name, coordinates, `placeId`, the dishes and the checks, in one undoable step). If you must edit `trip.ts` yourself, fill the placeholder meal (「午餐：待選」) instead of adding another and write `placeId`, `loc` (with `fetchedAt`), `slot`, `dishes`, and `checks` (`exists`, `openAtSlot` as `Sourced`).
8. `npm run check -- <tripId>` after editing `trip.ts`.

## Hard rules

- **Never invent a restaurant**, a rating, a review count, a price or opening hours. A name you recall from memory is a lead: run `food near` to see whether the map knows it, and only a place found there (or that the user pasted as a Google Maps link) goes into the itinerary.
- Ratings, stars, scores and review counts are never written to `trip.ts` or `food.json` (Google's terms limit it; there is no field for them, and `food profile` refuses them). The place's name, coordinates (30-day cache) and id are.
- The dish list is a guide, not a promise: Wikivoyage names what the city is known for, not what a given shop serves well.
- Wikivoyage text is CC BY-SA: keep names and the link, do not paste its sentences into the file.
- No booking: if the place takes reservations, say so and give its own page; the user books. Never pay.
- Never change a `locked: true` item.
