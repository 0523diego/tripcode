---
name: fill-meals
description: Help the user decide what and where to eat for the meals that have no place yet in a TripCode trip, dish first and place second, by reading the web and handing back at most 3 checked places through `food suggest`. Use when the user says "這餐吃什麼", "幫我決定這幾餐", "附近有什麼好吃的", "推薦餐廳", "當地必吃", "有什麼必吃的", "fill the meals", or presses 「請 AI 找店」 on the 訂票清單 page. Never invents a restaurant, a rating, a price or opening hours.
---

# Decide what to eat, then where

The old way, a map search for "restaurants near <stop>", is not what anyone does and its results are poor (and the free map server behind it is slow and often down). The way here: **the dish first** (what is this city known for eating; the user ticks dishes, or says 「都可以」 and you choose), **then you read the web** for places people recommend for it near where they will be, and **hand back at most 3 places in one fixed shape** with `food suggest`. The program checks your answer (see step 4) and puts the cards on the user's screen. The user starts it with 「請 AI 找店」 on the 訂票清單 page (`#/trip/<id>/office`), which sends you the meal, the dishes and the command to use.

Read **`trip-authoring`** first if you will edit `trip.ts`. Everything about the food guide goes through `npm run tripcode -- food …` (the file `trips/<id>/food.json` is never edited by hand).

## What you do

1. **See where things stand:** `npm run tripcode -- food show <tripId> --pretty` (dishes, taste, places looked at) and `npm run tripcode -- ready <tripId> --pretty` (the meals with no place show as `meal-gap`). Ask nothing the files already answer.
2. **The dishes of the city.** If `food show` has none for the city:
   - read Wikivoyage's Eat section: `food guide <tripId> --city 羅馬 --page Rome --pretty` (add `--save` to keep them). It reads names only, with the page's revision, and never overwrites a dish already in the file. The page name is the English Wikivoyage title (`Rome`, `Osaka`; a district page like `Rome/Colosseo` also works).
   - **The editors' picks (how to tell a good place from an arbitrary one without ratings):** a district page (`--page Rome/Colosseo`, `Osaka/Minami`) also lists the places Wikivoyage's editors recommend, with coordinates and the date of their last edit; `food guide` keeps them (`listings`). Read the district page of where the user will eat when one exists (`WebFetch` it, or `food guide --page …`) as a lead for step 4: a place Wikivoyage's editors list is a good candidate, and it counts as a source page for `food suggest` (it must still name the place). An old edit date is a lead, not a promise: say so.
   - then improve what it saved: for each dish `food dish add <tripId> --json '{…}'` with a Chinese name (`nameZh`), one line of **your own words** for why (`why`), `tags` (pork, beef, seafood, raw, offal, spicy, vegetarian-ok, street-food, dessert, pasta, noodle…), and `match` (`names`: how the dish is spelled on a shop sign, local script included; `cuisines`: OSM cuisine tags like `okonomiyaki`; `venueWords`: `trattoria`, `osteria`). Keep the Wikivoyage source on the dish.
   - dishes you know yourself and the page does not list are allowed, **marked as your own impression**: `"sources": [{"kind":"ai","fetchedAt":"<now ISO>"}]`. The screen then says 「AI 的印象，尚未查證」. Do not write a source you did not read.
