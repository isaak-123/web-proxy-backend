const express = require('express');
const request = require('request');
const cheerio = require('cheerio');
const url = require('url');

const app = express();
const PORT = process.env.PORT || 5000;

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

// Rewrite URLs in content - using path-based encoding for self-describing URLs
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

    // Parse the absolute URL
    const parsedUrl = new URL(absoluteUrl);
    
    // Encode URL as path: /proxy/{protocol}/{host}{path}{search}{hash}
    // This makes URLs self-describing without relying on referers
    const protocol = parsedUrl.protocol.replace(':', ''); // http or https
    const encodedPath = `${proxyBase}/proxy/${protocol}/${parsedUrl.host}${parsedUrl.pathname}${parsedUrl.search}${parsedUrl.hash}`;
    
    return encodedPath;
  } catch (e) {
    return originalUrl;
  }
}

// Rewrite HTML content
function rewriteHTML(html, baseUrl, proxyBase) {
  try {
    const $ = cheerio.load(html, { decodeEntities: false });

    // Remove problematic headers and policies
    $('meta[http-equiv="Content-Security-Policy"]').remove();
    $('meta[http-equiv="X-Frame-Options"]').remove();
    $('meta[name="referrer"]').remove();  // Remove referrer policy meta tags

    // Add permissive referrer policy and base tag for relative URLs
    const parsedBase = new URL(baseUrl);
    const proxyBasePath = `${proxyBase}/proxy/${parsedBase.protocol.replace(':', '')}/${parsedBase.host}`;

    $('head').prepend(`
      <meta name="referrer" content="unsafe-url">
      <base href="${proxyBasePath}/">
    `);

    // Inject JavaScript to intercept navigation and fetch requests
    const injectedScript = `
      <script>
        (function() {
          const proxyBase = '${proxyBase}';
          const currentProtocol = '${parsedBase.protocol.replace(':', '')}';
          const currentHost = '${parsedBase.host}';

          // Function to convert URL to proxy format
          function toProxyURL(url) {
            try {
              if (!url || url.startsWith('data:') || url.startsWith('javascript:') ||
                  url.startsWith('mailto:') || url.startsWith('tel:') || url === '#') {
                return url;
              }

              let absoluteUrl;
              if (url.startsWith('//')) {
                absoluteUrl = 'https:' + url;
              } else if (url.startsWith('http://') || url.startsWith('https://')) {
                absoluteUrl = url;
              } else if (url.startsWith('/')) {
                absoluteUrl = currentProtocol + '://' + currentHost + url;
              } else {
                return url; // Let base tag handle it
              }

              const parsed = new URL(absoluteUrl);
              const protocol = parsed.protocol.replace(':', '');
              return proxyBase + '/proxy/' + protocol + '/' + parsed.host + parsed.pathname + parsed.search + parsed.hash;
            } catch (e) {
              return url;
            }
          }

          // Intercept fetch
          const originalFetch = window.fetch;
          window.fetch = function(url, options) {
            const proxiedUrl = toProxyURL(url);
            return originalFetch(proxiedUrl, options);
          };

          // Intercept XMLHttpRequest
          const originalOpen = XMLHttpRequest.prototype.open;
          XMLHttpRequest.prototype.open = function(method, url, ...args) {
            const proxiedUrl = toProxyURL(url);
            return originalOpen.call(this, method, proxiedUrl, ...args);
          };
        })();
      </script>
    `;

    $('head').prepend(injectedScript);

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

// Main proxy endpoint - handles both query-based (?url=) and path-based (/protocol/host/path)
app.all('/proxy/:protocol?/:host?/*?', (req, res) => {
  let targetUrl = null;
  
  // Check if using new path-based format: /proxy/https/example.com/path
  if (req.params.protocol && req.params.host) {
    const protocol = req.params.protocol;
    const host = req.params.host;
    
    // Use originalUrl to preserve exact query string and encoded characters
    const originalPath = req.originalUrl;
    const proxyPrefix = `/proxy/${protocol}/${host}`;
    
    // Extract everything after /proxy/protocol/host to preserve exact encoding
    let pathAndQuery = '/';
    const prefixIndex = originalPath.indexOf(proxyPrefix);
    if (prefixIndex !== -1) {
      pathAndQuery = originalPath.substring(prefixIndex + proxyPrefix.length) || '/';
    }
    
    targetUrl = `${protocol}://${host}${pathAndQuery}`;
  }
  // Fall back to query-based format: /proxy?url=https://example.com
  else if (req.query.url) {
    targetUrl = req.query.url;
    try {
      targetUrl = decodeURIComponent(targetUrl);
    } catch (e) {}
  }

  if (!targetUrl) {
    return res.status(400).json({
      error: 'Missing URL',
      usage: '/proxy?url=https://example.com OR /proxy/https/example.com/path'
    });
  }

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

// Catch-all route - handles dynamic JS requests (fetch, XHR, forms) by extracting origin from referer
app.all('*', (req, res) => {
  // Try to extract origin from referer for JavaScript-generated requests
  const referer = req.headers.referer || req.headers.referrer;

  if (referer) {
    try {
      const refererUrl = new URL(referer);

      // Check if referer is a proxied URL in path format: /proxy/https/example.com/...
      const pathMatch = refererUrl.pathname.match(/^\/proxy\/(https?)\/([\w.-]+(?:\:\d+)?)(\/.*)?$/);

      if (pathMatch) {
        const [, protocol, host] = pathMatch;
        const targetUrl = `${protocol}://${host}${req.path}${req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : ''}`;

        console.log(`[CATCHALL ${req.method}] JS request reconstructed: ${targetUrl}`);

        const proxyBase = getProxyBase(req);
        const options = {
          url: targetUrl,
          method: req.method,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': req.headers.accept || '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate',
            'Referer': `${protocol}://${host}`
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

        return proxyRequest(options, res, targetUrl, proxyBase);
      }

      // Also check if referer contains query-based format: ?url=https://example.com
      const urlParam = refererUrl.searchParams.get('url');
      if (urlParam && refererUrl.pathname.includes('/proxy')) {
        try {
          const baseUrl = new URL(urlParam);
          const targetUrl = `${baseUrl.protocol}//${baseUrl.host}${req.path}${req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : ''}`;

          console.log(`[CATCHALL ${req.method}] JS request reconstructed from query: ${targetUrl}`);

          const proxyBase = getProxyBase(req);
          const options = {
            url: targetUrl,
            method: req.method,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Accept': req.headers.accept || '*/*',
              'Accept-Language': 'en-US,en;q=0.9',
              'Accept-Encoding': 'gzip, deflate',
              'Referer': `${baseUrl.protocol}//${baseUrl.host}`
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

          return proxyRequest(options, res, targetUrl, proxyBase);
        } catch (e) {
          console.error('Query-based catchall error:', e.message);
        }
      }
    } catch (e) {
      console.error('Catchall referer parse error:', e.message);
    }
  }

  // No valid referer found
  console.log(`[CATCHALL FAILED] No valid referer for ${req.method} ${req.path}`);
  res.status(404).json({
    error: 'Not found',
    path: req.path,
    message: 'This path requires a valid referer. Use /proxy?url=https://example.com or /proxy/https/example.com/path to start browsing.'
  });
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
          lowerKey !== 'transfer-encoding' &&
          lowerKey !== 'referrer-policy') {  // Remove strict referrer policies
        res.set(key, response.headers[key]);
      }
    });

    // Always set these
    res.set('Access-Control-Allow-Origin', '*');
    res.set('X-Frame-Options', 'ALLOWALL');
    // Set a permissive referrer policy to ensure referers are sent
    res.set('Referrer-Policy', 'unsafe-url');

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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Proxy server running on http://0.0.0.0:${PORT}`);
});
