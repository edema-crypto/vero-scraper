const puppeteer = require('puppeteer-extra')
const StealthPlugin = require('puppeteer-extra-plugin-stealth')
const RecaptchaPlugin = require('puppeteer-extra-plugin-recaptcha')
const cheerio = require('cheerio')

// Always use stealth
puppeteer.use(StealthPlugin())

// Conditionally add 2captcha solver
if (process.env.TWOCAPTCHA_API_KEY) {
  puppeteer.use(
    RecaptchaPlugin({
      provider: {
        id: '2captcha',
        token: process.env.TWOCAPTCHA_API_KEY,
      },
      visualFeedback: true,
    })
  )
}

const NAFDAC_URL = 'https://registration.nafdac.gov.ng/Home/VerifyProduct'
const SCRAPE_TIMEOUT = 30000 // 30 seconds

/**
 * Scrapes the NAFDAC verification portal for product details.
 * @param {string} nafdacNumber - NAFDAC registration number (e.g. "A7-0492")
 * @returns {Promise<object>} Structured result with product details
 */
async function scrapeNafdac(nafdacNumber) {
  let browser = null

  try {
    // Race the scrape against a timeout
    const result = await Promise.race([
      performScrape(nafdacNumber),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Scrape timed out after 30 seconds')), SCRAPE_TIMEOUT)
      ),
    ])
    return result
  } catch (error) {
    return {
      ok: false,
      message: error.message || 'Unknown scraping error',
    }
  }
}

async function performScrape(nafdacNumber) {
  let browser = null

  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
      ],
    })

    const page = await browser.newPage()

    // Set a realistic user agent
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    )

    // Set viewport
    await page.setViewport({ width: 1280, height: 800 })

    // Navigate to NAFDAC verification page
    console.log(`[SCRAPER] Navigating to NAFDAC portal...`)
    await page.goto(NAFDAC_URL, {
      waitUntil: 'networkidle2',
      timeout: 20000,
    })

    // Wait for the form to be present
    await page.waitForSelector('#CertificateNumber, input[name="CertificateNumber"]', {
      timeout: 10000,
    })

    // Fill the certificate number field
    console.log(`[SCRAPER] Filling form with: ${nafdacNumber}`)
    const inputSelector = '#CertificateNumber, input[name="CertificateNumber"]'
    await page.click(inputSelector, { clickCount: 3 }) // Select any existing text
    await page.type(inputSelector, nafdacNumber, { delay: 50 })

    // Check if there's a captcha and try to solve it
    const hasCaptcha = await page.$('.g-recaptcha, #recaptcha, iframe[src*="recaptcha"]')
    if (hasCaptcha) {
      console.log(`[SCRAPER] Captcha detected`)
      if (process.env.TWOCAPTCHA_API_KEY) {
        console.log(`[SCRAPER] Attempting to solve captcha with 2captcha...`)
        try {
          const { solved } = await page.solveRecaptchas()
          console.log(`[SCRAPER] Captcha solve result: ${solved ? 'solved' : 'failed'}`)
        } catch (captchaError) {
          console.warn(`[SCRAPER] Captcha solving failed: ${captchaError.message}`)
          return { ok: false, message: 'Captcha solving failed. Please try again.' }
        }
      } else {
        return { ok: false, message: 'Captcha detected but no solver configured.' }
      }
    }

    // Submit the form
    console.log(`[SCRAPER] Submitting form...`)
    const submitSelector = 'button[type="submit"], input[type="submit"], #btnVerify, .btn-primary'
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => null),
      page.click(submitSelector),
    ])

    // Wait a moment for any dynamic content
    await new Promise((r) => setTimeout(r, 2000))

    // Get the page content
    const html = await page.content()

    // Parse with cheerio
    const result = parseResults(html, nafdacNumber)
    return result
  } catch (error) {
    // If it's a navigation error, the portal might be down
    if (error.message.includes('net::') || error.message.includes('Navigation timeout')) {
      return { ok: false, message: 'NAFDAC portal is currently unavailable. Please try again later.' }
    }
    throw error
  } finally {
    if (browser) {
      try {
        await browser.close()
      } catch (closeError) {
        console.error(`[SCRAPER] Failed to close browser: ${closeError.message}`)
      }
    }
  }
}

/**
 * Parses the NAFDAC response HTML using cheerio to extract product details.
 */
function parseResults(html, nafdacNumber) {
  const $ = cheerio.load(html)

  // Check for "no results" or error messages
  const bodyText = $('body').text().toLowerCase()
  if (
    bodyText.includes('no record found') ||
    bodyText.includes('not found') ||
    bodyText.includes('no result') ||
    bodyText.includes('invalid certificate')
  ) {
    return { ok: false, message: 'Product not found in NAFDAC registry.' }
  }

  // Try multiple strategies to extract data

  // Strategy 1: Look for table rows with label/value pairs
  let productName = ''
  let manufacturer = ''
  let registrationStatus = ''
  let dateRegistered = ''
  let expiryDate = ''
  let productCategory = ''

  // Check for table-based layout
  $('table tr, .table tr').each((_, row) => {
    const cells = $(row).find('td, th')
    if (cells.length >= 2) {
      const label = $(cells[0]).text().trim().toLowerCase()
      const value = $(cells[1]).text().trim()

      if (label.includes('product name') || label.includes('product')) {
        productName = productName || value
      }
      if (label.includes('manufacturer') || label.includes('company')) {
        manufacturer = manufacturer || value
      }
      if (label.includes('status') || label.includes('registration status')) {
        registrationStatus = registrationStatus || value
      }
      if (label.includes('date registered') || label.includes('registration date') || label.includes('date of registration')) {
        dateRegistered = dateRegistered || value
      }
      if (label.includes('expiry') || label.includes('expiration')) {
        expiryDate = expiryDate || value
      }
      if (label.includes('category') || label.includes('product category') || label.includes('type')) {
        productCategory = productCategory || value
      }
    }
  })

  // Strategy 2: Look for definition lists or labeled divs
  if (!productName) {
    $('dl dt, .form-group label, label, .field-label, .detail-label').each((_, el) => {
      const label = $(el).text().trim().toLowerCase()
      const valueEl = $(el).next('dd, .form-control-static, span, .field-value, .detail-value, p')
      const value = valueEl.text().trim()

      if (!value) return

      if (label.includes('product name') || label.includes('product')) {
        productName = productName || value
      }
      if (label.includes('manufacturer') || label.includes('company')) {
        manufacturer = manufacturer || value
      }
      if (label.includes('status')) {
        registrationStatus = registrationStatus || value
      }
      if (label.includes('date registered') || label.includes('registration date')) {
        dateRegistered = dateRegistered || value
      }
      if (label.includes('expiry') || label.includes('expiration')) {
        expiryDate = expiryDate || value
      }
      if (label.includes('category') || label.includes('type')) {
        productCategory = productCategory || value
      }
    })
  }

  // If we found at least a product name or manufacturer, consider it a success
  if (productName || manufacturer || registrationStatus) {
    return {
      ok: true,
      data: {
        nafdac_number: nafdacNumber,
        product_name: productName || null,
        manufacturer: manufacturer || null,
        registration_status: registrationStatus || null,
        date_registered: dateRegistered || null,
        expiry_date: expiryDate || null,
        product_category: productCategory || null,
      },
    }
  }

  // Nothing extracted — might be unexpected HTML structure
  console.warn(`[SCRAPER] Could not extract data. Page title: "${$('title').text()}"`)
  return {
    ok: false,
    message: 'Could not extract product details from NAFDAC response. The portal may have changed its layout.',
  }
}

module.exports = { scrapeNafdac }
