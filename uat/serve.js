// Serves uat/site on http://127.0.0.1:4848 so the link-ingest scenario has a page to fetch.
const http = require('http');
const fs = require('fs');
const path = require('path');
http.createServer((req, res) => {
  fs.readFile(path.join(__dirname, 'site', 'index.html'), (e, b) => {
    res.writeHead(e ? 404 : 200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(e ? 'not found' : b);
  });
}).listen(4848, '127.0.0.1', () => console.log('UAT site on http://127.0.0.1:4848'));
