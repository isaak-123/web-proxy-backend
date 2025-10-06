const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const url = require('url');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Store the base URL for current session
let currentBaseUrl = '';

function rewriteUrl(originalUrl, baseUrl) {
  if (!originalUrl) return originalUrl;
  
  try {
    // If it's already a full URL
    if (originalUrl.startsWith('http://') || originalUrl.startsWith('https://')) {
      return `/proxy?url=${encodeURIComponent(originalUrl)}`;
    }
    
    // If it's a protocol-relative URL
    if (originalUrl.startsWith('//')) {
      return `/proxy?url=${encodeURIComponent('https:' + originalUrl)}`;
    }
    
    // If it's a relative URL
    if (originalUrl.startsWith('/')) {
      const base = new URL(baseUrl);
      return `/proxy?url=${encodeURIComponent(base.origin + originalUrl)}`;
    }
    
    // If it's a relative path without leading slash
    const base = new URL(baseUrl);
    const resolved = new URL(originalUrl, base.href);
    return `/proxy?url=${encodeURIComponent(resolved.href)}`;
  } catch (e) {
    return originalUrl;
  }
}

function rewriteHtml(html, baseUrl) {
  const $ = cheerio.load(html);
  
  // Rewrite links
  $('a').each((i, elem) => {
    const href = $(elem).attr('href');
    if (href) {
      $(elem).attr('href', rewriteUrl(href, baseUrl));
    }
  });
  
  // Rewrite images
  $('img').each((i, elem) => {
    const src = $(elem).attr('src');
    if (src) {
      $(elem).attr('src', rewriteUrl(src, baseUrl));
    }
    const srcset = $(elem).attr('srcset');
    if (srcset) {
      const rewritten = srcset.split(',').map(s => {
        const parts = s.trim().split(' ');
        parts[0] = rewriteUrl(parts[0], baseUrl);
        return parts.join(' ');
      }).join(', ');
      $(elem).attr('srcset', rewritten);
    }
  });
  
  // Rewrite scripts
  $('script').each((i, elem) => {
    const src = $(elem).attr('src');
    if (src) {
      $(elem).attr('src', rewriteUrl(src, baseUrl));
    }
  });
  
  // Rewrite stylesheets
  $('link[rel="stylesheet"]').each((i, elem) => {
    const href = $(elem).attr('href');
    if (href) {
      $(elem).attr('href', rewriteUrl(href, baseUrl));
    }
  });
  
  // Rewrite forms
  $('form').each((i, elem) => {
    const action = $(elem).attr('action');
    if (action) {
      $(elem).attr('action', rewriteUrl(action, baseUrl));
    }
  });
  
  // Inject base tag to help with relative URLs
  if ($('base').length === 0) {
    $('head').prepend(`<base href="${baseUrl}">`);
  }
  
  return $.html();
}

function rewriteCss(css, baseUrl) {
  // Rewrite url() in CSS
  return css.replace(/url\(['"]?([^'")]+)['"]?\)/g, (match, urlPath) => {
    const rewritten = rewriteUrl(urlPath, baseUrl);
    return `url(${rewritten})`;
  });
}

app.get('/proxy', async (req, res) => {
  try {
    const targetUrl = req.query.url;
    
    if (!targetUrl) {
      return res.status(400).send('URL parameter is required');
    }
    
    console.log('Proxying:', targetUrl);
    
    const response = await axios.get(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      maxRedirects: 5,
      validateStatus: () => true,
    });
    
    const contentType = response.headers['content-type'] || '';
    
    // Set CORS headers
    res.set('Access-Control-Allow-Origin', '*');
    
    // Handle HTML
    if (contentType.includes('text/html')) {
      const rewrittenHtml = rewriteHtml(response.data, targetUrl);
      res.set('Content-Type', 'text/html');
      return res.send(rewrittenHtml);
    }
    
    // Handle CSS
    if (contentType.includes('text/css')) {
      const rewrittenCss = rewriteCss(response.data, targetUrl);
      res.set('Content-Type', 'text/css');
      return res.send(rewrittenCss);
    }
    
    // Handle JavaScript - pass through as-is
    if (contentType.includes('javascript') || contentType.includes('json')) {
      res.set('Content-Type', contentType);
      return res.send(response.data);
    }
    
    // Handle images and other binary content
    if (contentType.includes('image') || contentType.includes('octet-stream')) {
      res.set('Content-Type', contentType);
      return res.send(response.data);
    }
    
    // Default: send as-is
    res.set('Content-Type', contentType);
    res.send(response.data);
    
  } catch (error) {
    console.error('Proxy error:', error.message);
    res.status(500).send(`Proxy error: ${error.message}`);
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Proxy server is running' });
});

app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
});
