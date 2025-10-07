const express = require('express');
const request = require('request');
const cheerio = require('cheerio');
const url = require('url');
const iconv = require('iconv-lite');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS headers for all responses
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin, Cookie, Set-Cookie');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Expose-Headers', 'Set-Cookie, Content-Length, Content-Type');

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

// Detect charset from Content-Type header
function detectCharsetFromContentType(contentType) {
  if (!contentType) return null;

  const charsetMatch = contentType.match(/charset=([^;]+)/i);
  if (charsetMatch) {
    return charsetMatch[1].trim().replace(/['"]/g, '');
  }
  return null;
}

// Detect charset from HTML content
function detectCharsetFromHTML(buffer) {
  // Try to read the first 1024 bytes as ASCII to look for meta tags
  const htmlStart = buffer.slice(0, 1024).toString('ascii');

  // Look for <meta charset="...">
  const charsetMatch = htmlStart.match(/<meta[^>]+charset=["']?([^"'\s>]+)/i);
  if (charsetMatch) {
    return charsetMatch[1].trim();
  }

  // Look for <meta http-equiv="Content-Type" content="...">
  const httpEquivMatch = htmlStart.match(/<meta[^>]+http-equiv=["']?Content-Type["']?[^>]+content=["']?[^"'>]*charset=([^"'\s;>]+)/i);
  if (httpEquivMatch) {
    return httpEquivMatch[1].trim();
  }

  return null;
}

// Convert buffer to string using detected charset
function decodeBuffer(buffer, contentType) {
  // Try Content-Type header first
  let charset = detectCharsetFromContentType(contentType);
  console.log(`[CHARSET] Content-Type: ${contentType}, detected from header: ${charset}`);

  // If it's HTML and no charset in header, check HTML meta tags
  if (!charset && contentType && contentType.includes('text/html')) {
    charset = detectCharsetFromHTML(buffer);
    console.log(`[CHARSET] Detected from HTML meta: ${charset}`);
  }

  // Default to UTF-8
  if (!charset) {
    charset = 'utf-8';
    console.log(`[CHARSET] No charset detected, using default: utf-8`);
  }

  // Normalize charset name
  const originalCharset = charset;
  charset = charset.toLowerCase().replace(/[_]/g, '-');

  // Handle common aliases
  const charsetAliases = {
    'iso-8859-1': 'latin1',
    'iso8859-1': 'latin1',
    'windows-1252': 'cp1252',
    'utf8': 'utf-8'
  };

  charset = charsetAliases[charset] || charset;
  console.log(`[CHARSET] Using charset: ${charset} (original: ${originalCharset})`);

  try {
    // Check if iconv-lite supports this encoding
    if (iconv.encodingExists(charset)) {
      const decoded = iconv.decode(buffer, charset);
      console.log(`[CHARSET] Successfully decoded ${buffer.length} bytes using ${charset}`);
      return decoded;
    } else {
      console.warn(`[CHARSET] Unsupported charset: ${charset}, falling back to UTF-8`);
      return buffer.toString('utf-8');
    }
  } catch (e) {
    console.error(`[CHARSET] Error decoding with charset ${charset}:`, e.message);
    return buffer.toString('utf-8');
  }
}

// Rewrite URLs in content - using path-based encoding for self-describing URLs
function rewriteURL(originalUrl, baseUrl, proxyBase) {
  if (!originalUrl) return originalUrl;

  // Trim whitespace
  originalUrl = originalUrl.trim();
  if (!originalUrl) return originalUrl;

  // Skip certain URL types
  if (originalUrl.startsWith('data:') ||
      originalUrl.startsWith('javascript:') ||
      originalUrl.startsWith('mailto:') ||
      originalUrl.startsWith('tel:') ||
      originalUrl === '#' ||
      originalUrl.startsWith('blob:')) {
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
    console.error(`Failed to rewrite URL: ${originalUrl}`, e.message);
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

    // Add permissive referrer policy
    const parsedBase = new URL(baseUrl);

    $('head').prepend(`
      <meta name="referrer" content="unsafe-url">
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
                  url.startsWith('mailto:') || url.startsWith('tel:') || url === '#' ||
                  url.startsWith('blob:') || url.startsWith('about:')) {
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

          // Intercept fetch with credentials support
          const originalFetch = window.fetch;
          window.fetch = function(url, options) {
            const proxiedUrl = toProxyURL(url);
            // Ensure credentials are included for social media APIs
            const modifiedOptions = options || {};
            if (!modifiedOptions.credentials) {
              modifiedOptions.credentials = 'include';
            }
            return originalFetch(proxiedUrl, modifiedOptions);
          };

          // Intercept XMLHttpRequest with credentials
          const originalOpen = XMLHttpRequest.prototype.open;
          XMLHttpRequest.prototype.open = function(method, url, ...args) {
            const proxiedUrl = toProxyURL(url);
            return originalOpen.call(this, method, proxiedUrl, ...args);
          };

          // Set withCredentials for all XHR requests
          const originalSend = XMLHttpRequest.prototype.send;
          XMLHttpRequest.prototype.send = function(...args) {
            this.withCredentials = true;
            return originalSend.apply(this, args);
          };

          // Intercept form submissions
          document.addEventListener('DOMContentLoaded', function() {
            document.addEventListener('submit', function(e) {
              const form = e.target;
              if (form.tagName === 'FORM') {
                let action = form.getAttribute('action');
                // If no action, form submits to current page
                if (!action || action === '') {
                  action = window.location.pathname + window.location.search;
                }
                const proxiedAction = toProxyURL(action);
                console.log('[Form Submit]', action, '->', proxiedAction);
                form.setAttribute('action', proxiedAction);
              }
            }, true);
          });

          // Intercept dynamic script/image loading
          const observer = new MutationObserver(function(mutations) {
            mutations.forEach(function(mutation) {
              mutation.addedNodes.forEach(function(node) {
                if (node.tagName === 'SCRIPT' && node.src) {
                  const originalSrc = node.src;
                  const proxiedSrc = toProxyURL(originalSrc);
                  if (originalSrc !== proxiedSrc) {
                    node.src = proxiedSrc;
                  }
                } else if (node.tagName === 'IMG' && node.src) {
                  const originalSrc = node.src;
                  const proxiedSrc = toProxyURL(originalSrc);
                  if (originalSrc !== proxiedSrc) {
                    node.src = proxiedSrc;
                  }
                } else if (node.tagName === 'LINK' && node.href) {
                  const originalHref = node.href;
                  const proxiedHref = toProxyURL(originalHref);
                  if (originalHref !== proxiedHref) {
                    node.href = proxiedHref;
                  }
                }
              });
            });
          });

          observer.observe(document.documentElement, {
            childList: true,
            subtree: true
          });
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

// YouTube embed handler
function handleYouTube(targetUrl, res) {
  try {
    const urlObj = new URL(targetUrl);
    let videoId = null;

    // Extract video ID from various YouTube URL formats
    if (urlObj.hostname.includes('youtube.com')) {
      if (urlObj.pathname === '/watch') {
        videoId = urlObj.searchParams.get('v');
      } else if (urlObj.pathname.startsWith('/embed/')) {
        videoId = urlObj.pathname.split('/embed/')[1].split('?')[0];
      } else if (urlObj.pathname.startsWith('/v/')) {
        videoId = urlObj.pathname.split('/v/')[1].split('?')[0];
      }

      // Handle search queries
      if (urlObj.pathname === '/results' || urlObj.pathname.startsWith('/search')) {
        const searchQuery = urlObj.searchParams.get('search_query') || urlObj.searchParams.get('q');
        if (searchQuery) {
          return res.send(createYouTubeSearchPage(searchQuery));
        }
      }
    } else if (urlObj.hostname === 'youtu.be') {
      videoId = urlObj.pathname.substring(1).split('?')[0];
    }

    if (videoId) {
      return res.send(createYouTubeEmbedPage(videoId, targetUrl));
    }

    // If no video ID found, show YouTube home with search
    return res.send(createYouTubeHomePage());
  } catch (e) {
    console.error('YouTube handler error:', e.message);
    return null;
  }
}

function createYouTubeEmbedPage(videoId, originalUrl) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>YouTube Video Player</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { background: #0f0f0f; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
        .container { max-width: 1280px; margin: 0 auto; padding: 20px; }
        .video-wrapper { position: relative; width: 100%; padding-bottom: 56.25%; background: #000; border-radius: 12px; overflow: hidden; }
        .video-wrapper iframe { position: absolute; top: 0; left: 0; width: 100%; height: 100%; border: none; }
        .info { background: #272727; padding: 16px; margin-top: 12px; border-radius: 12px; color: #fff; }
        .info h1 { font-size: 20px; margin-bottom: 8px; }
        .info a { color: #3ea6ff; text-decoration: none; }
        .info a:hover { text-decoration: underline; }
        .search-bar { background: #272727; padding: 12px; margin-bottom: 20px; border-radius: 12px; display: flex; gap: 12px; }
        .search-bar input { flex: 1; padding: 10px 16px; border: 1px solid #303030; background: #121212; color: #fff; border-radius: 24px; outline: none; font-size: 16px; }
        .search-bar input:focus { border-color: #3ea6ff; }
        .search-bar button { padding: 10px 24px; background: #3ea6ff; color: #fff; border: none; border-radius: 24px; cursor: pointer; font-weight: 500; }
        .search-bar button:hover { background: #2e95e8; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="search-bar">
          <input type="text" id="searchInput" placeholder="Search YouTube..." onkeypress="if(event.key==='Enter') searchYouTube()">
          <button onclick="searchYouTube()">Search</button>
        </div>
        <div class="video-wrapper">
          <iframe
            src="https://www.youtube.com/embed/${videoId}?autoplay=1&rel=0"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowfullscreen>
          </iframe>
        </div>
        <div class="info">
          <h1>YouTube Video Player</h1>
          <p>Video ID: ${videoId}</p>
          <p><a href="${originalUrl}" target="_blank">Open on YouTube</a></p>
        </div>
      </div>
      <script>
        function searchYouTube() {
          const query = document.getElementById('searchInput').value.trim();
          if (query) {
            window.location.href = '/proxy?url=https://www.youtube.com/results?search_query=' + encodeURIComponent(query);
          }
        }
      </script>
    </body>
    </html>
  `;
}

function createYouTubeSearchPage(query) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>YouTube Search: ${query}</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { background: #0f0f0f; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #fff; }
        .container { max-width: 1280px; margin: 0 auto; padding: 20px; }
        .search-bar { background: #272727; padding: 12px; margin-bottom: 20px; border-radius: 12px; display: flex; gap: 12px; }
        .search-bar input { flex: 1; padding: 10px 16px; border: 1px solid #303030; background: #121212; color: #fff; border-radius: 24px; outline: none; font-size: 16px; }
        .search-bar input:focus { border-color: #3ea6ff; }
        .search-bar button { padding: 10px 24px; background: #3ea6ff; color: #fff; border: none; border-radius: 24px; cursor: pointer; font-weight: 500; }
        .search-bar button:hover { background: #2e95e8; }
        .message { text-align: center; padding: 40px; background: #272727; border-radius: 12px; }
        .message h2 { margin-bottom: 16px; }
        .message p { color: #aaa; margin-bottom: 24px; }
        .message a { display: inline-block; padding: 12px 24px; background: #3ea6ff; color: #fff; text-decoration: none; border-radius: 24px; }
        .message a:hover { background: #2e95e8; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="search-bar">
          <input type="text" id="searchInput" placeholder="Search YouTube..." value="${query}" onkeypress="if(event.key==='Enter') searchYouTube()">
          <button onclick="searchYouTube()">Search</button>
        </div>
        <div class="message">
          <h2>Search Results for: "${query}"</h2>
          <p>To watch a video, paste a YouTube video URL in the search bar above</p>
          <p style="margin-top: 16px; color: #888; font-size: 14px;">Supported formats:</p>
          <p style="color: #888; font-size: 14px;">
            • https://youtube.com/watch?v=VIDEO_ID<br>
            • https://youtu.be/VIDEO_ID<br>
            • https://youtube.com/embed/VIDEO_ID
          </p>
          <a href="https://youtube.com/results?search_query=${encodeURIComponent(query)}" target="_blank">Search on YouTube.com</a>
        </div>
      </div>
      <script>
        function searchYouTube() {
          const query = document.getElementById('searchInput').value.trim();
          if (query) {
            // Check if it's a YouTube URL
            if (query.includes('youtube.com') || query.includes('youtu.be')) {
              window.location.href = '/proxy?url=' + encodeURIComponent(query);
            } else {
              window.location.href = '/proxy?url=https://www.youtube.com/results?search_query=' + encodeURIComponent(query);
            }
          }
        }
      </script>
    </body>
    </html>
  `;
}

function createYouTubeHomePage() {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>YouTube Player</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { background: #0f0f0f; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #fff; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
        .container { max-width: 600px; padding: 40px; text-align: center; }
        .logo { font-size: 48px; font-weight: 700; margin-bottom: 32px; background: linear-gradient(45deg, #ff0000, #cc0000); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .search-bar { background: #272727; padding: 12px; margin-bottom: 20px; border-radius: 12px; display: flex; gap: 12px; }
        .search-bar input { flex: 1; padding: 12px 20px; border: 1px solid #303030; background: #121212; color: #fff; border-radius: 24px; outline: none; font-size: 16px; }
        .search-bar input:focus { border-color: #3ea6ff; }
        .search-bar button { padding: 12px 28px; background: #3ea6ff; color: #fff; border: none; border-radius: 24px; cursor: pointer; font-weight: 500; font-size: 16px; }
        .search-bar button:hover { background: #2e95e8; }
        .info { color: #aaa; font-size: 14px; line-height: 1.6; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="logo">YouTube</div>
        <div class="search-bar">
          <input type="text" id="searchInput" placeholder="Paste YouTube video URL or search..." onkeypress="if(event.key==='Enter') handleSearch()">
          <button onclick="handleSearch()">Go</button>
        </div>
        <div class="info">
          <p>Paste a YouTube video URL or enter a search term</p>
          <p style="margin-top: 12px;">Supported formats:</p>
          <p>
            • https://youtube.com/watch?v=VIDEO_ID<br>
            • https://youtu.be/VIDEO_ID<br>
            • Or just search for videos
          </p>
        </div>
      </div>
      <script>
        function handleSearch() {
          const input = document.getElementById('searchInput').value.trim();
          if (input) {
            // Check if it's a YouTube URL
            if (input.includes('youtube.com') || input.includes('youtu.be')) {
              window.location.href = '/proxy?url=' + encodeURIComponent(input);
            } else {
              window.location.href = '/proxy?url=https://www.youtube.com/results?search_query=' + encodeURIComponent(input);
            }
          }
        }
      </script>
    </body>
    </html>
  `;
}

// Main proxy endpoint - handles both query-based (?url=) and path-based (/protocol/host/path)
app.all('/proxy*', (req, res, next) => {
  let targetUrl = null;

  // Extract path after /proxy
  const fullPath = req.path; // e.g., '/proxy/https/example.com/page' or '/proxy'

  // Try to match path-based format: /proxy/https/example.com/path
  const pathMatch = fullPath.match(/^\/proxy\/(https?)\/([\w.-]+(?:\:\d+)?)(.*)$/);

  if (pathMatch) {
    const [, protocol, host, path] = pathMatch;
    const queryString = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
    targetUrl = `${protocol}://${host}${path || '/'}${queryString}`;
  }
  // Fall back to query-based format: /proxy?url=https://example.com
  else if (req.query.url) {
    targetUrl = req.query.url;
    try {
      targetUrl = decodeURIComponent(targetUrl);
    } catch (e) {}
  }

  // If this is just /proxy with no params, return error
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

  // Check if this is a YouTube URL and handle it specially
  if (targetUrl.includes('youtube.com') || targetUrl.includes('youtu.be')) {
    const youtubeResponse = handleYouTube(targetUrl, res);
    if (youtubeResponse !== null) {
      return; // Response already sent
    }
  }

  console.log(`[${req.method}] Proxying: ${targetUrl}`);

  const proxyBase = getProxyBase(req);

  // Parse target URL to get origin
  const targetUrlObj = new URL(targetUrl);

  // Request options
  const options = {
    url: targetUrl,
    method: req.method,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': req.headers.accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Referer': `${targetUrlObj.protocol}//${targetUrlObj.host}/`,
      'Origin': `${targetUrlObj.protocol}//${targetUrlObj.host}`,
      'DNT': '1',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': req.headers['sec-fetch-dest'] || 'document',
      'Sec-Fetch-Mode': req.headers['sec-fetch-mode'] || 'navigate',
      'Sec-Fetch-Site': req.headers['sec-fetch-site'] || 'none',
      'Sec-Fetch-User': '?1',
      'Cache-Control': 'max-age=0'
    },
    encoding: null, // Get response as Buffer
    followRedirect: true,
    maxRedirects: 5,
    timeout: 30000,
    gzip: true,
    jar: true // Enable cookie jar for session management
  };

  // Forward cookies if present
  if (req.headers.cookie) {
    options.headers['Cookie'] = req.headers.cookie;
  }

  // Forward authorization headers (for social media APIs)
  if (req.headers.authorization) {
    options.headers['Authorization'] = req.headers.authorization;
  }

  // Forward POST/PUT data
  if (req.method === 'POST' || req.method === 'PUT') {
    const contentType = req.headers['content-type'] || '';

    if (contentType.includes('application/json')) {
      options.json = req.body;
      options.headers['Content-Type'] = 'application/json';
    } else if (contentType.includes('application/x-www-form-urlencoded')) {
      options.form = req.body;
      options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (contentType.includes('multipart/form-data')) {
      options.formData = req.body;
      options.headers['Content-Type'] = contentType;
    } else if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) {
      options.body = req.body;
      if (contentType) {
        options.headers['Content-Type'] = contentType;
      }
    } else {
      // Default: use form encoding for objects
      options.form = req.body;
    }
  }

  // Make the request
  proxyRequest(options, res, targetUrl, proxyBase);
});

// Catch-all route - handles dynamic JS requests (fetch, XHR, forms) by extracting origin from referer
app.all('*', (req, res) => {
  // Try to extract origin from referer for JavaScript-generated requests
  const referer = req.headers.referer || req.headers.referrer;

  console.log(`[CATCHALL] ${req.method} ${req.path} - Referer: ${referer || 'none'}`);

  if (referer) {
    try {
      const refererUrl = new URL(referer);

      // Check if referer is a proxied URL in path format: /proxy/https/example.com/...
      const pathMatch = refererUrl.pathname.match(/^\/proxy\/(https?)\/([\w.-]+(?:\:\d+)?)(\/.*)?$/);

      if (pathMatch) {
        const [, protocol, host] = pathMatch;
        const targetUrl = `${protocol}://${host}${req.path}${req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : ''}`;

        console.log(`[CATCHALL ${req.method}] Reconstructed from path: ${targetUrl}`);

        const proxyBase = getProxyBase(req);
        const options = {
          url: targetUrl,
          method: req.method,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': req.headers.accept || '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate',
            'Referer': `${protocol}://${host}`,
            'Origin': `${protocol}://${host}`
          },
          encoding: null,
          followRedirect: true,
          maxRedirects: 5,
          timeout: 30000,
          gzip: true
        };

        if (req.method === 'POST' || req.method === 'PUT') {
          const contentType = req.headers['content-type'] || '';

          if (contentType.includes('application/json')) {
            options.json = req.body;
            options.headers['Content-Type'] = 'application/json';
          } else if (contentType.includes('application/x-www-form-urlencoded')) {
            options.form = req.body;
            options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
          } else if (contentType.includes('multipart/form-data')) {
            options.formData = req.body;
            options.headers['Content-Type'] = contentType;
          } else if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) {
            options.body = req.body;
            if (contentType) {
              options.headers['Content-Type'] = contentType;
            }
          } else {
            options.form = req.body;
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

          console.log(`[CATCHALL ${req.method}] Reconstructed from query: ${targetUrl}`);

          const proxyBase = getProxyBase(req);
          const options = {
            url: targetUrl,
            method: req.method,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Accept': req.headers.accept || '*/*',
              'Accept-Language': 'en-US,en;q=0.9',
              'Accept-Encoding': 'gzip, deflate',
              'Referer': `${baseUrl.protocol}//${baseUrl.host}`,
              'Origin': `${baseUrl.protocol}//${baseUrl.host}`
            },
            encoding: null,
            followRedirect: true,
            maxRedirects: 5,
            timeout: 30000,
            gzip: true
          };

          if (req.method === 'POST' || req.method === 'PUT') {
            const contentType = req.headers['content-type'] || '';

            if (contentType.includes('application/json')) {
              options.json = req.body;
              options.headers['Content-Type'] = 'application/json';
            } else if (contentType.includes('application/x-www-form-urlencoded')) {
              options.form = req.body;
              options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
            } else if (contentType.includes('multipart/form-data')) {
              options.formData = req.body;
              options.headers['Content-Type'] = contentType;
            } else if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) {
              options.body = req.body;
              if (contentType) {
                options.headers['Content-Type'] = contentType;
              }
            } else {
              options.form = req.body;
            }
          }

          return proxyRequest(options, res, targetUrl, proxyBase);
        } catch (e) {
          console.error('Query-based catchall error:', e.message);
        }
      }

      // If referer doesn't match our proxy patterns, log more details
      console.log(`[CATCHALL] Referer pathname: ${refererUrl.pathname}, search: ${refererUrl.search}`);
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

    // Forward Set-Cookie headers if present (for social media login/sessions)
    if (response.headers['set-cookie']) {
      res.set('Set-Cookie', response.headers['set-cookie']);
    }

    try {
      // Handle HTML
      if (contentType.includes('text/html')) {
        const html = decodeBuffer(body, contentType);
        const rewritten = rewriteHTML(html, targetUrl, proxyBase);
        return res.send(rewritten);
      }

      // Handle CSS
      if (contentType.includes('text/css')) {
        const css = decodeBuffer(body, contentType);
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
