# Google Trends Scraper Pro: Keyword Research & SEO Analysis

Get Google Trends data for any number of keywords:

- interest over time;
- interest by state, metro area (DMA) or city;
- related queries and related topics, both top and rising;
- a trend summary;
- today's trending searches for any country.

You can compare more than 5 keywords on **one shared 0–100 scale**, which the Google Trends website cannot do.

## What you get

| Field | Description |
|---|---|
| `keyword`, `success` | The keyword, and whether Google has data for it |
| `interest_over_time` | `{dates, values}` on Google's 0–100 scale (`partial_last_point: true` when the last week or day is still running) |
| `interest_by_region` | `[{region, geo_code, value}]`, busiest first (cities include `coordinates`) |
| `related_queries` | `{top, rising}`: `query`, `value` (number or `"Breakout"`), `formatted_value`, `link` |
| `related_topics` | `{top, rising}`: `topic`, `topic_type`, `mid`, `value`, `link`, plus `related_topics_status` |
| `summary` | `avg_interest`, `peak_interest`, `peak_date`, `latest_interest`, `change_pct`, `trend_direction` (rising / stable / falling) |
| `explore_url` | Opens the same view on trends.google.com |
| Trending rows | `country`, `rank`, `query`, `approx_traffic`, `traffic_min`, `started_at`, `picture`, `news[]` |

## Features beyond the basic scraper

- **Compare all keywords together.** With **Keyword mode = together**, keywords are fetched in batches of 5 that share an anchor keyword, then rescaled so every keyword sits on one 0–100 scale (values keep 2 decimals, so small keywords don't round to 0).
- **More filters.** Any country or region (`US`, `US-CA`, `united_states`, `uk`), category by name or ID (`food & drink` = 71), and search type (web, YouTube, news, images or Google Shopping).
- **Flexible timeframes.** Google's own strings (`today 3-m`, `now 7-d`), short forms (`90d`, `12m`, `5y`) or custom dates (`2024-01-01 2024-06-30`).
- **Choose the region level:** state, metro (DMA), city or country.
- **Related topics.** Google hides related topics from datacenter IPs. When that happens, the actor retries through a residential IP, and `related_topics_status` tells you the outcome (`ok`, `empty` or `withheld_by_google`).
- **Trending now** for several countries in one run, including traffic estimates and news links.
- **You pay only for real results.** Keywords without data and error rows are free.

## Input example

```json
{
  "keywords": ["ChatGPT", "Claude", "Gemini"],
  "timeframe": "today 3-m",
  "geo": "US",
  "compareMode": "together",
  "regionResolution": "auto",
  "includeTrending": true,
  "trendingCountry": "united_states, india"
}
```

## Pricing

Pay per result: one keyword with data, or one trending search. Rows without data are free. Use **Maximum cost per run** to cap spending; the run stops cleanly when it reaches the limit.

## Run summary

Each run saves `RUN_SUMMARY` to the key-value store. It records:

- settings and stop reason;
- rows and charges;
- related topics withheld or recovered;
- requests and blocks;
- the proxy routes used.

## Tips

- Results for low-volume keywords can come back as all zeros. Widen the timeframe or the location.
- Google rate-limits busy IPs. The actor slows down, rotates sessions and switches proxy route automatically.
