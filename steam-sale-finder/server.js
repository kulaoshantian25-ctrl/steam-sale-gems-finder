const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3456;
const CACHE_FILE = path.join(__dirname, 'sales_cache.json');
const CACHE_DURATION_MS = 6 * 60 * 60 * 1000; // 6 hours
let fetchPromise = null;

// Helper to fetch one page of Steam search
async function fetchSteamSearchPage(start = 0, sortBy = 'Reviews_DESC') {
  let url = `https://store.steampowered.com/search/results/?query&start=${start}&count=50&specials=1&snr=1_7_7_7000_7&cc=jp`;
  if (sortBy === 'Reviews_DESC') {
    url += '&sort_by=Reviews_DESC';
  } else if (sortBy === 'topsellers') {
    url += '&filter=topsellers';
  }

  const res = await fetch(url, {
    headers: {
      'Accept-Language': 'en-US,en;q=0.9',
      'Cookie': 'steamCountry=JP%7C00000000000000000000000000000000',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    }
  });

  if (!res.ok) {
    throw new Error(`Steam search returned status ${res.status}`);
  }

  const html = await res.text();
  const rowRegex = /<a href="https:\/\/store\.steampowered\.com\/app\/(\d+)\/([^"?]*)[^"]*"[\s\S]*?class="[^"]*search_result_row[\s\S]*?<\/a>/g;
  let match;
  const items = [];

  while ((match = rowRegex.exec(html)) !== null) {
    const [full, appId, slug] = match;
    const titleMatch = full.match(/<span class="title">([^<]+)<\/span>/);
    const discountMatch = full.match(/<div class="discount_pct">(-?\d+)%<\/div>/);
    const origPriceMatch = full.match(/<div class="discount_original_price">([^<]+)<\/div>/);
    const finalPriceMatch = full.match(/<div class="discount_final_price">([^<]+)<\/div>/);
    const reviewMatch = full.match(/data-tooltip-html="([^"]+)"/);
    const imgMatch = full.match(/<img src="([^"]+)"/);

    let reviewPercent = null;
    let reviewCount = null;
    let reviewSentiment = null;
    if (reviewMatch) {
      const tooltip = reviewMatch[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
      const pctCountMatch = tooltip.match(/(\d+)%\s+of the\s+([\d,]+)\s+user reviews/i);
      if (pctCountMatch) {
        reviewPercent = parseInt(pctCountMatch[1], 10);
        reviewCount = parseInt(pctCountMatch[2].replace(/,/g, ''), 10);
      }
      const sentMatch = tooltip.match(/^([^<]+)/);
      if (sentMatch) {
        reviewSentiment = sentMatch[1].trim();
      }
    }

    const discount = discountMatch ? Math.abs(parseInt(discountMatch[1], 10)) : 0;
    
    // Parse numeric final price for sorting
    let numPrice = null;
    if (finalPriceMatch) {
      const cleanPrice = finalPriceMatch[1].replace(/[^\d]/g, '');
      if (cleanPrice) numPrice = parseInt(cleanPrice, 10);
    }

    items.push({
      appId,
      title: titleMatch ? titleMatch[1].trim() : slug,
      discount,
      origPrice: origPriceMatch ? origPriceMatch[1].trim() : '',
      finalPrice: finalPriceMatch ? finalPriceMatch[1].trim() : '',
      numPrice,
      reviewPercent,
      reviewCount,
      reviewSentiment,
      img: imgMatch ? imgMatch[1] : `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`,
      storeUrl: `https://store.steampowered.com/app/${appId}/`
    });
  }

  return items;
}

