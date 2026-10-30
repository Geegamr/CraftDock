const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const root = path.join(projectRoot, 'src');
const assetRoot = path.join(projectRoot, 'assets');
const port = 4173;
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

http.createServer((request, response) => {
  const requestPath = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const servingAssets = requestPath.startsWith('/assets/');
  const contentRoot = servingAssets ? assetRoot : root;
  const relativePath = requestPath === '/' ? 'index.html' : servingAssets
    ? requestPath.slice('/assets/'.length)
    : requestPath.slice(1);
  const filePath = path.resolve(contentRoot, relativePath);
  if (filePath !== contentRoot && !filePath.startsWith(`${contentRoot}${path.sep}`)) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(filePath, (error, contents) => {
    if (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500).end('Not found');
      return;
    }
    response.writeHead(200, {
      'Content-Type': contentTypes[path.extname(filePath)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(contents);
  });
}).listen(port, '127.0.0.1', () => {
  console.log(`CraftDock Tauri renderer at http://localhost:${port}`);
});
