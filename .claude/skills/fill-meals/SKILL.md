---
name: fill-meals
description: Help the user decide the meals that have no place yet (午餐／晚餐還沒決定) in a TripCode trip, based on where they will be. Use when the user says "這餐吃什麼", "幫我決定這幾餐", "附近有什麼好吃的", "填一下吃飯的空檔", "fill the meals", or presses the meal prompt on the office page. Does not invent restaurants.
---

# Fill the meal gaps

The 訂票清單 page (`#/trip/<id>/office`) lists the lunches and dinners that have no place yet (`tripcode ready <tripId> --pretty` shows them as `meal-gap`). For each, it offers a Google Maps search near the stop before, the stop after, or the hotel; the user picks a place and pastes its link back, and the page puts it into the trip.

## What you do

1. See the gaps: `npm run tripcode -- ready <tripId> --pretty`. Read the days involved in `trip.ts`: where the user is just before and just after, how much time there is, and whether a locked event (a show, a timed ticket) pulls dinner earlier.
2. Say, in plain words, **where to look**: 「週一午餐你在萬神殿附近，下一站走路 12 分鐘，往斗獸場方向找比較順」. If there are two reasonable sides, give both and let the user choose. The user's preference for ranking places is **review count first, then rating**; you do not have those numbers (they come from Google, and there is no key set up yet), so do not make them up and do not claim a place is "popular".
3. Give hard constraints you can verify: a place has to be open then (check the page you read, not memory), local meal times (dinner in Spain and Italy is late), the day's walking budget from `brief.md` / `profile.md`.
4. When the user has picked a place and gives you a Google Maps link or a name, add or fill the `meal` item: if there is a placeholder meal ("午餐：待選") on that day, fill **that** item instead of adding another; keep the place's coordinates from the link (`loc` with `fetchedAt`), and nothing else you cannot source. The office page does the same with its 「加進行程」 button.
5. `npm run check -- <tripId>` after editing.

## Hard rules

- **Never invent a restaurant**, a rating, a price or opening hours. A name you recall from memory is a lead to check, labelled as unverified, never an entry in the file.
- Google ratings and review counts are not written into `trip.ts` (Google's terms limit storing them); only the place's name, coordinates (30-day cache) and `placeId` are.
- No booking: if the restaurant takes reservations, say so and give its own page; the user books.
- Never change a `locked: true` item.
