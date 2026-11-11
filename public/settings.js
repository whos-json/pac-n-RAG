// AI model settings dialog. Self-contained: talks to /api/llm, never sees a saved key (only its last four characters).
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const H = { 'x-pacrag': '1', 'content-type': 'application/json' };
  let cfg = null;
  let opener = null;

  // Shared with app.js: the one-line summary shown under the title.
  window.pacLlmLabel = (st) => {
    const where = (st.llmModel ? ` (${st.llmModel})` : '');
    if (st.llmNote) return st.llmNote;
    if (st.llm === 'local') return 'No AI model connected: answers only quote your sources. Your documents stay on this machine.';
    if (st.llmRemote) return `Answers written by a cloud model${where}. Retrieved passages are sent to it.`;
    return `Answers written by your own model server${where}. Nothing leaves this machine.`;
  };

  // Updates the one-line summary and the banner that tells the user no model is connected.
  window.pacLlmApply = (st) => {
    const t = $('#llm'); if (t) t.textContent = window.pacLlmLabel(st);
    const b = $('#llm-banner'); if (b) b.hidden = st.llm !== 'local' || !!st.llmNote;
    const btn = $('#llm-btn'); if (btn) btn.textContent = st.llm === 'local' ? 'Connect AI model…' : 'AI model…';
  };

  async function call(url, opts) {
    let r;
    try { r = await fetch(url, Object.assign({}, opts, { headers: Object.assign({}, H, opts && opts.headers) })); }
    catch (e) { throw new Error('Cannot reach the server. Is it still running?'); }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
    return data;
  }

  const prov = () => cfg.providers.find((p) => p.id === $('#llm-provider').value);
  const body = () => {
    const id = $('#llm-provider').value;
    if (id === 'none') return { provider: 'none' };
    const b = { provider: id, baseUrl: $('#llm-url').value.trim(), model: $('#llm-model').value.trim() };
    const k = $('#llm-key').value.trim();
    if (k) b.apiKey = k;
    if ($('#llm-clear').checked) b.clearKey = true;
    return b;
  };
  const hostOf = (u) => { try { return new URL(u).hostname; } catch (e) { return u; } };
  const isLocal = (u) => /^(localhost|127(\.\d+){3}|\[?::1\]?)$/i.test(hostOf(u));

  function reflect() {
    const id = $('#llm-provider').value;
    const p = prov();
    const sel = $('#llm-provider');
    const on = id !== 'none';
    $('#llm-fields').hidden = !on;
    $('#llm-test').disabled = !on;
    $('#llm-result').textContent = '';
    if (!on) { $('#llm-privacy').textContent = 'Answers will quote your sources. Nothing is sent anywhere.'; return; }
    const same = cfg.provider === id;
    if (sel.dataset.last !== id) { // provider just changed: restore what was saved for it, or its defaults
      $('#llm-url').value = same && cfg.baseUrl ? cfg.baseUrl : p.baseUrl;
      $('#llm-model').value = same ? cfg.model || '' : '';
      $('#llm-key').value = '';
      sel.dataset.last = id;
    }
    $('#llm-model').placeholder = p.defaultModel || (p.needsModel ? 'e.g. gpt-4o-mini' : 'leave empty to use the one the server loaded');
    $('#llm-model-opt').textContent = p.needsModel && !p.defaultModel ? '(required)' : '(optional)';
    $('#llm-key-opt').textContent = p.needsKey ? '(required)' : '(only if your server needs one)';
    $('#llm-url-help').textContent = id === 'llamacpp'
      ? 'Start it with: llama-server -m your-model.gguf --port 8080. Ollama, LM Studio and vLLM also work here (use their address, e.g. http://127.0.0.1:11434).'
      : id === 'openai' ? 'OpenAI, OpenRouter, Groq, Together and other OpenAI-compatible services. Include the /v1 part if the service uses one.' : 'Normally https://api.anthropic.com.';
    const hasKey = same && cfg.hasKey;
    $('#llm-key').placeholder = hasKey ? `Saved key ${cfg.keyHint}; leave blank to keep it` : 'Paste your key';
    $('#llm-key-help').textContent = 'Stored in plain text in settings.json in your data folder, on this computer only. It is never shown again or sent anywhere except to the address above.';
    $('#llm-clear-wrap').hidden = !hasKey;
    if (!hasKey) $('#llm-clear').checked = false;
    const local = isLocal($('#llm-url').value);
    $('#llm-privacy').textContent = local
      ? 'This server is on your own machine: your documents stay here.'
      : `Each question sends the retrieved passages and your last few chat messages to ${hostOf($('#llm-url').value) || 'that server'}. Your full library is never sent.`;
    if (id !== 'llamacpp' && !local) $('#llm-key-help').textContent += ' If you change the address you must paste the key again.';
  }

  async function open() {
    opener = document.activeElement;
    try { cfg = await call('/api/llm'); } catch (e) { alert(e.message); return; }
    const sel = $('#llm-provider');
    sel.replaceChildren(...[{ id: 'none', label: 'None: quote my sources (local only)' }, ...cfg.providers].map((p) => { const o = document.createElement('option'); o.value = p.id; o.textContent = p.label; return o; }));
    sel.value = cfg.provider;
    $('#llm-url').value = cfg.provider === 'none' ? '' : cfg.baseUrl;
    $('#llm-model').value = cfg.model || '';
    sel.dataset.last = cfg.provider;
    $('#llm-key').value = '';
    $('#llm-clear').checked = false;
    reflect();
    if (cfg.localOnly) $('#llm-result').textContent = 'PACRAG_LOCAL_ONLY is set, so a saved model will not be used until it is removed.';
    $('#llm-dlg').showModal();
    sel.focus();
  }

  // aria-disabled, not disabled: a disabled button drops keyboard focus to the body. reflect() still disables Test for 'none'. The handlers below ignore presses while busy.
  function busy(on) { for (const id of ['#llm-save', '#llm-test']) $(id).setAttribute('aria-disabled', String(on)); }
  const isBusy = (id) => $(id).getAttribute('aria-disabled') === 'true';

  $('#llm-btn').addEventListener('click', open);
  $('#llm-banner-btn').addEventListener('click', open);
  $('#llm-provider').addEventListener('change', reflect);
  $('#llm-url').addEventListener('change', () => { const local = isLocal($('#llm-url').value); $('#llm-privacy').textContent = local ? 'This server is on your own machine: your documents stay here.' : `Each question sends the retrieved passages and your last few chat messages to ${hostOf($('#llm-url').value) || 'that server'}. Your full library is never sent.`; });
  $('#llm-cancel').addEventListener('click', () => $('#llm-dlg').close());
  $('#llm-dlg').addEventListener('close', () => { $('#llm-key').value = ''; $('#llm-result').textContent = ''; busy(false); if (opener && opener.isConnected) opener.focus(); });

  $('#llm-test').addEventListener('click', async () => {
    if (isBusy('#llm-test')) return;
    const out = $('#llm-result');
    out.textContent = 'Testing…'; busy(true);
    try {
      const r = await call('/api/llm/test', { method: 'POST', body: JSON.stringify(body()), signal: AbortSignal.timeout(40000) });
      out.textContent = r.ok ? `Connected. The model answered in ${r.ms} ms.` : `Could not use it: ${r.error}`;
    } catch (e) { out.textContent = `Could not test: ${e.message}`; }
    busy(false);
  });

  $('#llm-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (isBusy('#llm-save')) return; // Enter in a field submits even when Save is aria-disabled
    const out = $('#llm-result');
    out.textContent = 'Saving…'; busy(true);
    try {
      cfg = await call('/api/llm', { method: 'PUT', body: JSON.stringify(body()) });
      const st = await call('/api/status').catch(() => null);
      if (st) window.pacLlmApply(st);
      $('#llm-dlg').close();
      const s = $('#status'); if (s) s.textContent = cfg.provider === 'none' ? 'AI model removed. Answers quote your sources.' : 'AI model saved.';
    } catch (e) { out.textContent = e.message; busy(false); return; }
    busy(false);
  });
})();
