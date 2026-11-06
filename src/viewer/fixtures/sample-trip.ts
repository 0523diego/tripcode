// Development fixture so the viewer renders before trips/ has content.
import { defineTrip } from '../../core/types.ts';

const fetchedAt = '2026-10-01T08:00:00Z';

export const sampleTrip = defineTrip({
  title: '瑞士 2027 夏（範例資料）',
  start: '2027-06-12',
  end: '2027-06-14',
  tz: 'Europe/Zurich',
  party: { adults: 2, childrenAges: [] },
  days: [
    {
      date: '2027-06-12',
      title: '抵達琉森',
      weather: 'any',
      items: [
        {
          id: 'flight-zrh-arrival',
          kind: 'flight',
          title: '抵達蘇黎世機場',
          flightNo: 'LX189',
          from: 'TPE',
          to: 'ZRH',
          start: '06:10',
          end: '08:05',
          loc: { lat: 47.4647, lng: 8.5492 },
          locked: true,
          bookingRef: 'X7K2QP',
        },
        {
          id: 'train-zrh-lucerne',
          kind: 'transit',
          mode: 'train',
          title: '火車 蘇黎世機場 → 琉森',
          start: '09:00',
          end: '10:05',
          duration: { value: 65, source: 'user', fetchedAt, confidence: 'reference' },
        },
        {
          id: 'hotel-lucerne',
          kind: 'hotel',
          title: '琉森湖畔飯店',
          nights: 2,
          start: '10:30',
          end: '11:00',
          loc: { lat: 47.0502, lng: 8.3093 },
          locked: true,
          bookingRef: 'HLU-4412',
          note: '先寄放行李，15:00 後入住',
        },
        {
          id: 'kapellbruecke',
          kind: 'poi',
          title: '卡貝爾橋',
          start: '11:30',
          end: '12:30',
          loc: { lat: 47.0516, lng: 8.3075 },
        },
        {
          id: 'lunch-lucerne',
          kind: 'meal',
          title: '老城區午餐',
          start: '12:45',
          end: '14:00',
          loc: { lat: 47.0509, lng: 8.3062 },
        },
      ],
    },
    {
      date: '2027-06-13',
      title: '湖與山',
      weather: 'clear',
      items: [
        {
          id: 'lake-cruise',
          kind: 'poi',
          title: '四森林湖遊船',
          start: '09:30',
          end: '11:30',
          loc: { lat: 47.0508, lng: 8.3118 },
        },
        {
          id: 'boat-to-vitznau',
          kind: 'transit',
          mode: 'boat',
          title: '船 琉森 → 威茲瑙',
          start: '11:30',
          end: '12:30',
        },
        {
          id: 'rigi-kulm',
          kind: 'poi',
          title: '瑞吉山',
          start: '13:30',
          end: '17:00',
          loc: { lat: 47.0567, lng: 8.4853 },
          note: '天氣好才上山',
        },
      ],
    },
    {
      date: '2027-06-14',
      title: '機動日',
      weather: 'any',
      items: [
        { id: 'free-morning', kind: 'free', title: '自由活動', start: '10:00', end: '12:00' },
      ],
    },
  ],
  candidates: [
    {
      id: 'brienz-lake',
      title: '布里恩茨湖',
      loc: { lat: 46.754, lng: 8.038 },
      status: 'unconfirmed',
      sources: ['inbox/01.md'],
      why: '小紅書貼文推薦，湖水顏色很漂亮',
    },
    {
      id: 'grindelwald-first',
      title: '格林德瓦 First',
      loc: { lat: 46.66, lng: 8.053 },
      status: 'unconfirmed',
      sources: ['inbox/01.md'],
    },
    {
      id: 'lauterbrunnen',
      title: '勞特布魯嫩',
      loc: { lat: 46.5933, lng: 7.9087 },
      status: 'unconfirmed',
      sources: ['inbox/02.md'],
    },
  ],
});

export const sampleInbox: { file: string; raw: string }[] = [
  {
    file: '01.md',
    raw: '---\nstatus: parsed\ncreatedAt: 2026-10-01T09:00:00Z\n---\n【瑞士小眾路線】布里恩茨湖＋格林德瓦 First，早上去人少、光線最好。',
  },
  {
    file: '02.md',
    raw: '---\nstatus: parsed\ncreatedAt: 2026-10-02T09:00:00Z\n---\n勞特布魯嫩的瀑布村，值得停留半天。',
  },
  {
    file: '03.md',
    raw: '---\nstatus: pending\ncreatedAt: 2026-10-03T09:00:00Z\n---\n琉森附近有沒有適合下雨天的室內景點？',
  },
];