// Fetch all sale games in batches
async function fetchAllSales(force = false) {
  if (!force && fs.existsSync(CACHE_FILE)) {
    try {
      const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (Date.now() - cached.timestamp < CACHE_DURATION_MS) {
        console.log(`Using cached sales data (${cached.items.length} items, cached at ${new Date(cached.timestamp).toLocaleTimeString()})`);
        return cached;
      }
    } catch (e) {
      console.error('Failed reading cache:', e);
    }
  }

  if (fetchPromise) {
    console.log('Fetch already in progress, waiting for existing operation...');
    return fetchPromise;
  }

  fetchPromise = (async () => {
    console.log('Fetching fresh sale data from Steam (deep sweep)...');
    const appMap = new Map();

    // Fetch top pages of Reviews_DESC (expanded to 28 pages = 1,400 items)
    for (let page = 0; page < 28; page++) {
      const start = page * 50;
      try {
        console.log(`Fetching Reviews_DESC page ${page + 1}/28 (start=${start})...`);
        const items = await fetchSteamSearchPage(start, 'Reviews_DESC');
        for (const item of items) {
          if (!appMap.has(item.appId)) {
            appMap.set(item.appId, item);
          }
        }
        await new Promise(r => setTimeout(r, 200));
      } catch (e) {
        console.error(`Error on Reviews_DESC page ${page}:`, e.message);
      }
    }

    // Fetch top pages of Topsellers (expanded to 12 pages = 600 items)
    for (let page = 0; page < 12; page++) {
      const start = page * 50;
      try {
        console.log(`Fetching topsellers page ${page + 1}/12 (start=${start})...`);
        const items = await fetchSteamSearchPage(start, 'topsellers');
        for (const item of items) {
          if (!appMap.has(item.appId)) {
            appMap.set(item.appId, item);
          }
        }
        await new Promise(r => setTimeout(r, 200));
      } catch (e) {
        console.error(`Error on topsellers page ${page}:`, e.message);
      }
    }

    const allItems = Array.from(appMap.values());
    const cacheData = {
      timestamp: Date.now(),
      items: allItems
    };

    try {
      fs.writeFileSync(CACHE_FILE, JSON.stringify(cacheData, null, 2), 'utf8');
      console.log(`Saved ${allItems.length} items to cache file.`);
    } catch (e) {
      console.error('Failed writing cache:', e);
    }

    return cacheData;
  })().finally(() => {
    fetchPromise = null;
  });

  return fetchPromise;
}

// Fetch wishlist and owned games via Steam API
async function fetchSteamAccountData(steamId, apiKey) {
  const result = {
    wishlistAppIds: [],
    ownedAppIds: [],
    error: null
  };

  try {
    // 1. Wishlist
    const wlUrl = apiKey
      ? `https://api.steampowered.com/IWishlistService/GetWishlist/v1/?key=${apiKey}&steamid=${steamId}`
      : `https://api.steampowered.com/IWishlistService/GetWishlist/v1/?steamid=${steamId}`;
    
    const wlRes = await fetch(wlUrl);
    if (wlRes.ok) {
      const wlData = await wlRes.json();
      if (wlData.response && Array.isArray(wlData.response.items)) {
        result.wishlistAppIds = wlData.response.items.map(i => String(i.appid));
      }
    }

    // 2. Owned Games (requires API key)
    if (apiKey) {
      const ownedUrl = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${apiKey}&steamid=${steamId}&include_appinfo=0`;
      const ownedRes = await fetch(ownedUrl);
      if (ownedRes.ok) {
        const ownedData = await ownedRes.json();
        if (ownedData.response && Array.isArray(ownedData.response.games)) {
          result.ownedAppIds = ownedData.response.games.map(g => String(g.appid));
        }
      }
    }
  } catch (err) {
    result.error = err.message;
  }

  return result;
}

const MIME_TYPES = {
  '.html': 'text/html; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.js': 'application/javascript; charset=UTF-8',
  '.json': 'application/json; charset=UTF-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // API: Get Sales
  if (pathname === '/api/sales') {
    const force = parsedUrl.searchParams.get('refresh') === 'true';
    try {
      const data = await fetchAllSales(force);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // API: Fetch Wishlist & Owned Games
  if (pathname === '/api/account' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { steamId, apiKey } = JSON.parse(body || '{}');
        if (!steamId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'steamId is required' }));
          return;
        }
        const data = await fetchSteamAccountData(steamId, apiKey);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify(data));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Static File Serving
  let filePath = path.join(__dirname, 'public', pathname === '/' ? 'index.html' : pathname);
  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=UTF-8' });
        res.end('404 Not Found');
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=UTF-8' });
        res.end(`Server Error: ${err.code}`);
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Steam Sale Finder running at http://localhost:${PORT}`);
});
