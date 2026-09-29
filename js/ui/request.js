/* Credits footer and "Request a change" dialog (opens a prefilled email to the maintainers). */
(function () {
  const TC = window.TC;
  const C = TC.config;
  const $ = s => document.querySelector(s);
  const names = () => C.contacts.map(c => c.name).join(' and ');

  function body() {
    const lines = [
      `Request type: ${$('#req-type').value}`,
      `Summary: ${$('#req-summary').value.trim()}`,
      '',
      'Details:',
      $('#req-details').value.trim() || '(none)',
      '',
      `Source: ${$('#req-source').value.trim() || '(none)'}`,
      `Requested by: ${$('#req-name').value.trim() || '(not given)'}`,
      `Date: ${TC.today()}`,
    ];
    if ($('#req-scenario').checked && TC.currentWorkload) {
      const w = TC.currentWorkload();
      lines.push('', 'Workload inputs:');
      Object.keys(w).forEach(k => lines.push(`  ${k}: ${w[k]}`));
    }
    return lines.join('\n');
  }
  function subject() {
    const sum = $('#req-summary').value.trim();
    return `${C.requestSubjectPrefix} ${$('#req-type').value}${sum ? ': ' + sum : ''}`;
  }
  function msg(text) { const m = $('#req-msg'); m.textContent = text; m.hidden = !text; }

  TC.request = {
    init() {
      $('#copyright').textContent = C.copyright;
      $('#contact-names').textContent = names();
      $('#req-to-names').textContent = names();
      const dlg = $('#request-dialog');
      const open = () => { msg(''); dlg.showModal(); $('#req-summary').focus(); };
      $('#open-request').onclick = open;
      $('#open-request-2').onclick = open;
      $('#req-cancel').onclick = () => dlg.close();
      $('#req-send').onclick = () => {
        if (!$('#req-summary').value.trim()) { msg('Add a short summary first.'); $('#req-summary').focus(); return; }
        TC.track('change-request-' + $('#req-type').value.toLowerCase().replace(/[^a-z]+/g, '-'), 'Change request: ' + $('#req-type').value);
        const to = C.contacts.map(c => c.email).filter(Boolean).join(',');
        const href = `mailto:${to}?subject=${encodeURIComponent(subject())}&body=${encodeURIComponent(body())}`;
        window.location.href = href;
        msg(to
          ? 'Your email app should open with the request filled in — just press Send.'
          : `No email addresses are set in js/config.js yet. Add ${names()} as recipients before sending, or use Copy text.`);
      };
      $('#req-copy').onclick = async () => {
        const text = `Subject: ${subject()}\n\n${body()}`;
        try { await navigator.clipboard.writeText(text); msg(`Copied. Paste it into an email or Teams message to ${names()}.`); }
        catch (e) { msg('Copy failed — select the fields and copy manually.'); }
      };
    },
  };
})();
