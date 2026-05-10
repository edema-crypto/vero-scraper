# vero-scraper

scrapes the nafdac product verification portal so we don't have to do it manually.

there's no public nafdac api, so this service opens a headless chrome browser, goes to their website, types in the registration number, hits submit, and reads what comes back. puppeteer-extra with the stealth plugin handles the bot detection stuff — fingers crossed it doesn't get blocked.

## how it works

1. receives a nafdac number via POST request
2. launches headless chrome with stealth mode
3. goes to `https://registration.nafdac.gov.ng/Home/VerifyProduct`
4. fills in the certificate number field, submits the form
5. parses the result page with cheerio
6. returns product name, manufacturer, status, dates, category as json

if the site throws a captcha and you have a 2captcha key set up, it'll try to solve it. otherwise it just fails gracefully. stealth mode usually handles it though.

## running locally

```bash
npm install
cp .env.example .env
# put your scraper secret in .env
npm start
```

runs on port 3001 by default.

## the endpoint

**POST /scrape**

headers:
```
Content-Type: application/json
x-scraper-secret: whatever-you-set-in-env
```

body:
```json
{ "nafdac_number": "01-0492" }
```

returns something like:
```json
{
  "ok": true,
  "data": {
    "nafdac_number": "01-0492",
    "product_name": "some product",
    "manufacturer": "some company ltd",
    "registration_status": "Active",
    "date_registered": "2020-01-15",
    "expiry_date": "2025-01-15",
    "product_category": "Drug"
  }
}
```

or if it can't find anything:
```json
{ "ok": false, "message": "Product not found in NAFDAC registry." }
```

## env vars

- `SCRAPER_SECRET` — shared secret with the main vero app. just make something up, same value goes in both places
- `TWOCAPTCHA_API_KEY` — optional. only if stealth isn't enough and captchas start showing up
- `PORT` — defaults to 3001

## deploying to railway

push this to its own github repo, connect it to railway, add the env vars in the dashboard. railway picks up the Procfile automatically. the url it gives you goes into `SCRAPER_API_URL` in your next.js app's `.env.local`.

## things to know

- browser always gets closed even if something crashes (finally block)
- each scrape times out after 30 seconds so nothing hangs forever
- if nafdac's site is down or changes their html layout, it'll return a clean error instead of blowing up
