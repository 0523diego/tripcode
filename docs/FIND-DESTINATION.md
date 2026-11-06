# Step 0: 找方向 (find a destination)

TripCode used to start at "where and when" (the 新增旅程 form). Most people start earlier: they want to travel and do not
know where yet. Step 0 takes them from that to a destination and dates, and then hands over to the existing five steps
(盤點 → 排行程 → 審稿 → 訂票 → 出發前).

What is fixed: the order of the questions, the card for each, the shape of every answer and recommendation, and the
rule that decides which card comes next (`nextStep`, computed from the file, never declared). What is free: the
destination ideas themselves. The AI suggests them from its own knowledge, and two runs may suggest different places.
Prices and timetables are not free: a number either has a source or is shown as 「估計」.

## The screen

`#/idea/<id>`. No map and no day list yet. A satellite globe fills the page and turns slowly, seen from space. The
question card floats over the left side (where the day list will appear later). The AI panel is docked on the right
and open. Answered questions sit as chips above the card; clicking one goes back to it.

Clicking a card and typing in the AI panel do the same thing: both end up writing `trips/<id>/idea.json` (the page
through a dev-server endpoint, the AI through `tripcode idea …`), and the page re-renders from the file. When places
are suggested, pins appear on the globe. When one is chosen, the globe turns to it. When the trip is created, the globe
zooms in and the page goes to `#/trip/<newId>`, where the map and the day list take over.

## Question order (nextStep)

```
known        決定好要去哪了嗎？        yes → type a place      no → focus
origin       從哪裡出發？              (always; fills 出發地 in brief.md)
focus        這趟比較在意什麼？         budget | scenery | both          (only when known = no)
budget       預算大概多少？            amount + currency + per person/total, or 不確定   (focus budget/both)
scenery      想看什麼、想做什麼？       multi-select tags + free text    (focus scenery/both)
when         大概什麼時候？            months, or 不確定
days         去幾天？                  number, or 不確定
party        跟誰去？                  solo | partner | friends | family | parents, adults, children ages
suggest      (no places yet)           button 「給我 3 個點子」 → asks the AI      (known = no)
choose       pick one of the 3 cards   選這個 / 不要 / 再給我別的                 (known = no)
locate       the AI places the typed destination on the globe                    (known = yes)
dates        出發和回來的日期           date inputs, prefilled from when/days
finish       title, time zone, people  「建立行程」
done         trip.ts exists
```

Every question accepts 「不知道／跳過」 (stored as `null`, which counts as answered). `wantNow: true` (「直接推薦」,
available from `focus` on) treats every remaining question before `suggest` as skipped.

## idea.json

Written only through `src/core/idea.ts` (pure: parse, validate, apply) so the CLI, the endpoint and the page agree.

```ts
interface Idea {
  version: 1;
  createdAt: string;            // ISO
  updatedAt: string;
  known?: { decided: true; place: string } | { decided: false };
  origin?: string | null;
  focus?: 'budget' | 'scenery' | 'both';
  budget?: { amount: number; currency: string; per: 'person' | 'total' } | null;
  scenery?: { tags: SceneryTag[]; text?: string } | null;
  when?: { months: number[]; text?: string } | null;   // months 1–12
  days?: number | null;
  party?: { who: 'solo' | 'partner' | 'friends' | 'family' | 'parents'; adults: number; childrenAges: number[] };
  wantNow?: boolean;
  places: IdeaPlace[];          // every place ever suggested, in order
  chosen?: string;              // IdeaPlace.id
  dates?: { start: string; end: string };
  tripId?: string;              // set when the trip was created
}

interface IdeaPlace {
  id: string;                   // kebab-case, unique in the file
  slug: string;                 // ascii kebab, used for the trip id: "switzerland" → switzerland-2027-06
  name: string;                 // 「瑞士」
  kind: 'country' | 'region' | 'city';
  country?: string;
  lat: number; lng: number;     // for the globe pin only
  tz: string;                   // IANA, e.g. Europe/Zurich
  why: string;                  // one sentence tied to the user's answers
  bestMonths?: number[];
  cost?: { text: string; source?: string; fetchedAt?: string };   // no source → shown as 「估計」
  round: number;                // 1, 2, … one round per 「給我點子」
  status: 'shown' | 'rejected' | 'chosen';
}

type SceneryTag = 'mountains' | 'sea' | 'city' | 'food' | 'culture' | 'history' | 'nature' | 'snow' | 'nightlife' | 'shopping';
```

## Creating the trip

`finish` writes `trips/<newId>/trip.ts` and `brief.md` with the existing `new-trip` code, moves `idea.json` into the
new folder (with `tripId` set) and removes the old `trips/<ideaId>/` folder if nothing else is in it. `newId` is
`<slug>-<YYYY-MM>` of the start date, with `-2`, `-3`… when taken. `brief.md` starts with what step 0 already knows
(destination, origin, party, budget, what they want to see), so 盤點 has fewer 「（待填）」.

## The globe

Raw WebGL, no new dependency. NASA Blue Marble (day) and Black Marble (city lights, night side) textures, a soft
terminator, an atmosphere rim and a star field. About one turn per 90 s; drag to spin, with inertia. Pins are HTML
over the canvas, hidden when they turn to the back. `prefers-reduced-motion` stops the turning; no WebGL shows a still
image. Imagery: NASA Earth Observatory / Visible Earth (public domain), credited on the page.

## Later

Phase 4, 怎麼去: once destination and dates are known, compare ways to get there by total cost (fare + bags + getting
to and from the airport + time), with real timetables and links, the way the user's europe-travel-planner skill does.
