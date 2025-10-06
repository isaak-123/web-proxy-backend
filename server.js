const express = require('express');
const request = require('request');
const cheerio = require('cheerio');
const url = require('url');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS headers for all responses
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Root route
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    message: 'Web Proxy Server',
    usage: 'GET /proxy?url=https://example.com'
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Get proxy base URL dynamically
function getProxyBase(req) {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${protocol}://${host}`;
}

// Rewrite URLs in content
function rewriteURL(originalUrl, baseUrl, proxyBase) {
  if (!originalUrl) return originalUrl;
  
  // Skip certain URL types
  if (originalUrl.startsWith('data:') || 
      originalUrl.startsWith('javascript:') || 
      originalUrl.startsWith('mailto:') ||
      originalUrl.startsWith('tel:') ||
      originalUrl === '#') {
    return originalUrl;
  }

  try {
    let absoluteUrl;
    
    // Convert relative URLs to absolute
    if (originalUrl.startsWith('//')) {
      absoluteUrl = 'https:' + originalUrl;
    } else if (originalUrl.startsWith('http://') || originalUrl.startsWith('https://')) {
      absoluteUrl = originalUrl;
    } else {
      absoluteUrl = url.resolve(baseUrl, originalUrl);
    }

    // Return proxied URL
    return `${proxyBase}/proxy?url=${encodeURIComponent(absoluteUrl)}`;
  } catch (e) {
    return originalUrl;
  }
}

// Rewrite HTML content
function rewriteHTML(html, baseUrl, proxyBase) {
  try {
    const $ = cheerio.load(html, { decodeEntities: false });

    // Remove problematic headers
    $('meta[http-equiv="Content-Security-Policy"]').remove();
    $('meta[http-equiv="X-Frame-Options"]').remove();

    // Rewrite links
    $('a[href], link[href]').each(function() {
      const href = $(this).attr('href');
      if (href) {
        $(this).attr('href', rewriteURL(href, baseUrl, proxyBase));
      }
    });

    // Rewrite images
    $('img[src], source[src]').each(function() {
      const src = $(this).attr('src');
      if (src) {
        $(this).attr('src', rewriteURL(src, baseUrl, proxyBase));
      }
    });

    // Rewrite srcset
    $('[srcset]').each(function() {
      const srcset = $(this).attr('srcset');
      if (srcset) {
        const newSrcset = srcset.split(',').map(s => {
          const parts = s.trim().split(/\s+/);
          parts[0] = rewriteURL(parts[0], baseUrl, proxyBase);
          return parts.join(' ');
        }).join(', ');
        $(this).attr('srcset', newSrcset);
      }
    });

    // Rewrite scripts
    $('script[src]').each(function() {
      const src = $(this).attr('src');
      if (src) {
        $(this).attr('src', rewriteURL(src, baseUrl, proxyBase));
      }
    });

    // Rewrite forms
    $('form[action]').each(function() {
      const action = $(this).attr('action');
      if (action) {
        $(this).attr('action', rewriteURL(action, baseUrl, proxyBase));
      }
    });

    // Rewrite iframes
    $('iframe[src]').each(function() {
      const src = $(this).attr('src');
      if (src) {
        $(this).attr('src', rewriteURL(src, baseUrl, proxyBase));
      }
    });

    // Rewrite video/audio sources
    $('video[src], audio[src]').each(function() {
      const src = $(this).attr('src');
      if (src) {
        $(this).attr('src', rewriteURL(src, baseUrl, proxyBase));
      }
    });

    return $.html();
  } catch (err) {
    console.error('HTML rewrite error:', err.message);
    return html;
  }
}

// Rewrite CSS
function rewriteCSS(css, baseUrl, proxyBase) {
  try {
    return css.replace(/url\s*\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote, urlPath) => {
      const newUrl = rewriteURL(urlPath.trim(), baseUrl, proxyBase);
      return `url(${quote}${newUrl}${quote})`;
    });
  } catch (err) {
    return css;
  }
}

