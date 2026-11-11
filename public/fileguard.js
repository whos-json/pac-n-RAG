// A classic script on purpose: it still runs when the page is opened from disk (file://), where modules and the API are blocked.
(function () {
  if (location.protocol !== 'file:') return;
  var box = document.createElement('div');
  box.setAttribute('role', 'alert');
  box.style.cssText = 'position:fixed;inset:0;z-index:99;display:flex;align-items:center;justify-content:center;background:#07200f;color:#eafff1;font:16px/1.5 system-ui,sans-serif;padding:24px';
  box.innerHTML = '<div style="max-width:560px;border:1px solid #3aa062;border-radius:12px;padding:24px;background:#0a2a15">'
    + '<h1 style="margin:0 0 12px;font-size:22px;color:#f5a623">PAC&amp;RAG needs its server</h1>'
    + '<p style="margin:0 0 12px">This page was opened as a file, so the browser blocks the app. Start the server and use the web address instead:</p>'
    + '<ol style="margin:0 0 12px;padding-left:22px"><li>Double-click <b>start.bat</b> in the project folder (or run <code>node server.js</code>).</li>'
    + '<li>Open <a style="color:#3fc1f0" href="http://localhost:4747">http://localhost:4747</a></li></ol>'
    + '<p style="margin:0;color:#9fc7ad;font-size:14px">Needs Node 18 or newer. Nothing is sent anywhere: the server only listens on your own computer.</p></div>';
  document.addEventListener('DOMContentLoaded', function () { document.body.append(box); });
  if (document.readyState !== 'loading') document.body.append(box);
})();
