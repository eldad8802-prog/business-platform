# English dictionary chunk — proof (MAIN vs BRANCH)

checks: 704 passed, 0 failed

## Identity

300 comparisons (20 routes × 390/820/1440 × 5 cookie/flag variants): 300 exact, 0 differ only in wall-clock text, 0 different.

## HTML bytes (median over the routes that answer 200)

| variant | raw KB | br q5 KB | br q11 KB | gzip KB | RSC raw KB | dictionary sentinels |
|---|---|---|---|---|---|---|
| mainOnHe | 16.3 | 3.3 | 3 | 3.6 | 9.6 | 0/60 |
| branchOnHe | 16.3 | 3.3 | 3 | 3.6 | 9.6 | 0/60 |
| mainOnEn | 16.4 | 3.3 | 3 | 3.6 | 9.6 | 0/60 |
| branchOnEn | 16.4 | 3.3 | 3 | 3.6 | 9.6 | 0/60 |
| mainOff | 17 | 3.4 | 3.1 | 3.7 | 10.5 | 0/60 |
| branchOff | 17 | 3.4 | 3.1 | 3.7 | 10.5 | 0/60 |

| route | en MAIN raw | en BRANCH raw | en MAIN br5 | en BRANCH br5 | he MAIN raw | he BRANCH raw |
|---|---|---|---|---|---|---|
| /home | 88.2 | 88.2 | 13.9 | 13.9 | 88 | 88 |
| /about | 28.5 | 28.5 | 5.8 | 5.8 | 28.4 | 28.4 |
| /privacy | 79.4 | 79.4 | 13 | 13 | 79.3 | 79.3 |
| /login | 11.7 | 11.7 | 2.9 | 2.9 | 11.6 | 11.6 |
| /register | 14.1 | 14.1 | 3.5 | 3.5 | 14.2 | 14.2 |
| /forgot-password | 14.6 | 14.6 | 3.5 | 3.5 | 14.7 | 14.7 |
| /app | 15.4 | 15.4 | 3.2 | 3.2 | 15.4 | 15.4 |
| /collection | 15 | 15 | 3.1 | 3.1 | 14.9 | 14.9 |
| /billing | 43.6 | 43.6 | 7.9 | 7.9 | 43.7 | 43.7 |
| /billing/[id] | 38.6 | 38.6 | 7.5 | 7.5 | 38.7 | 38.7 |
| /customers | 16.4 | 16.4 | 3.2 | 3.2 | 16.3 | 16.3 |
| /customers/[id] | 16.9 | 16.9 | 3.3 | 3.3 | 16.8 | 16.8 |
| /leads | 16.4 | 16.4 | 3.2 | 3.2 | 16.3 | 16.3 |
| /settings | 45.8 | 45.8 | 7.4 | 7.4 | 46.1 | 46.1 |
| /settings/workspace | 43 | 43 | 7.8 | 7.8 | 43.3 | 43.3 |
| /secretary | 16.4 | 16.4 | 3.3 | 3.3 | 16.3 | 16.3 |
| /payables | 15.8 | 15.8 | 3.2 | 3.2 | 15.7 | 15.7 |
| /inventory | 40.1 | 40.1 | 6.8 | 6.8 | 40 | 40 |
| /tasks | 15.5 | 15.5 | 3.2 | 3.2 | 15.5 | 15.5 |
| /profile | 15 | 15 | 3.1 | 3.1 | 14.9 | 14.9 |

## Chunk

```json
{
 "coverage": "60/60",
 "chunks": [
  {
   "path": "/_next/static/chunks/43s8bbl2wzvin.js",
   "cacheControl": "public, max-age=31536000, immutable",
   "raw": 334302,
   "br5": 97682,
   "br11": 86074,
   "gzip": 104446
  }
 ],
 "preloadedInHtml": [
  true
 ],
 "second": {
  "/app": [
   {
    "url": "http://localhost:3611/_next/static/chunks/43s8bbl2wzvin.js",
    "status": 200,
    "fromCache": true,
    "cacheControl": "public, max-age=31536000, immutable",
    "bytes": 0
   }
  ],
  "/collection": [
   {
    "url": "http://localhost:3611/_next/static/chunks/43s8bbl2wzvin.js",
    "status": 200,
    "fromCache": true,
    "cacheControl": "public, max-age=31536000, immutable",
    "bytes": 0
   }
  ],
  "/customers": [
   {
    "url": "http://localhost:3611/_next/static/chunks/43s8bbl2wzvin.js",
    "status": 200,
    "fromCache": true,
    "cacheControl": "public, max-age=31536000, immutable",
    "bytes": 0
   }
  ]
 },
 "reload": {
  "http://localhost:3611/_next/static/chunks/43s8bbl2wzvin.js": {
   "status": 200,
   "fromCache": false
  }
 }
}
```

