/* Credits footer and the "Request a change" links (both open the Microsoft Form in js/config.js). */
(function () {
  const TC = window.TC;
  const C = TC.config;
  const $ = s => document.querySelector(s);

  TC.request = {
    init() {
      $('#copyright').textContent = C.copyright;
      ['#open-request', '#open-request-2'].forEach(sel => {
        const a = $(sel);
        if (!a) return;
        a.href = C.requestFormUrl;
        a.addEventListener('click', () => TC.track('change-request', 'Opened change request form'));
      });
    },
  };
})();