3. **Taste.** Ask once, in plain words, what to avoid (pork? raw? offal?), the budget and whether kids come; record it: `food taste <tripId> --avoid-tag pork --diet no-pork --budget mid --kids true`. Do not ask what `party` (kids) or earlier answers already say. **Record only what the user actually said.** "道地的羅馬菜，不吃內臟" is `--avoid-tag offal`, not also pork or anything you think likely; if a dish you would drop is borderline (oxtail), keep it and say so, or ask.
4. **Places for a meal: you look them up, `food suggest` checks and shows them.** There is no map search any more.
   - Search the web (`WebSearch`) for places that people recommend for the chosen dishes (or, for 「都可以」, for what this city does best at this meal) **near the stop the meal is anchored to** (the user's message names it; `food show`/`ready` give the rest). Search in the local language too. Fast food, chains and tourist-menu places next to a landmark are not recommendations.
   - **Open 1–2 real pages for each candidate** (its own site, Michelin, Time Out, a newspaper, a food blog by a person, the Wikivoyage district page) and read them. Learn what kind of place it is, what people order, its street address, the price **only if a page states it**, opening hours **as the page writes them**, and what to know (queue, cash only, closes early, a tourist menu).
   - Pick **at most 3**. Fewer is fine; none is fine. If you cannot find a page that really names a place, it is not a candidate: say 「網路上查不到」 and stop. Do not fill the gap with what you imagine a trattoria is like.
   - Hand them over in ONE call (the only accepted way; do not paste names or tables in chat):
     `npm run tripcode -- food suggest <tripId> --date <YYYY-MM-DD> --slot lunch|dinner --anchor <the anchor from the message> --json '[{"name":"Trattoria Milanese","nameZh":"米蘭小館","address":"Via Santa Marta 11, Milano","dishes":["risotto-alla-milanese"],"summary":"一兩句：這是什麼店、為什麼適合這一餐（你自己的話）","order":["點什麼","點什麼"],"price":"頁面寫的價位","watch":"要注意的","hours":"網頁寫的營業時間","website":"https://店家自己的網站","sources":["https://你讀過、寫到這家店的網頁"]}]' --pretty`
     - required: `name`, `address` (a full street address: it is how the coordinates are found), `summary`, `sources` (1–3 https pages you actually read); the rest is optional but `order` and `dishes` (ids from `food show`) make the card useful. `website` is the place's own site, used for its picture.
     - The command **checks you**: each source page is fetched and must contain the place's name (a page that cannot be fetched at all gives a card marked 「要自己確認」; a page that is read and lacks the name refuses the place); the address must be found on the map within 20 km of the meal; a rating, stars, a score or a review count anywhere is refused; unknown fields are refused. A refused place comes back with the reason: fix the name or address, or drop it. Send all places in one call (a second call for the same meal replaces the first).
   - Read what comes back honestly: `likely` = a source page names the place; `check` = no source could be read, so the user must check it themself. Say which.
5. **A list of names is not an answer; neither is a rating.** There are no ratings anywhere: never call a place "popular" or "highly rated". Each card links to Google Maps, where the user applies their own rule (review count first, then rating). Opening hours are what a page said, never verified against the clock: tell the user to confirm before going.
6. **Answer short: the cards are already on the screen.** `food suggest` puts them in the drawer on the 訂票清單 page and on the 餐廳推薦 board. So **do not repeat a table or a list of names in chat**. Say, in a few lines:
   - one sentence on which dish you started from (or what you chose and why, for 「都可以」);
   - for each place: your own judgement in one or two sentences (what it is, why for this meal, the one thing to watch) with the source as `[site](url)`;
   - at most two lines on what you could not check;
   - tell the user to press 「加入這餐」 on the card they like.
7. **Adopt:** the user presses 「加入這餐」 on the card, or tells you which place. Only a place that `food suggest` accepted can be put in the itinerary (it carries the proof: the page that names it, with the date). In chat, tell the user to press 「加入這餐」 (that fills the meal item with the name, coordinates, `placeId`, the dishes and the checks, in one undoable step). If you must edit `trip.ts` yourself, fill the placeholder meal (「午餐：待選」) instead of adding another and write `placeId`, `loc` (with `fetchedAt`), `slot`, `dishes`, and `checks` (`exists` as `Sourced` with the page's https address as `source`).
8. `npm run check -- <tripId>` after editing `trip.ts`.

## Hard rules

- **Never invent a restaurant**, a rating, a review count, a price or opening hours. A name you recall from memory is a lead: find a page that names it, or leave it out. Only a place that `food suggest` accepted (or that the user pasted as a Google Maps link) goes into the itinerary.
- Ratings, stars, scores and review counts are never written to `trip.ts` or `food.json` (Google's terms limit it; there is no field for them, and `food suggest` and `food profile` refuse them). The place's name, coordinates (30-day cache) and id are.
- The dish list is a guide, not a promise: Wikivoyage names what the city is known for, not what a given shop serves well.
- Wikivoyage text is CC BY-SA: keep names and the link, do not paste its sentences into the file.
- No booking: if the place takes reservations, say so and give its own page; the user books. Never pay.
- Never change a `locked: true` item.
