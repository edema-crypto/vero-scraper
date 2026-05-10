require('dotenv').config()
const express = require('express')
const { scrapeNafdac } = require('./scraper')

const app = express()
const PORT = process.env.PORT || 3001

app.use(express.json())

// --- Request logging ---
app.use((req, res, next) => {
  const start = Date.now()
  res.on('finish', () => {
    const ms = Date.now() - start
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} → ${res.statusCode} (${ms}ms)`)
  })
  next()
})

// --- Health check ---
app.get('/', (_req, res) => {
  res.json({ service: 'vero-scraper', status: 'ok' })
})

// --- Secret verification middleware ---
function verifySecret(req, res, next) {
  const secret = req.headers['x-scraper-secret'] || req.headers['authorization']?.replace('Bearer ', '')
  if (!secret || secret !== process.env.SCRAPER_SECRET) {
    console.warn(`[AUTH] Rejected request from ${req.ip} — invalid or missing secret`)
    return res.status(401).json({ ok: false, message: 'Unauthorized' })
  }
  next()
}

// --- Scrape endpoint ---
app.post('/scrape', verifySecret, async (req, res) => {
  const { nafdac_number } = req.body

  if (!nafdac_number) {
    return res.status(400).json({ ok: false, message: 'nafdac_number is required' })
  }

  console.log(`[SCRAPE] Starting scrape for NAFDAC number: ${nafdac_number}`)

  try {
    const result = await scrapeNafdac(nafdac_number)
    console.log(`[SCRAPE] ${nafdac_number} → ${result.ok ? 'SUCCESS' : 'FAILED'}: ${result.ok ? result.data?.product_name : result.message}`)
    return res.json(result)
  } catch (error) {
    console.error(`[SCRAPE] ${nafdac_number} → ERROR: ${error.message}`)
    return res.status(500).json({ ok: false, message: error.message })
  }
})

app.listen(PORT, () => {
  console.log(`\n🟢 Vero Scraper running on port ${PORT}`)
  console.log(`   POST /scrape — accepts { nafdac_number: "XX-XXXX" }`)
  console.log(`   2captcha: ${process.env.TWOCAPTCHA_API_KEY ? 'configured ✓' : 'not configured (stealth only)'}\n`)
})