// Main proxy endpoint
app.all('/proxy', (req, res) => {
  let targetUrl = req.query.url;

  if (!targetUrl) {
    return res.status(400).json({
      error: 'Missing URL parameter',
      usage: '/proxy?url=https://example.com'
    });
  }

  // Decode if needed
  try {
    targetUrl = decodeURIComponent(targetUrl);
  } catch (e) {}

  // Validate URL
  try {
    new URL(targetUrl);
  } catch (e) {
    return res.status(400).json({
      error: 'Invalid URL',
      provided: targetUrl
    });
  }

  console.log(`[${req.method}] Proxying: ${targetUrl}`);

  const proxyBase = getProxyBase(req);

  // Request options
  const options = {
    url: targetUrl,
    method: req.method,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': req.headers.accept || '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate',
    },
    encoding: null, // Get response as Buffer
    followRedirect: true,
    maxRedirects: 5,
    timeout: 30000,
    gzip: true
  };

  // Forward POST/PUT data
  if (req.method === 'POST' || req.method === 'PUT') {
    options.body = req.body;
    if (req.headers['content-type']) {
      options.headers['Content-Type'] = req.headers['content-type'];
    }
  }

  // Make the request
  proxyRequest(options, res, targetUrl, proxyBase);
});

// Catch-all route for direct navigation (like /results, /watch, etc)
app.all('*', (req, res) => {
  // Skip our defined routes
  if (req.path === '/' || req.path === '/health' || req.path === '/proxy') {
    return res.status(404).json({
      error: 'Not found',
      path: req.path,
      usage: '/proxy?url=https://example.com'
    });
  }

  // Try to reconstruct the original URL from referrer
  const referer = req.headers.referer || req.headers.referrer;
  
  if (!referer) {
    return res.status(400).json({
      error: 'Cannot determine target website',
      message: 'Direct navigation requires using /proxy?url=...',
      path: req.path
    });
  }

  // Extract the original URL from the referer
  try {
    const refererUrl = new URL(referer);
    const originalUrlParam = refererUrl.searchParams.get('url');
    
    if (originalUrlParam) {
      const originalUrl = new URL(originalUrlParam);
      const targetUrl = `${originalUrl.protocol}//${originalUrl.host}${req.path}${req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : ''}`;
      
      console.log(`[CATCHALL ${req.method}] Reconstructed: ${targetUrl}`);
      
      const proxyBase = getProxyBase(req);
      const options = {
        url: targetUrl,
        method: req.method,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': req.headers.accept || '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate',
          'Referer': originalUrlParam
        },
        encoding: null,
        followRedirect: true,
        maxRedirects: 5,
        timeout: 30000,
        gzip: true
      };

      if (req.method === 'POST' || req.method === 'PUT') {
        options.body = req.body;
        if (req.headers['content-type']) {
          options.headers['Content-Type'] = req.headers['content-type'];
        }
      }

      proxyRequest(options, res, targetUrl, proxyBase);
    } else {
      return res.status(400).json({
        error: 'Cannot determine original URL',
        path: req.path
      });
    }
  } catch (e) {
    console.error('Catchall error:', e.message);
    return res.status(400).json({
      error: 'Failed to process request',
      path: req.path,
      message: e.message
    });
  }
});

// Shared proxy request handler
function proxyRequest(options, res, targetUrl, proxyBase) {
  request(options, (error, response, body) => {
    if (error) {
      console.error('Request error:', error.message);
      return res.status(502).json({
        error: 'Failed to fetch URL',
        message: error.message
      });
    }

    if (!response) {
      return res.status(502).json({ error: 'No response from target' });
    }

    // Get content type
    const contentType = response.headers['content-type'] || '';

    // Set response headers
    res.status(response.statusCode);
    
    // Remove problematic headers
    Object.keys(response.headers).forEach(key => {
      const lowerKey = key.toLowerCase();
      if (lowerKey !== 'content-security-policy' &&
          lowerKey !== 'x-frame-options' &&
          lowerKey !== 'content-encoding' &&
          lowerKey !== 'transfer-encoding') {
        res.set(key, response.headers[key]);
      }
    });

    // Always set these
    res.set('Access-Control-Allow-Origin', '*');
    res.set('X-Frame-Options', 'ALLOWALL');

    try {
      // Handle HTML
      if (contentType.includes('text/html')) {
        const html = body.toString('utf-8');
        const rewritten = rewriteHTML(html, targetUrl, proxyBase);
        return res.send(rewritten);
      }

      // Handle CSS
      if (contentType.includes('text/css')) {
        const css = body.toString('utf-8');
        const rewritten = rewriteCSS(css, targetUrl, proxyBase);
        return res.send(rewritten);
      }

      // Handle JavaScript (pass through)
      if (contentType.includes('javascript') || contentType.includes('json')) {
        return res.send(body);
      }

      // Everything else (images, fonts, etc)
      res.send(body);

    } catch (e) {
      console.error('Processing error:', e.message);
      res.send(body);
    }
  });
}

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    path: req.path,
    usage: '/proxy?url=https://example.com'
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err.message);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message
  });
});

app.listen(PORT, () => {
  console.log(`✅ Proxy server running on port ${PORT}`);
});