## Client JS per page (first visit, empty cache)

| route | variant | files | raw KB | br q5 KB | max English sentinels in one file |
|---|---|---|---|---|---|
| /login | mainHe | 22 | 1956.2 | 534.1 | 0 |
| /login | branchHe | 22 | 1956.5 | 534.1 | 0 |
| /login | mainEn | 24 | 2609 | 724.9 | 60 |
| /login | branchEn | 24 | 2609.4 | 724.9 | 60 |
| /app | mainHe | 12 | 1035.4 | 280.3 | 0 |
| /app | branchHe | 12 | 1035.5 | 280.3 | 0 |
| /app | mainEn | 13 | 1361.8 | 375.7 | 60 |
| /app | branchEn | 13 | 1362 | 375.7 | 60 |
| /collection | mainHe | 11 | 1004.3 | 275.6 | 0 |
| /collection | branchHe | 11 | 1004.4 | 275.6 | 0 |
| /collection | mainEn | 12 | 1330.7 | 371 | 60 |
| /collection | branchEn | 12 | 1330.9 | 371 | 60 |

## Timings (p50 ms, MAIN → BRANCH, flag ON)

| profile | width | locale | TTFB | FCP | LCP | DCL | load | doc transfer B |
|---|---|---|---|---|---|---|---|---|
| unthrottled | 390 | he | 12.7 → 12.7 | 272 → 304 | 240 → 236 | 49.6 → 47.6 | 151 → 131.2 | 39901 → 39901 |
| unthrottled | 390 | en | 12.5 → 12.9 | 224 → 268 | 232 → 224 | 50.5 → 45.9 | 131.1 → 136 | 39839 → 39839 |
| unthrottled | 820 | he | 13.2 → 13.5 | 192 → 244 | 244 → 240 | 50.4 → 51.4 | 138.7 → 129.9 | 39901 → 39901 |
| unthrottled | 820 | en | 9.6 → 9.3 | 140 → 152 | 172 → 192 | 35.6 → 34.2 | 95.3 → 91 | 39839 → 39839 |
| unthrottled | 1440 | he | 9.4 → 9.3 | 288 → 260 | 192 → 232 | 36.5 → 36.4 | 93.6 → 99.8 | 39901 → 39901 |
| unthrottled | 1440 | en | 9.5 → 9.4 | 324 → 124 | 236 → 240 | 38.1 → 33.6 | 107.8 → 103.8 | 39839 → 39839 |
| 4G | 390 | he | 9 → 8.6 | 168 → 172 | 224 → 220 | 85.4 → 92.4 | 151.7 → 154.3 | 39901 → 39901 |
| 4G | 390 | en | 8.9 → 8.4 | 208 → 160 | 244 → 228 | 94.3 → 90.6 | 152.2 → 152.3 | 39839 → 39839 |
| 4G | 820 | he | 8.3 → 8 | 168 → 180 | 228 → 232 | 90.5 → 88.6 | 149 → 143.1 | 39901 → 39901 |
| 4G | 820 | en | 8.3 → 8.7 | 168 → 160 | 232 → 232 | 88.6 → 94.5 | 153.9 → 156.8 | 39839 → 39839 |
| 4G | 1440 | he | 8.9 → 8.6 | 316 → 540 | 228 → 268 | 95.2 → 91.4 | 154.8 → 157.1 | 39901 → 39901 |
| 4G | 1440 | en | 10 → 9.9 | 216 → 200 | 276 → 276 | 94.8 → 93.2 | 170 → 172 | 39839 → 39839 |