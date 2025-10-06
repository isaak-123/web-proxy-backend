const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3001;

// Enable CORS for all routes
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Root route
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Proxy server is running',
    usage: 'Use /proxy?url=https://example.com to proxy a website'
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Proxy server is healthy' });
});

// Catch-all proxy route to handle all paths
app.all('/proxy*', async (req, res) => {
  try {
    let targetUrl = req.query.url;
    
    // If no URL query param, check if path contains URL
    if (!targetUrl) {
      const pathUrl = req.path.replace('/proxy/', '').replace('/proxy', '');
      if (pathUrl && pathUrl.startsWith('http')) {
        targetUrl = pathUrl;
      }
    }
    
    if (!targetUrl) {
      return res.status(400).json({ 
        error: 'Missing URL parameter',
        usage: 'Use /proxy?url=https://example.com'
      });
    }

    // Decode if double-encoded
    try {
      targetUrl = decodeURIComponent(targetUrl);
    } catch (e) {
      // Already decoded
    }

    // Validate URL
    let parsedUrl;
    try {
      parsedUrl = new URL(targetUrl);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid URL format', receivedUrl: targetUrl });
    }

    console.log('Proxying:', targetUrl);

    // Fetch the target URL
    const method = req.method.toUpperCase();
    const response = await axios({
      method: method,
      url: targetUrl,
      data: method !== 'GET' ? req.body : undefined,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Referer': parsedUrl.origin,
        ...(req.headers['content-type'] && { 'Content-Type': req.headers['content-type'] })
      },
      maxRedirects: 5,
      validateStatus: () => true,
      responseType: 'arraybuffer',
      timeout: 15000
    });

    const contentType = response.headers['content-type'] || '';
    const data = response.data;

    // Set CORS headers
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    
    // Remove security headers that block iframes
    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');
    res.set('X-Frame-Options', 'ALLOWALL');

    // Handle different content types
    if (contentType.includes('text/html')) {
      try {
        const html = data.toString('utf-8');
        const rewrittenHtml = rewriteHtml(html, targetUrl);
        res.set('Content-Type', 'text/html; charset=utf-8');
        return res.send(rewrittenHtml);
      } catch (err) {
        console.error('HTML rewrite error:', err);
        res.set('Content-Type', contentType);
        return res.send(data);
      }
    }

    if (contentType.includes('text/css')) {
      try {
        const css = data.toString('utf-8');
        const rewrittenCss = rewriteCss(css, targetUrl);
        res.set('Content-Type', 'text/css; charset=utf-8');
        return res.send(rewrittenCss);
      } catch (err) {
        console.error('CSS rewrite error:', err);
        res.set('Content-Type', contentType);
        return res.send(data);
      }
    }

    // For everything else (images, JS, fonts, etc), pass through
    res.set('Content-Type', contentType);
    res.send(data);

  } catch (error) {
    console.error('Proxy error:', error.message);
    
    if (error.code === 'ENOTFOUND') {
      return res.status(404).json({ error: 'Website not found or unreachable' });
    }
    
    if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
      return res.status(504).json({ error: 'Request timeout - website took too long to respond' });
    }

    res.status(500).json({ 
      error: 'Proxy error',
      message: error.message 
    });
  }
});

// Handle POST requests for form submissions
app.post('/proxy', async (req, res) => {
  try {
    const targetUrl = req.query.url;
    
    if (!targetUrl) {
      return res.status(400).json({ error: 'Missing URL parameter' });
    }

    console.log('POST Proxying:', targetUrl);

    const response = await axios({
      method: 'POST',
      url: targetUrl,
      data: req.body,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Content-Type': req.headers['content-type'] || 'application/x-www-form-urlencoded',
      },
      maxRedirects: 5,
      validateStatus: () => true,
      responseType: 'arraybuffer',
      timeout: 15000
    });

    const contentType = response.headers['content-type'] || '';
    const data = response.data;

    res.set('Access-Control-Allow-Origin', '*');
    res.set('Content-Type', contentType);
    
    if (contentType.includes('text/html')) {
      const html = data.toString('utf-8');
      const rewrittenHtml = rewriteHtml(html, targetUrl);
      return res.send(rewrittenHtml);
    }

    res.send(data);

  } catch (error) {
    console.error('POST Proxy error:', error.message);
    res.status(500).json({ error: 'Proxy error', message: error.message });
  }
});

function rewriteUrl(originalUrl, baseUrl) {
  if (!originalUrl || originalUrl === '#' || originalUrl.startsWith('javascript:') || originalUrl.startsWith('data:') || originalUrl.startsWith('mailto:') || originalUrl.startsWith('tel:')) {
    return originalUrl;
  }

  try {
    let targetUrl;

    if (originalUrl.startsWith('http://') || originalUrl.startsWith('https://')) {
      targetUrl = originalUrl;
    } else if (originalUrl.startsWith('//')) {
      targetUrl = 'https:' + originalUrl;
    } else if (originalUrl.startsWith('/')) {
      const base = new URL(baseUrl);
      targetUrl = base.origin + originalUrl;
    } else {
      targetUrl = new URL(originalUrl, baseUrl).href;
    }

    return `/proxy?url=${encodeURIComponent(targetUrl)}`;
  } catch (e) {
    console.error('URL rewrite error:', e.message, 'for', originalUrl);
    return originalUrl;
  }
}

function rewriteHtml(html, baseUrl) {
  try {
    const $ = cheerio.load(html, {
      decodeEntities: false,
      xmlMode: false
    });

    // Add base tag
    if ($('base').length === 0) {
      $('head').prepend(`<base href="${baseUrl}">`);
    }

    // Rewrite all href attributes
    $('[href]').each((i, elem) => {
      const href = $(elem).attr('href');
      if (href) {
        $(elem).attr('href', rewriteUrl(href, baseUrl));
      }
    });

    // Rewrite all src attributes
    $('[src]').each((i, elem) => {
      const src = $(elem).attr('src');
      if (src) {
        $(elem).attr('src', rewriteUrl(src, baseUrl));
      }
    });

    // Rewrite srcset
    $('[srcset]').each((i, elem) => {
      const srcset = $(elem).attr('srcset');
      if (srcset) {
        const rewritten = srcset.split(',').map(s => {
          const parts = s.trim().split(/\s+/);
          if (parts[0]) {
            parts[0] = rewriteUrl(parts[0], baseUrl);
          }
          return parts.join(' ');
        }).join(', ');
        $(elem).attr('srcset', rewritten);
      }
    });

    // Rewrite form actions
    $('form[action]').each((i, elem) => {
      const action = $(elem).attr('action');
      if (action) {
        $(elem).attr('action', rewriteUrl(action, baseUrl));
      }
    });

    // Rewrite data attributes that might contain URLs
    $('[data-src], [data-url]').each((i, elem) => {
      const dataSrc = $(elem).attr('data-src');
      if (dataSrc) {
        $(elem).attr('data-src', rewriteUrl(dataSrc, baseUrl));
      }
      const dataUrl = $(elem).attr('data-url');
      if (dataUrl) {
        $(elem).attr('data-url', rewriteUrl(dataUrl, baseUrl));
      }
    });

    return $.html();
  } catch (err) {
    console.error('HTML parsing error:', err);
    return html;
  }
}

function rewriteCss(css, baseUrl) {
  try {
    return css.replace(/url\s*\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote, urlPath) => {
      const rewritten = rewriteUrl(urlPath.trim(), baseUrl);
      return `url(${quote}${rewritten}${quote})`;
    });
  } catch (err) {
    console.error('CSS rewrite error:', err);
    return css;
  }
}

// Handle OPTIONS for CORS preflight
app.options('*', cors());

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    error: 'Not found',
    message: 'Use /proxy?url=https://example.com to proxy a website',
    availableRoutes: ['/', '/health', '/proxy']
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

app.listen(PORT, () => {
  console.log(`✅ Proxy server running on port ${PORT}`);
  console.log(`📡 Health check: http://localhost:${PORT}/health`);
  console.log(`🌐 Usage: http://localhost:${PORT}/proxy?url=https://example.com`);
});
